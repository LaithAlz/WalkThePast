/**
 * Owns the Three.js + Spark render loop.
 *
 * Deliberately a plain class rather than react-three-fiber: the provenance pass
 * writes custom shader work against Spark's `dyno` graph, which is far easier
 * against Spark's imperative API, and it keeps React out of the per-frame path.
 * React owns mount/unmount and the surrounding UI; this owns everything inside
 * the frame.
 */
import * as THREE from "three";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import { FirstPersonControls, isTyping } from "./controls";
import { WalkingMotor } from "./walking";
import { loadCollider } from "./collider";
import type { Octree } from "three/addons/math/Octree.js";
import { EvidenceLayer } from "./evidence";
import { CLASS_NAMES, classifyPoint, computeProvenance, makeSourceCamera, type ProvenanceResult } from "./provenance";
import { loadManifest, type CameraPose, type Convention, type WorldManifest } from "./world";

export type ViewerStatus =
  | { kind: "idle" }
  | { kind: "loading"; message: string }
  | { kind: "ready"; splats: number }
  | { kind: "error"; message: string };

/** Share of splats per class, as percentages: [unsupported, occluded, visible]. */
export type EvidenceCounts = [number, number, number];

export type Verdict = { label: string; reason: string; cls: 0 | 1 | 2 };
export type NavigationStatus = { mode: "loading" | "walking" | "ground-only" | "unavailable" | "fly"; message: string };

export type ViewerCallbacks = {
  onStatus?: (status: ViewerStatus) => void;
  onFps?: (fps: number) => void;
  onCounts?: (counts: EvidenceCounts) => void;
  onVerdict?: (verdict: Verdict | null) => void;
  onNavigation?: (status: NavigationStatus) => void;
  onPauseRequest?: () => void;
  onResumeRequest?: () => void;
};

/** OpenCV camera (+z forward, +y down) -> three.js camera (-z forward, +y up). */
const Q_CV_TO_GL = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);

