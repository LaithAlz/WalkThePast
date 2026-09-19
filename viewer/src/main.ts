/**
 * Walk the Past viewer.
 * Phase 0: load a generated world (Marble), render with Spark, measure FPS, align the photographer.
 * Phase 1: photograph -> crossfade into the matching 3D pose -> first-person walking,
 *          photo/world wipe, animated reset-to-photographer, offline cache for the hero world.
 */
import * as THREE from "three";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import { Hud } from "./hud";
import { FirstPersonControls, isTyping } from "./controls";
import { PhotoTransition } from "./transition";
import { isWorldCached, prefetchWorld, registerWorker } from "./cache";
import { EvidenceLayer } from "./evidence";
import { CLASS_NAMES, classifyPoint, computeProvenance, makeSourceCamera, type ProvenanceResult } from "./provenance";
import { listWorlds, loadManifest, resolveAsset, type CameraPose, type Convention, type WorldManifest } from "./world";
import "./style.css";

// ---------------------------------------------------------------------------
// DOM + renderer
// ---------------------------------------------------------------------------
const app = document.getElementById("app")!;
const stage = document.getElementById("stage")!;
const canvas = document.getElementById("c") as HTMLCanvasElement;
const overlay = document.getElementById("overlay") as HTMLImageElement;
const landing = document.getElementById("landing")!;
const landingTitle = document.getElementById("landing-title")!;
const landingMeta = document.getElementById("landing-meta")!;
const enterBtn = document.getElementById("enter") as HTMLButtonElement;
const toastEl = document.getElementById("toast")!;

const params = new URLSearchParams(location.search);
if (params.get("dev") === "1") app.classList.add("dev");

const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0b0e);

const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 1000);
scene.add(camera);

// Render budget: Marble's own viewer draws every splat; Spark's default LoD budget is 1.5M.
const budget = Number(params.get("budget") ?? 3_000_000);
const spark = new SparkRenderer({ renderer, lodSplatCount: budget });
scene.add(spark);

/**
 * Scene graph:
 *   worldRoot   – convention transform (OpenCV -> three.js is a 180° turn about X)
 *     metricGroup – Marble metric scale + ground-plane offset
 *       splatMesh
 *       photographer – empty at the splat origin = where the source camera sat
 */
const worldRoot = new THREE.Group();
const metricGroup = new THREE.Group();
const photographer = new THREE.Object3D();
worldRoot.add(metricGroup);
metricGroup.add(photographer);
scene.add(worldRoot);

const grid = new THREE.Group();
grid.add(new THREE.GridHelper(20, 20, 0x444455, 0x26262f), new THREE.AxesHelper(1));
grid.visible = false;
scene.add(grid);

/** OpenCV camera (+z forward, +y down) -> three.js camera (-z forward, +y up). */
const Q_CV_TO_GL = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let manifest: WorldManifest | null = null;
let splatMesh: SplatMesh | null = null;
let convention: Convention = "opencv";
let sourceAspect: number | null = null;
let benchmarking = false;
let walkRadius = 0; // 0 = unlimited
const photographerPos = new THREE.Vector3();
let panoTex: THREE.Texture | null = null;
let flight: { from: CameraPose; to: CameraPose; t0: number; ms: number } | null = null;

// ---------------------------------------------------------------------------
// Phase 2: geometric provenance
// ---------------------------------------------------------------------------
const evidence = new EvidenceLayer();
scene.add(evidence.frustum);
let provenance: ProvenanceResult | null = null;
let evidenceMode = false;
let lastInspect = 0;
const raycaster = new THREE.Raycaster();
const evEls = {
  mode: document.getElementById("ev-mode")!,
  counts: [0, 1, 2].map((i) => document.getElementById(`ev-c${i}`)!),
  inset: document.getElementById("ev-inset") as HTMLCanvasElement,
  verdict: document.getElementById("ev-verdict")!,
};

function provenanceEnabled(m: WorldManifest): boolean {
  return !!m.source?.image && m.provenance?.enabled !== false && params.get("prov") !== "0";
}

