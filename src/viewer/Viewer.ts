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
import { FirstPersonControls } from "./controls";
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

export type ViewerCallbacks = {
  onStatus?: (status: ViewerStatus) => void;
  /** Fired as soon as the manifest is parsed, before the splat streams (drives the photo landing). */
  onManifest?: (manifest: WorldManifest) => void;
  onFps?: (fps: number) => void;
  onCounts?: (counts: EvidenceCounts) => void;
  onVerdict?: (verdict: Verdict | null) => void;
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
  private sourceImage: HTMLImageElement | null = null;
  private sourceAspect: number | null = null;
  private provenance: ProvenanceResult | null = null;
  private panoTex: THREE.Texture | null = null;
  private walkRadius = 0; // 0 = unlimited
  private flight: { from: CameraPose; to: CameraPose; t0: number; ms: number } | null = null;
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

    this.spark = new SparkRenderer({ renderer: this.renderer, lodSplatCount: 3_000_000 });
    this.scene.add(this.spark);

    this.worldRoot.add(this.metricGroup);
    this.metricGroup.add(this.photographer);
    this.scene.add(this.worldRoot, this.evidence.frustum);

    this.controls = new FirstPersonControls(canvas, this.camera);

    this.onKeyDown = (e) => {
      if (this.frameHandle && e.code === "KeyR") this.resetToPhotographer();
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

      if (this.flight) this.stepFlight();
      else this.controls.update(dt);
      this.applyWalkRadius();
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

  /** Freeze the exact current camera view before handing the screen to a non-WebGL experience. */
  captureSnapshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.canvas.toDataURL("image/jpeg", 0.9);
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
    this.evidence.detach();
    this.clearSplat();
    this.clearPano();
    this.renderer.dispose();
  }

  /** Load a world by manifest id (public/worlds/<id>/world.json). */
  async load(id: string) {
    const token = ++this.loadToken;
    this.provenance = null;
    this.evidence.detach();
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
    this.cb.onManifest?.(manifest);

    const scale = manifest.metric?.scaleFactor ?? 1;
    const ground = manifest.metric?.groundPlaneOffset ?? 0;
    this.metricGroup.scale.setScalar(scale);
    // raw frame: the ground offset applies along raw y, before the axis flip
    this.metricGroup.position.set(0, -ground, 0);
    this.photographer.position.set(0, 0, 0);
    this.photographer.quaternion.identity();
    this.setConvention(manifest.splat.convention ?? "opencv");
    this.walkRadius = manifest.bounds?.radiusM ?? 0;

    await this.loadSourceImage(manifest);
    if (token !== this.loadToken || this.disposed) return;

    if (manifest.pano?.url) {
      this.loadPano(manifest.pano.url, manifest.pano.yawDeg ?? 90).catch((e) => console.warn("pano failed", e));
    } else {
      this.clearPano();
    }

    // Sit at the photographer while the splat streams in, so the first frame
    // after load is already the historical viewpoint.
    this.resetToPhotographer(false);

    // Provenance needs file-order indices and forEachSplat over every Gaussian,
    // so the LoD tree has to stay off when it is enabled.
    const wantsProvenance = this.provenanceEnabled(manifest);
    // ?splat=splat_500k.spz swaps in another tier from the world folder (quality / FPS comparisons, tests)
    const override = new URLSearchParams(location.search).get("splat");
    const splatUrl = override ? manifest.splat.url.replace(/[^/]+$/, override) : manifest.splat.url;
    try {
      await this.mountSplat(splatUrl, wantsProvenance ? false : manifest.splat.lod ?? true, token);
    } catch (error) {
      if (token === this.loadToken) this.cb.onStatus?.({ kind: "error", message: `splat load failed: ${String(error)}` });
      return;
    }
    if (token !== this.loadToken || this.disposed) return;

    this.resetToPhotographer(false);
    if (wantsProvenance) {
      this.cb.onStatus?.({ kind: "loading", message: "classifying evidence" });
      await new Promise((r) => setTimeout(r, 30)); // let the UI repaint before a long sync pass
      if (token !== this.loadToken || this.disposed) return;
      this.runProvenance();
    }
    this.cb.onStatus?.({ kind: "ready", splats: this.splatMesh ? splatCount(this.splatMesh) : 0 });
  }

  setEvidenceMode(on: boolean) {
    this.evidence.setMode(on && !!this.provenance);
  }

  /** While the photograph is showing, the world should not respond to input. */
  setInteractive(on: boolean) {
    this.controls.setEnabled(on);
  }

  /** The source photo's aspect (width / height), once loaded; null without a photo. */
  get photoAspect(): number | null {
    return this.sourceAspect;
  }

  /** Ease the camera back to the pose the photographer is believed to have occupied. */
  resetToPhotographer(animate = true) {
    if (!this.manifest) return;
    const pose = this.photographerPose();
    this.photographerPos.fromArray(pose.position);
    if (animate) {
      this.controls.enabled = false;
      this.flight = { from: this.currentPose(), to: pose, t0: performance.now(), ms: 900 };
    } else {
      this.applyPose(pose);
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

  private stepFlight() {
    if (!this.flight) return;
    const t = Math.min(1, (performance.now() - this.flight.t0) / this.flight.ms);
    const k = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    this.camera.position.lerpVectors(
      new THREE.Vector3().fromArray(this.flight.from.position),
      new THREE.Vector3().fromArray(this.flight.to.position),
      k,
    );
    this.camera.quaternion.slerpQuaternions(
      new THREE.Quaternion().fromArray(this.flight.from.quaternion),
      new THREE.Quaternion().fromArray(this.flight.to.quaternion),
      k,
    );
    const fa = this.flight.from.fovY ?? this.camera.fov;
    const fb = this.flight.to.fovY ?? fa;
    this.camera.fov = fa + (fb - fa) * k;
    this.camera.updateProjectionMatrix();
    if (t >= 1) {
      this.flight = null;
      this.controls.syncFromCamera();
      this.controls.enabled = true;
    }
  }

  private applyWalkRadius() {
    if (this.walkRadius <= 0 || this.flight) return;
    const d = this.camera.position.distanceTo(this.photographerPos);
    if (d > this.walkRadius) {
      this.camera.position.sub(this.photographerPos).multiplyScalar(this.walkRadius / d).add(this.photographerPos);
    }
  }

  // -------------------------------------------------------------------------
  // Provenance
  // -------------------------------------------------------------------------

  /** Gather every Gaussian in world space and classify it against the photographer's camera. */
  private runProvenance() {
    const mesh = this.splatMesh;
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
    const mesh = this.splatMesh;
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