export class Viewer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly spark: SparkRenderer;
  private readonly controls: FirstPersonControls;
  private readonly canvas: HTMLCanvasElement;
  private readonly cb: ViewerCallbacks;

  /**
   * worldRoot     convention transform (OpenCV -> three.js is a 180 deg turn about X)
   *   metricGroup Marble metric scale + ground-plane offset
   *     splatMesh
   *     photographer  empty at the splat origin = where the source camera sat
   */
  private readonly worldRoot = new THREE.Group();
  private readonly metricGroup = new THREE.Group();
  private readonly photographer = new THREE.Object3D();

  private readonly evidence = new EvidenceLayer();
  private readonly raycaster = new THREE.Raycaster();
  private readonly photographerPos = new THREE.Vector3();

  private manifest: WorldManifest | null = null;
  private splatMesh: SplatMesh | null = null;
  /** Untinted, LoD-free twin used only while evidence mode is on. See mountEvidenceSplat. */
  private evidenceMesh: SplatMesh | null = null;
  private sourceImage: HTMLImageElement | null = null;
  private sourceAspect: number | null = null;
  private provenance: ProvenanceResult | null = null;
  private panoTex: THREE.Texture | null = null;
  private walking: WalkingMotor | null = null;
  private collisionTree: Octree | null = null;
  private colliderAbort: AbortController | null = null;
  private loadToken = 0;

  private frameHandle = 0;
  private disposed = false;
  private lastT = 0;
  private frames = 0;
  private fpsWindowStart = 0;
  private lastInspect = 0;
  /** Frames to wait after attaching the evidence tint before recompiling it — see EvidenceLayer.refresh. */
  private regenIn = 0;
  private onKeyDown: (e: KeyboardEvent) => void;

  constructor(canvas: HTMLCanvasElement, callbacks: ViewerCallbacks = {}) {
    this.canvas = canvas;
    this.cb = callbacks;

    // antialias must stay false: MSAA does nothing for Gaussian splats and costs
    // a large amount of fill rate. This is Spark's documented setting.
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.scene.background = new THREE.Color(0x0b0b0e);
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.05, 1000);
    this.scene.add(this.camera);

    this.spark = new SparkRenderer({ renderer: this.renderer, lodSplatCount: 6_000_000 });
    this.scene.add(this.spark);

    this.worldRoot.add(this.metricGroup);
    this.metricGroup.add(this.photographer);
    this.scene.add(this.worldRoot, this.evidence.frustum);

    this.controls = new FirstPersonControls(canvas, this.camera);
    this.controls.enabled = false;
    this.controls.onPadButton = (index) => { if (index === 3) this.resetToPhotographer(); };
    this.controls.onPauseRequest = () => this.cb.onPauseRequest?.();
    this.controls.onResumeRequest = () => this.cb.onResumeRequest?.();

    this.onKeyDown = (e) => {
      if (isTyping(e) || e.repeat) return;
      if (e.code === "KeyR") this.resetToPhotographer();
      if (import.meta.env.DEV && e.altKey && e.code === "KeyF") {
        e.preventDefault();
        this.toggleDevelopmentFly();
      }
    };
    document.addEventListener("keydown", this.onKeyDown);

    this.resize();
    this.cb.onStatus?.({ kind: "idle" });
    if (import.meta.env.DEV) (window as unknown as { wtp?: Viewer }).wtp = this;
  }

  start() {
    if (this.frameHandle || this.disposed) return;
    this.lastT = performance.now();
    this.fpsWindowStart = this.lastT;
    const tick = () => {
      this.frameHandle = requestAnimationFrame(tick);
      const now = performance.now();
      const dt = Math.min(0.1, (now - this.lastT) / 1000);
      this.lastT = now;

      this.controls.update(dt);
      // Counted in drawn frames, not milliseconds: it has to land after Spark has actually
      // finished rebuilding the mesh, and frames are the thing that tracks that work.
      if (this.regenIn > 0 && --this.regenIn === 0) this.evidence.refresh();

      if (this.provenance) {
        // exploration mode: unsupported regions shift as the viewer leaves observed space
        const d = this.camera.position.distanceTo(this.photographerPos);
        // Ramps in well after the first step and never saturates inside the walk radius,
        // so the boundary is a gradual tell rather than a wall you cross.
        this.evidence.setShift(THREE.MathUtils.smoothstep(d, 1.0, 5.0));
        this.inspect(now);
      }

      this.renderer.render(this.scene, this.camera);
      this.sampleFps(now);
    };
    this.frameHandle = requestAnimationFrame(tick);
  }

  stop() {
    cancelAnimationFrame(this.frameHandle);
    this.frameHandle = 0;
  }

  resize() {
    const width = this.canvas.clientWidth || 1;
    const height = this.canvas.clientHeight || 1;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this.disposed = true;
    this.stop();
    document.removeEventListener("keydown", this.onKeyDown);
    this.controls.dispose();
    this.colliderAbort?.abort();
    this.collisionTree?.clear();
    this.evidence.detach();
    this.clearEvidenceSplat();
    this.clearSplat();
    this.clearPano();
    this.renderer.dispose();
  }

  /** Load a world by manifest id (public/worlds/<id>/world.json). */
  async load(id: string) {
    const token = ++this.loadToken;
    this.colliderAbort?.abort();
    this.colliderAbort = new AbortController();
    this.controls.enabled = false;
    this.controls.setMotor(null);
    this.walking = null;
    this.collisionTree?.clear();
    this.collisionTree = null;
    this.cb.onNavigation?.({ mode: "loading", message: "Preparing walking…" });
    this.provenance = null;
    this.evidence.detach();
    this.clearEvidenceSplat();
    this.evidence.setMode(false);
    this.cb.onCounts?.([0, 0, 0]);
    this.cb.onVerdict?.(null);
    this.cb.onStatus?.({ kind: "loading", message: "reading manifest" });

    let manifest: WorldManifest;
    try {
      manifest = await loadManifest(id);
    } catch (error) {
      if (token === this.loadToken) this.cb.onStatus?.({ kind: "error", message: String(error) });
      return;
    }
    if (token !== this.loadToken || this.disposed) return;
    this.manifest = manifest;

    const scale = manifest.metric?.scaleFactor ?? 1;
    const ground = manifest.metric?.groundPlaneOffset ?? 0;
    this.metricGroup.scale.setScalar(scale);
    // raw frame: the ground offset applies along raw y, before the axis flip
    this.metricGroup.position.set(0, -ground, 0);
    this.photographer.position.set(0, 0, 0);
    this.photographer.quaternion.identity();
    this.setConvention(manifest.splat.convention ?? "opencv");

    await this.loadSourceImage(manifest);
    if (token !== this.loadToken || this.disposed) return;

    if (manifest.pano?.url) {
      this.loadPano(manifest.pano.url, manifest.pano.yawDeg ?? 90).catch((e) => console.warn("pano failed", e));
    } else {
      this.clearPano();
    }

    // Sit at the photographer while the splat streams in, so the first frame
    // after load is already the historical viewpoint.
    this.applyPose(this.photographerPose());
    this.photographerPos.copy(this.camera.position);

    // The render mesh keeps its LoD tree, so walking around is full quality.
    const wantsProvenance = this.provenanceEnabled(manifest);
    try {
      await this.mountSplat(manifest.splat.url, manifest.splat.lod ?? true, token);
    } catch (error) {
      if (token === this.loadToken) this.cb.onStatus?.({ kind: "error", message: `splat load failed: ${String(error)}` });
      return;
    }
    if (token !== this.loadToken || this.disposed) return;

    // Classification indexes splats by file order, and a LoD tree reorders them and
    // varies how many are live with the view, so the tinted mesh has to forgo LoD.
    // Rather than pay that cost the whole time, it is a second, smaller mesh that
    // only becomes visible in evidence mode.
    if (wantsProvenance) {
      try {
        await this.mountEvidenceSplat(manifest.provenance?.splatUrl ?? manifest.splat.url, token);
      } catch (error) {
        console.warn("evidence splat failed; evidence mode unavailable", error);
      }
      if (token !== this.loadToken || this.disposed) return;
    }

    await this.prepareWalking(manifest, token, this.colliderAbort.signal);
    if (token !== this.loadToken || this.disposed) return;
    if (wantsProvenance) {
      this.cb.onStatus?.({ kind: "loading", message: "classifying evidence" });
      await new Promise((r) => setTimeout(r, 30)); // let the UI repaint before a long sync pass
      if (token !== this.loadToken || this.disposed) return;
      this.runProvenance();
    }
    this.cb.onStatus?.({ kind: "ready", splats: this.splatMesh ? splatCount(this.splatMesh) : 0 });
  }

  setEvidenceMode(on: boolean) {
    const active = on && !!this.provenance && !!this.evidenceMesh;
    // Swap which twin is drawn. Only one is ever visible, so this costs fill rate
    // for neither; the price is GPU memory for both and a coarser evidence view.
    if (this.evidenceMesh) this.evidenceMesh.visible = active;
    if (this.splatMesh) this.splatMesh.visible = !active;
    this.evidence.setMode(on && !!this.provenance);
  }

  /** Reset to a safe standing position near the source view, without flying through walls. */
  resetToPhotographer() {
    if (!this.manifest) return;
    const pose = this.photographerPose();
    this.photographerPos.fromArray(pose.position);
    this.applyPose(pose);
    this.controls.clearInput();
    this.controls.flyMode = false;
    if (this.walking?.ready) {
      this.walking.reset();
      this.camera.position.copy(this.walking.eye);
      this.controls.enabled = true;
      this.reportWalking();
    }
  }

  setTouchMove(x: number, z: number) { this.controls.setTouchMove(x, z); }

  setPaused(paused: boolean) { this.controls.setPaused(paused); }

  setLookSensitivity(value: number) { this.controls.setSensitivity(value); }


  private reportWalking() {
    this.cb.onNavigation?.(this.walking?.hasCollider
      ? { mode: "walking", message: "Walking · walls and ground enabled" }
      : { mode: "ground-only", message: "Level-ground preview · object collisions unavailable" });
  }

  private toggleDevelopmentFly() {
    if (!this.manifest || !this.walking?.ready) return;
    if (this.controls.flyMode) { this.resetToPhotographer(); return; }
    this.controls.clearInput();
    this.controls.flyMode = true;
    this.controls.enabled = true;
    this.cb.onNavigation?.({ mode: "fly", message: "Developer fly · Q/C height · Alt+F to return" });
  }

  private async prepareWalking(manifest: WorldManifest, token: number, signal: AbortSignal) {
    try {
      if (manifest.collider) {
        this.cb.onStatus?.({ kind: "loading", message: "preparing collision mesh" });
        this.metricGroup.updateWorldMatrix(true, true);
        const tree = await loadCollider(manifest.collider, this.metricGroup.matrixWorld, signal);
        if (token !== this.loadToken || this.disposed) { tree.clear(); return; }
        this.collisionTree = tree;
      }
      const { spawn: spawnPosition, ...walkingOptions } = manifest.walking ?? {};
      const motor = new WalkingMotor(this.collisionTree, {
        radiusLimit: manifest.bounds?.radiusM ?? 0,
        ...walkingOptions,
      });
      const pose = this.photographerPose();
      const spawn = new THREE.Vector3().fromArray(spawnPosition ?? pose.position);
      if (!motor.spawn(spawn)) throw new Error("No safe starting position. A walking spawn needs to be configured.");
      this.walking = motor;
      this.controls.setMotor(motor);
      this.controls.enabled = true;
      this.reportWalking();
    } catch (error) {
      if (signal.aborted || token !== this.loadToken || this.disposed) return;
      // A broken declared collider must never silently become collision-free walking.
      this.controls.enabled = false;
      this.cb.onNavigation?.({ mode: "unavailable", message: `Walking unavailable: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  /** Current camera pose as JSON, to paste into a world.json `sourceCamera`. */
  cameraJson(): string {
    return JSON.stringify({ ...this.currentPose(), world: this.manifest?.id ?? "" }, null, 2);
  }

  /** Persist the current camera as this world's photographer pose, and reclassify. */
  savePose() {
    if (!this.manifest) return;
    localStorage.setItem(this.poseKey(), JSON.stringify(this.currentPose()));
    this.photographerPos.copy(this.camera.position);
    this.runProvenance();
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  private provenanceEnabled(m: WorldManifest): boolean {
    return !!m.source?.image && m.provenance?.enabled !== false;
  }

  private async loadSourceImage(m: WorldManifest) {
    this.sourceImage = null;
    this.sourceAspect = null;
    if (!m.source?.image) return;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = m.source.image;
    await new Promise<void>((resolve) => {
      img.onload = () => resolve();
      img.onerror = () => resolve();
    });
    if (!img.naturalWidth) return;
    this.sourceImage = img;
    this.sourceAspect = img.naturalWidth / img.naturalHeight;
  }

  private async mountSplat(url: string, lod: boolean, token: number) {
    this.clearSplat();
    const mesh = new SplatMesh({
      url,
      lod,
      onProgress: (ev) => {
        if (token !== this.loadToken) return;
        const message = ev.lengthComputable
          ? `downloading ${(ev.loaded / 1e6).toFixed(1)} / ${(ev.total / 1e6).toFixed(1)} MB`
          : `decoding ${(ev.loaded / 1e6).toFixed(1)} MB`;
        this.cb.onStatus?.({ kind: "loading", message });
      },
    });
    this.metricGroup.add(mesh);
    this.splatMesh = mesh;
    await mesh.initialized;
  }

  /** The tinted twin: no LoD, so classification indices stay stable, and hidden
   * until evidence mode asks for it. Point `provenance.splatUrl` at a low tier —
   * without LoD a full-resolution export will not hold a usable frame rate. */
  private async mountEvidenceSplat(url: string, token: number) {
    this.clearEvidenceSplat();
    this.cb.onStatus?.({ kind: "loading", message: "loading evidence detail" });
    const mesh = new SplatMesh({ url, lod: false });
    mesh.visible = false;
    this.metricGroup.add(mesh);
    this.evidenceMesh = mesh;
    await mesh.initialized;
    if (token !== this.loadToken || this.disposed) this.clearEvidenceSplat();
  }

  private clearEvidenceSplat() {
    if (!this.evidenceMesh) return;
    this.metricGroup.remove(this.evidenceMesh);
    this.evidenceMesh.dispose();
    this.evidenceMesh = null;
  }

  private clearSplat() {
    if (!this.splatMesh) return;
    this.metricGroup.remove(this.splatMesh);
    this.splatMesh.dispose();
    this.splatMesh = null;
  }

  private setConvention(c: Convention) {
    this.worldRoot.rotation.set(c === "opencv" ? Math.PI : 0, 0, 0);
  }

  private async loadPano(url: string, yawDeg: number) {
    this.clearPano();
    const tex = await new THREE.TextureLoader().loadAsync(url);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    this.panoTex = tex;
    this.scene.background = tex;
    this.scene.backgroundRotation.set(0, THREE.MathUtils.degToRad(yawDeg), 0);
  }

  private clearPano() {
    this.scene.background = new THREE.Color(0x0b0b0e);
    this.panoTex?.dispose();
    this.panoTex = null;
  }

  // -------------------------------------------------------------------------
  // Photographer pose
  // -------------------------------------------------------------------------

  private poseKey() {
    return `wtp:pose:${this.manifest?.id ?? "none"}`;
  }

  /** saved pose (localStorage) -> manifest sourceCamera -> splat origin. */
  private photographerPose(): CameraPose {
    const saved = localStorage.getItem(this.poseKey());
    if (saved) {
      try {
        return JSON.parse(saved) as CameraPose;
      } catch {
        localStorage.removeItem(this.poseKey());
      }
    }
    if (this.manifest?.sourceCamera) return this.manifest.sourceCamera;

    this.photographer.updateWorldMatrix(true, false);
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    this.photographer.getWorldPosition(p);
    this.photographer.getWorldQuaternion(q);
    q.multiply(Q_CV_TO_GL);
    return {
      position: [p.x, p.y, p.z],
      quaternion: [q.x, q.y, q.z, q.w],
      fovY: this.manifest?.source?.fovY ?? 60,
    };
  }

  private currentPose(): CameraPose {
    return {
      position: this.camera.position.toArray() as [number, number, number],
      quaternion: this.camera.quaternion.toArray() as [number, number, number, number],
      fovY: this.camera.fov,
    };
  }

  private applyPose(pose: CameraPose) {
    this.camera.position.fromArray(pose.position);
    this.camera.quaternion.fromArray(pose.quaternion);
    if (pose.fovY) {
      this.camera.fov = pose.fovY;
      this.camera.updateProjectionMatrix();
    }
    this.controls.syncFromCamera();
  }

  // -------------------------------------------------------------------------
  // Provenance
  // -------------------------------------------------------------------------

  /** Gather every Gaussian in world space and classify it against the photographer's camera. */
  private runProvenance() {
    // Classify and tint the LoD-free twin: its splat order is stable, which is
    // exactly what the per-splat class array and the tint shader index rely on.
    const mesh = this.evidenceMesh;
    if (!this.manifest || !mesh || !this.provenanceEnabled(this.manifest)) return;
    const t0 = performance.now();
    const pose = this.photographerPose();
    const aspect = this.sourceAspect ?? this.camera.aspect;
    const cam = makeSourceCamera(pose.position, pose.quaternion, pose.fovY ?? this.camera.fov, aspect);

    mesh.updateWorldMatrix(true, false);
    const m = mesh.matrixWorld;
    const worldScale = new THREE.Vector3().setFromMatrixScale(m).x;
    const n = splatCount(mesh);
    if (!n) return;
    const positions = new Float32Array(n * 3);
    const maxScales = new Float32Array(n);
    const opacities = new Float32Array(n);
    const p = new THREE.Vector3();
    let count = 0;
    mesh.forEachSplat((i, center, scales, _q, opacity) => {
      if (i >= n) return;
      p.copy(center).applyMatrix4(m);
      positions[i * 3] = p.x;
      positions[i * 3 + 1] = p.y;
      positions[i * 3 + 2] = p.z;
      maxScales[i] = Math.max(scales.x, scales.y, scales.z) * worldScale;
      opacities[i] = opacity;
      count++;
    });
    if (!count) return;

    const o = this.manifest.provenance ?? {};
    const res = computeProvenance(
      positions.subarray(0, count * 3),
      maxScales.subarray(0, count),
      opacities.subarray(0, count),
      cam,
      { width: o.width, opacityMin: o.opacityMin, relTol: o.relTol },
    );
    this.provenance = res;
    this.evidence.attach(mesh, res);
    this.regenIn = 90;
    this.evidence.buildFrustum(cam, this.sourceImage);
    this.cb.onCounts?.(res.counts.map((c) => (100 * c) / count) as EvidenceCounts);
    console.log("[provenance]", {
      count,
      ms: +(performance.now() - t0).toFixed(0),
      counts: res.counts,
    });
  }

  /** Classify whatever is under the crosshair and explain it (throttled). */
  private inspect(now: number) {
    // Raycast whichever twin is on screen; classifyPoint works from world position.
    const mesh = this.evidenceMesh?.visible ? this.evidenceMesh : this.splatMesh;
    if (!this.provenance || !mesh || now - this.lastInspect < 120) return;
    this.lastInspect = now;
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    const hits: { distance: number; point: THREE.Vector3; object: THREE.Object3D }[] = [];
    mesh.raycast(this.raycaster, hits);
    if (!hits.length) {
      this.cb.onVerdict?.(null);
      return;
    }
    hits.sort((a, b) => a.distance - b.distance);
    const v = classifyPoint(this.provenance, hits[0].point);
    this.cb.onVerdict?.({ cls: v.cls, label: CLASS_NAMES[v.cls].replace("_", " "), reason: v.reason });
  }

  private sampleFps(now: number) {
    this.frames += 1;
    const elapsed = now - this.fpsWindowStart;
    if (elapsed < 500) return;
    this.cb.onFps?.(Math.round((this.frames * 1000) / elapsed));
    this.frames = 0;
    this.fpsWindowStart = now;
  }
}

/** At runtime SplatMesh exposes a plain `numSplats`; with `lod: true` the data moves into packedSplats. */
function splatCount(mesh: SplatMesh): number {
  const n = (mesh as unknown as { numSplats?: unknown }).numSplats;
  if (typeof n === "number" && n > 0) return n;
  const packed = mesh.packedSplats as unknown as { numSplats?: number; lodSplats?: { numSplats?: number } } | undefined;
  return packed?.numSplats || packed?.lodSplats?.numSplats || mesh.extSplats?.numSplats || 0;
}