/** Gather every Gaussian in world space and classify it against the photographer's camera. */
function runProvenance() {
  if (!manifest || !splatMesh || !provenanceEnabled(manifest)) return;
  const t0 = performance.now();
  const { pose } = photographerPose("auto");
  const aspect = sourceAspect ?? camera.aspect;
  const cam = makeSourceCamera(pose.position, pose.quaternion, pose.fovY ?? camera.fov, aspect);

  splatMesh.updateWorldMatrix(true, false);
  const m = splatMesh.matrixWorld;
  const worldScale = new THREE.Vector3().setFromMatrixScale(m).x;
  const n = splatCount(splatMesh);
  const positions = new Float32Array(n * 3);
  const maxScales = new Float32Array(n);
  const opacities = new Float32Array(n);
  const p = new THREE.Vector3();
  let count = 0;
  splatMesh.forEachSplat((i, center, scales, _q, opacity) => {
    if (i >= n) return;
    p.copy(center).applyMatrix4(m);
    positions[i * 3] = p.x;
    positions[i * 3 + 1] = p.y;
    positions[i * 3 + 2] = p.z;
    maxScales[i] = Math.max(scales.x, scales.y, scales.z) * worldScale;
    opacities[i] = opacity;
    count++;
  });
  const o = manifest.provenance ?? {};
  provenance = computeProvenance(positions.subarray(0, count * 3), maxScales.subarray(0, count), opacities.subarray(0, count), cam, {
    width: o.width,
    opacityMin: o.opacityMin,
    relTol: o.relTol,
  });
  evidence.attach(splatMesh, provenance);
  evidence.buildFrustum(cam, overlay.getAttribute("src") ? overlay : null);
  const total = Math.max(1, count);
  provenance.counts.forEach((c, i) => (evEls.counts[i].textContent = `${((100 * c) / total).toFixed(1)}%`));
  const ms = performance.now() - t0;
  hud.setStatus(`provenance: ${count.toLocaleString()} splats classified in ${ms.toFixed(0)} ms`, "ok");
  console.log("[provenance]", { count, ms: +ms.toFixed(0), counts: provenance.counts, cam });
}

function setEvidenceMode(on: boolean) {
  evidenceMode = on;
  evidence.setMode(on);
  app.classList.toggle("evidence", on);
  evEls.mode.textContent = on ? "evidence mode" : "exploration";
  if (on) toast("Evidence mode: green = photographed · amber = hidden behind what was photographed · purple = never in frame", 4500);
}

/** Classify whatever is under the crosshair and explain it (throttled). */
function inspect(now: number) {
  if (!provenance || !splatMesh || transition.mode !== "world" || now - lastInspect < 120) return;
  lastInspect = now;
  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
  const hits: { distance: number; point: THREE.Vector3; object: THREE.Object3D }[] = [];
  splatMesh.raycast(raycaster, hits);
  if (!hits.length) {
    evEls.verdict.textContent = "Nothing under the crosshair.";
    evEls.inset.className = "";
    drawInset(null);
    return;
  }
  hits.sort((a, b) => a.distance - b.distance);
  const v = classifyPoint(provenance, hits[0].point);
  evEls.verdict.innerHTML = `<b>${CLASS_NAMES[v.cls].replace("_", " ")}</b> · ${v.reason}`;
  evEls.inset.className = `c${v.cls}`;
  drawInset(Number.isNaN(v.u) ? null : [v.u, v.v]);
}

function drawInset(uv: [number, number] | null) {
  const ctx = evEls.inset.getContext("2d");
  if (!ctx) return;
  const W = evEls.inset.width, H = evEls.inset.height;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  if (overlay.naturalWidth) {
    const a = overlay.naturalWidth / overlay.naturalHeight;
    let w = W, h = W / a;
    if (h > H) { h = H; w = H * a; }
    const x0 = (W - w) / 2, y0 = (H - h) / 2;
    ctx.drawImage(overlay, x0, y0, w, h);
    if (uv) {
      const cx = x0 + Math.min(Math.max(uv[0], -0.05), 1.05) * w;
      const cy = y0 + Math.min(Math.max(uv[1], -0.05), 1.05) * h;
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = "#000";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, 8, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

// ---------------------------------------------------------------------------
// Controls + presentation
// ---------------------------------------------------------------------------
const controls = new FirstPersonControls(canvas, camera);
const transition = new PhotoTransition(overlay, document.getElementById("wipe-handle")!, stage);

controls.onLockChange = (locked) => app.classList.toggle("locked", locked);
controls.onPadButton = (i) => {
  if (transition.mode === "photo" && i === 0) void enterWorld(); // A
  else if (i === 3) resetToPhotographer(); // Y
  else if (i === 2) transition.toggleWipe(); // X
};
transition.onMode = (m) => {
  app.classList.toggle("world", m === "world");
  landing.classList.toggle("hidden", m === "world");
  controls.enabled = m === "world";
  if (m === "photo") controls.unlock();
};

let toastTimer = 0;
function toast(msg: string, ms = 2200) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove("show"), ms);
}

// ---------------------------------------------------------------------------
// Dev HUD (hidden unless ?dev=1 or H)
// ---------------------------------------------------------------------------
const hud = new Hud(document.getElementById("hud")!, {
  onWorldChange(id) {
    params.set("world", id);
    history.replaceState(null, "", `?${params}`);
    void loadWorld(id);
  },
  onOverlay(o) {
    transition.setOpacity(o);
  },
  onFov(deg) {
    camera.fov = deg;
    camera.updateProjectionMatrix();
    hud.setStat("fov", `${deg.toFixed(1)}°`);
  },
  onSpeed(v) {
    controls.moveSpeed = v;
  },
  onReset: () => resetToPhotographer(),
  onCopyCamera: () => copyCamera(),
  onSavePose: () => savePose(),
  onFlip: () => setConvention(convention === "opencv" ? "threejs" : "opencv"),
  onGrid: () => (grid.visible = !grid.visible),
  onBench: () => void runBenchmark(),
  onCache: () => void cacheCurrentWorld(),
  onWipe: () => transition.toggleWipe(),
  onPhoto: () => transition.showPhoto(),
});

document.addEventListener("keydown", (e) => {
  if (isTyping(e)) return;
  switch (e.code) {
    case "Enter":
    case "Space":
      if (transition.mode === "photo") {
        e.preventDefault();
        void enterWorld();
      }
      break;
    case "Tab":
      e.preventDefault();
      transition.peek(true);
      break;
    case "KeyV":
      transition.toggleWipe();
      break;
    case "KeyH":
      app.classList.toggle("dev");
      break;
    case "KeyO": {
      const cur = hud.getSlider("overlay");
      hud.setSlider("overlay", cur === 0 ? 0.5 : cur < 1 ? 1 : 0);
      break;
    }
    case "BracketLeft":
      hud.setSlider("fov", Math.max(20, hud.getSlider("fov") - (e.shiftKey ? 5 : 0.5)));
      break;
    case "BracketRight":
      hud.setSlider("fov", Math.min(120, hud.getSlider("fov") + (e.shiftKey ? 5 : 0.5)));
      break;
    case "KeyR":
      resetToPhotographer(e.shiftKey ? "manifest" : "auto");
      break;
    case "KeyC":
      copyCamera();
      break;
    case "KeyL":
      savePose();
      break;
    case "KeyF":
      setConvention(convention === "opencv" ? "threejs" : "opencv");
      break;
    case "KeyG":
      grid.visible = !grid.visible;
      break;
    case "KeyB":
      void runBenchmark();
      break;
    case "KeyM":
      if (provenance) setEvidenceMode(!evidenceMode);
      else toast("no provenance for this world (needs a source photo)");
      break;
    case "KeyK":
      evidence.frustum.visible = !evidence.frustum.visible;
      break;
    case "KeyP":
      runProvenance();
      toast("provenance recomputed from the current photographer pose");
      break;
    case "KeyX": {
      const def = Number(manifest?.bounds?.radiusM ?? 0);
      walkRadius = walkRadius > 0 ? 0 : def || 3.5;
      hud.setStat("radius", walkRadius > 0 ? `${walkRadius} m` : "off");
      toast(walkRadius > 0 ? `walk radius ${walkRadius} m` : "walk radius off");
      break;
    }
  }
});
document.addEventListener("keyup", (e) => {
  if (e.code === "Tab") transition.peek(false);
});
enterBtn.addEventListener("click", () => void enterWorld());

// ---------------------------------------------------------------------------
// Layout: letterbox the stage to the source photo's aspect so the overlay
// and the rendered view share the exact same frame.
// ---------------------------------------------------------------------------
function layout() {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const aspect = sourceAspect ?? W / H;
  let w = W;
  let h = Math.round(W / aspect);
  if (h > H) {
    h = H;
    w = Math.round(H * aspect);
  }
  stage.style.width = `${w}px`;
  stage.style.height = `${h}px`;
  stage.style.left = `${Math.floor((W - w) / 2)}px`;
  stage.style.top = `${Math.floor((H - h) / 2)}px`;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", layout);

// ---------------------------------------------------------------------------
// Conventions + photographer pose
// ---------------------------------------------------------------------------
function setConvention(c: Convention) {
  convention = c;
  worldRoot.rotation.set(c === "opencv" ? Math.PI : 0, 0, 0);
  hud.setStat("conv", c === "opencv" ? "opencv → rotX(180°)" : "three.js (no flip)");
}

/** The pose the viewer believes the original photographer occupied. */
function defaultPhotographerPose(): CameraPose {
  photographer.updateWorldMatrix(true, false);
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  photographer.getWorldPosition(p);
  photographer.getWorldQuaternion(q);
  q.multiply(Q_CV_TO_GL);
  return {
    position: [p.x, p.y, p.z],
    quaternion: [q.x, q.y, q.z, q.w],
    fovY: manifest?.source?.fovY ?? 60,
  };
}

function currentPose(): CameraPose {
  return {
    position: camera.position.toArray() as [number, number, number],
    quaternion: camera.quaternion.toArray() as [number, number, number, number],
    fovY: camera.fov,
  };
}

function applyPose(pose: CameraPose) {
  camera.position.fromArray(pose.position);
  camera.quaternion.fromArray(pose.quaternion);
  if (pose.fovY) hud.setSlider("fov", pose.fovY);
  controls.syncFromCamera();
}

/** Ease the camera to `pose` over `ms` (controls are paused meanwhile). */
function flyTo(pose: CameraPose, ms = 900) {
  flight = { from: currentPose(), to: pose, t0: performance.now(), ms };
}

function stepFlight() {
  if (!flight) return;
  const t = Math.min(1, (performance.now() - flight.t0) / flight.ms);
  const k = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  const a = new THREE.Vector3().fromArray(flight.from.position);
  const b = new THREE.Vector3().fromArray(flight.to.position);
  camera.position.lerpVectors(a, b, k);
  const qa = new THREE.Quaternion().fromArray(flight.from.quaternion);
  const qb = new THREE.Quaternion().fromArray(flight.to.quaternion);
  camera.quaternion.slerpQuaternions(qa, qb, k);
  const fa = flight.from.fovY ?? camera.fov;
  const fb = flight.to.fovY ?? fa;
  camera.fov = fa + (fb - fa) * k;
  camera.updateProjectionMatrix();
  if (t >= 1) {
    flight = null;
    hud.setSlider("fov", camera.fov);
    controls.syncFromCamera();
    controls.enabled = transition.mode === "world";
  }
}

function poseKey() {
  return `wtp:pose:${manifest?.id ?? "none"}`;
}

/** auto: saved pose (localStorage) → manifest sourceCamera → splat origin. manifest: skip the saved pose. */
function photographerPose(mode: "auto" | "manifest" = "auto"): { pose: CameraPose; from: string } {
  if (mode === "auto") {
    const saved = localStorage.getItem(poseKey());
    if (saved) return { pose: JSON.parse(saved) as CameraPose, from: "saved pose" };
  }
  if (manifest?.sourceCamera) return { pose: manifest.sourceCamera, from: "manifest sourceCamera" };
  return { pose: defaultPhotographerPose(), from: "splat origin" };
}

function resetToPhotographer(mode: "auto" | "manifest" = "auto", animate = true) {
  if (!manifest) return;
  const { pose, from } = photographerPose(mode);
  photographerPos.fromArray(pose.position);
  if (animate && transition.mode === "world") {
    controls.enabled = false;
    flyTo(pose);
  } else {
    applyPose(pose);
  }
  hud.setStat("cam", from);
}

function cameraJson(): string {
  return JSON.stringify({ ...currentPose(), convention, world: manifest?.id ?? "" }, null, 2);
}

function copyCamera() {
  const j = cameraJson();
  hud.setText(j);
  void navigator.clipboard?.writeText(j).then(
    () => toast("camera JSON copied — paste as sourceCamera in world.json"),
    () => toast("camera JSON shown in the dev panel (clipboard blocked)"),
  );
}

function savePose() {
  if (!manifest) return;
  localStorage.setItem(poseKey(), JSON.stringify(currentPose()));
  photographerPos.copy(camera.position);
  toast(`photographer pose saved for "${manifest.id}"`);
  hud.setStat("cam", "saved pose");
  runProvenance();
}

// ---------------------------------------------------------------------------
// Panorama backdrop + walk radius
// ---------------------------------------------------------------------------
function clearPano() {
  scene.background = new THREE.Color(0x0b0b0e);
  scene.environment = null;
  panoTex?.dispose();
  panoTex = null;
}

/** Marble's pano is captured at the splat origin. Its centre column faces the input photo (+z OpenCV = -z three.js);
 *  three.js equirect centre faces +x, hence the default 90° yaw (verified against the photo). */
async function loadPano(url: string, yawDeg: number) {
  clearPano();
  const tex = await new THREE.TextureLoader().loadAsync(url);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  panoTex = tex;
  scene.background = tex;
  scene.backgroundRotation.set(0, THREE.MathUtils.degToRad(yawDeg), 0);
}

function applyWalkRadius() {
  if (walkRadius <= 0 || flight) return;
  const d = camera.position.distanceTo(photographerPos);
  if (d > walkRadius) {
    camera.position.sub(photographerPos).multiplyScalar(walkRadius / d).add(photographerPos);
  }
}

// ---------------------------------------------------------------------------
// Landing card + enter
// ---------------------------------------------------------------------------
function fillLanding(m: WorldManifest) {
  const c = m.credit ?? {};
  landingTitle.textContent = c.title ?? m.name;
  const parts = [c.photographer, c.year, c.place].filter(Boolean).join(" · ");
  landingMeta.innerHTML = [parts, c.licence].filter(Boolean).map((s) => `<div>${s}</div>`).join("");
}

let ready = false;
async function enterWorld() {
  if (!manifest || transition.mode !== "photo") return;
  if (!ready) {
    toast("still loading the world…");
    return;
  }
  enterBtn.disabled = true;
  resetToPhotographer("auto", false);
  await transition.enterWorld();
  enterBtn.disabled = false;
  toast("click to look around · WASD to walk");
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
/** At runtime SplatMesh exposes a plain `numSplats`; with `lod: true` data moves into packedSplats.lodSplats. */
function splatCount(mesh: SplatMesh): number {
  const n = (mesh as unknown as { numSplats?: unknown }).numSplats;
  if (typeof n === "number" && n > 0) return n;
  const packed = mesh.packedSplats as unknown as { numSplats?: number; lodSplats?: { numSplats?: number } } | undefined;
  return packed?.numSplats || packed?.lodSplats?.numSplats || mesh.extSplats?.numSplats || 0;
}

function disposeCurrent() {
  if (splatMesh) {
    metricGroup.remove(splatMesh);
    splatMesh.dispose();
    splatMesh = null;
  }
}

async function mountSplat(opts: { url?: string; fileBytes?: ArrayBuffer; fileName?: string; lod: boolean }) {
  disposeCurrent();
  const t0 = performance.now();
  const mesh = new SplatMesh({
    url: opts.url,
    fileBytes: opts.fileBytes,
    fileName: opts.fileName,
    lod: opts.lod,
    onProgress: (ev) => {
      const msg = ev.lengthComputable
        ? `downloading ${(ev.loaded / 1e6).toFixed(1)} / ${(ev.total / 1e6).toFixed(1)} MB`
        : `decoding… ${(ev.loaded / 1e6).toFixed(1)} MB`;
      hud.setStatus(msg);
      enterBtn.textContent = msg;
    },
  });
  metricGroup.add(mesh);
  splatMesh = mesh;
  await mesh.initialized;
  const n = splatCount(mesh);
  hud.setStat("splats", n.toLocaleString());
  hud.setStatus(`loaded ${n.toLocaleString()} splats in ${((performance.now() - t0) / 1000).toFixed(1)} s`, "ok");
  setTimeout(() => splatMesh === mesh && hud.setStat("splats", splatCount(mesh).toLocaleString()), 2000);
  return mesh;
}

async function loadWorld(id: string) {
  ready = false;
  transition.showPhoto();
  enterBtn.textContent = "loading…";
  hud.setStatus(`loading manifest for "${id}"…`);
  try {
    manifest = await loadManifest(id);
  } catch (e) {
    hud.setStatus(String(e), "bad");
    enterBtn.textContent = "world not found";
    return;
  }
  document.title = `${manifest.name} — Walk the Past`;
  hud.setStat("gen", manifest.generator);
  fillLanding(manifest);

  const s = manifest.metric?.scaleFactor ?? 1;
  const g = manifest.metric?.groundPlaneOffset ?? 0;
  metricGroup.scale.setScalar(s);
  metricGroup.position.set(0, -g, 0); // raw frame: ground offset applies along raw y before the axis flip
  photographer.position.set(0, 0, 0);
  photographer.quaternion.identity();
  setConvention(manifest.splat.convention ?? "opencv");

  if (manifest.pano?.url && params.get("pano") !== "0") {
    const yaw = Number(params.get("panoYaw") ?? manifest.pano.yawDeg ?? 90);
    loadPano(manifest.pano.url, yaw).catch((e) => console.warn("pano failed", e));
  } else {
    clearPano();
  }
  walkRadius = Number(params.get("radius") ?? manifest.bounds?.radiusM ?? 0);
  hud.setStat("radius", walkRadius > 0 ? `${walkRadius} m` : "off");

  // source photo + letterbox
  if (manifest.source?.image) {
    overlay.src = manifest.source.image;
    await new Promise<void>((res) => {
      overlay.onload = () => res();
      overlay.onerror = () => res();
    });
    sourceAspect = overlay.naturalWidth && overlay.naturalHeight ? overlay.naturalWidth / overlay.naturalHeight : null;
  } else {
    overlay.removeAttribute("src");
    sourceAspect = null;
  }
  transition.showPhoto();
  layout();

  // camera at the photographer while the splat streams in, so the crossfade lands on the right view
  resetToPhotographer("auto", false);

  // provenance needs file-order indices and forEachSplat over every Gaussian: no LoD tree
  const prov = provenanceEnabled(manifest);
  const lod = params.has("lod") ? params.get("lod") !== "0" : prov ? false : manifest.splat.lod ?? true;
  const splatUrl = params.get("splat") ? resolveAsset(manifest.id, params.get("splat")!) : manifest.splat.url;
  provenance = null;
  evidence.detach();
  setEvidenceMode(false);
  try {
    await mountSplat({ url: splatUrl, lod });
  } catch (e) {
    hud.setStatus(`splat load failed: ${String(e)}`, "bad");
    enterBtn.textContent = "failed to load world";
    return;
  }
  if (prov) {
    enterBtn.textContent = "classifying evidence…";
    await new Promise((r) => setTimeout(r, 30)); // let the button repaint
    runProvenance();
  }
  ready = true;
  enterBtn.textContent = "Walk into the photograph";
  void isWorldCached(manifest).then((c) => hud.setStat("cache", c ? "offline ✓" : "not cached"));
  if (!manifest.source?.image) void enterWorld(); // nothing to fade from
}

async function cacheCurrentWorld() {
  if (!manifest) return;
  try {
    hud.setStat("cache", "caching…");
    const bytes = await prefetchWorld(manifest, (d, t, b) => hud.setStat("cache", `${d}/${t} · ${(b / 1e6).toFixed(0)} MB`));
    hud.setStat("cache", `offline ✓ ${(bytes / 1e6).toFixed(0)} MB`);
    toast(`world cached for offline use (${(bytes / 1e6).toFixed(0)} MB)`);
  } catch (e) {
    hud.setStat("cache", `failed: ${String(e)}`);
  }
}

// Drag & drop a local .ply / .spz for ad-hoc inspection.
window.addEventListener("dragover", (e) => {
  e.preventDefault();
  app.classList.add("dragging");
});
window.addEventListener("dragleave", () => app.classList.remove("dragging"));
window.addEventListener("drop", async (e) => {
  e.preventDefault();
  app.classList.remove("dragging");
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  manifest = { id: `dropped:${f.name}`, name: f.name, generator: "other", splat: { url: "", convention: "opencv" } };
  provenance = null;
  evidence.detach();
  setEvidenceMode(false);
  hud.setStat("gen", "dropped file");
  fillLanding(manifest);
  metricGroup.scale.setScalar(1);
  metricGroup.position.set(0, 0, 0);
  setConvention("opencv");
  clearPano();
  walkRadius = 0;
  hud.setStat("radius", "off");
  sourceAspect = null;
  overlay.removeAttribute("src");
  layout();
  hud.setStatus(`reading ${f.name}…`);
  try {
    await mountSplat({ fileBytes: await f.arrayBuffer(), fileName: f.name, lod: true });
    ready = true;
    resetToPhotographer("manifest", false);
    void enterWorld();
  } catch (err) {
    hud.setStatus(`failed: ${String(err)}`, "bad");
  }
});

// ---------------------------------------------------------------------------
// Benchmark: 10 s of frame times while you walk around.
// ---------------------------------------------------------------------------
const benchSamples: number[] = [];
async function runBenchmark() {
  if (benchmarking) return;
  benchmarking = true;
  benchSamples.length = 0;
  toast("benchmark: 10 s — walk around");
  await new Promise((r) => setTimeout(r, 10_000));
  benchmarking = false;
  const ft = [...benchSamples].sort((a, b) => a - b);
  if (ft.length === 0) return;
  const avg = ft.reduce((a, b) => a + b, 0) / ft.length;
  const p = (q: number) => ft[Math.min(ft.length - 1, Math.floor(q * ft.length))];
  const gl = renderer.getContext();
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  const report = {
    world: manifest?.id,
    generator: manifest?.generator,
    splats: splatMesh ? splatCount(splatMesh) : 0,
    resolution: `${canvas.width}x${canvas.height} @${renderer.getPixelRatio()}x`,
    gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "unknown",
    frames: ft.length,
    fps_avg: +(1000 / avg).toFixed(1),
    fps_p1_low: +(1000 / p(0.99)).toFixed(1),
    fps_min: +(1000 / ft[ft.length - 1]).toFixed(1),
    frame_ms_avg: +avg.toFixed(2),
    frame_ms_p99: +p(0.99).toFixed(2),
    date: new Date().toISOString(),
  };
  const j = JSON.stringify(report, null, 2);
  hud.setText(j);
  toast(`benchmark: ${report.fps_avg} fps avg, ${report.fps_p1_low} fps 1% low`, 4000);
  console.log("[bench]", report);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
let lastT = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  if (flight) stepFlight();
  else controls.update(dt);
  applyWalkRadius();
  if (provenance) {
    // exploration mode: unsupported regions shift as the viewer leaves observed space
    const d = camera.position.distanceTo(photographerPos);
    evidence.setShift(THREE.MathUtils.smoothstep(d, 0.35, 3.0));
    inspect(now);
  }
  renderer.render(scene, camera);
  hud.tick(dt * 1000);
  if (benchmarking) benchSamples.push(dt * 1000);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async () => {
  layout();
  void registerWorker();
  const worlds = await listWorlds();
  const id = params.get("world") ?? worlds[0]?.id ?? "";
  hud.setWorlds(worlds, id);
  hud.setStat("conv", "opencv → rotX(180°)");
  if (id) await loadWorld(id);
  else hud.setStatus("no worlds in public/worlds/index.json — drop a .ply/.spz to view one");
})();

// Debug handle for the console / tests (window.wtp.mesh etc.)
declare global {
  interface Window {
    wtp: {
      readonly mesh: SplatMesh | null;
      readonly manifest: WorldManifest | null;
      camera: THREE.PerspectiveCamera;
      scene: THREE.Scene;
      spark: SparkRenderer;
      controls: FirstPersonControls;
      transition: PhotoTransition;
      enterWorld: () => Promise<void>;
      readonly flight: unknown;
      readonly provenance: ProvenanceResult | null;
      setEvidenceMode: (on: boolean) => void;
    };
  }
}
window.wtp = {
  get mesh() {
    return splatMesh;
  },
  get manifest() {
    return manifest;
  },
  camera,
  scene,
  spark,
  controls,
  transition,
  enterWorld,
  get flight() {
    return flight;
  },
  get provenance() {
    return provenance;
  },
  setEvidenceMode,
};
