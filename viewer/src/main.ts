/**
 * Phase 0 viewer: load a generated world (Marble or Lyra), render it with
 * Spark inside three.js, measure FPS, and test whether the original
 * photograph's camera can be recreated inside the generated scene.
 */
import * as THREE from "three";
import { SparkRenderer, SplatMesh, SparkControls } from "@sparkjsdev/spark";
import { Hud } from "./hud";
import { listWorlds, loadManifest, resolveAsset, type CameraPose, type Convention, type WorldManifest } from "./world";
import "./style.css";

// ---------------------------------------------------------------------------
// DOM + renderer
// ---------------------------------------------------------------------------
const app = document.getElementById("app")!;
const stage = document.getElementById("stage")!;
const canvas = document.getElementById("c") as HTMLCanvasElement;
const overlay = document.getElementById("overlay") as HTMLImageElement;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0b0e);

const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 1000);
scene.add(camera);

const spark = new SparkRenderer({ renderer });
scene.add(spark);

/**
 * Scene graph:
 *   worldRoot   – convention transform (OpenCV -> three.js is a 180° turn about X)
 *     metricGroup – Marble metric scale + ground-plane offset (identity for Lyra)
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

const params = new URLSearchParams(location.search);

// ---------------------------------------------------------------------------
// Controls (WASD / QE / drag-look) from Spark
// ---------------------------------------------------------------------------
const controls = new SparkControls({ canvas });
controls.fpsMovement.moveSpeed = 2;

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------
const hud = new Hud(document.getElementById("hud")!, {
  onWorldChange(id) {
    params.set("world", id);
    history.replaceState(null, "", `?${params}`);
    void loadWorld(id);
  },
  onOverlay(o) {
    overlay.style.opacity = String(o);
    overlay.style.display = o > 0 ? "block" : "none";
  },
  onWipe(p) {
    overlay.style.clipPath = `inset(0 ${100 - p}% 0 0)`;
  },
  onFov(deg) {
    camera.fov = deg;
    camera.updateProjectionMatrix();
    hud.setStat("fov", `${deg.toFixed(1)}°`);
  },
  onSpeed(v) {
    controls.fpsMovement.moveSpeed = v;
  },
  onReset: () => resetToPhotographer(),
  onCopyCamera: () => copyCamera(),
  onSavePose: () => savePose(),
  onFlip: () => setConvention(convention === "opencv" ? "threejs" : "opencv"),
  onGrid: () => (grid.visible = !grid.visible),
  onBench: () => void runBenchmark(),
});

document.addEventListener("keydown", (e) => {
  if ((e.target as HTMLElement)?.tagName === "TEXTAREA") return;
  switch (e.code) {
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
  }
});

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

function applyPose(pose: CameraPose) {
  camera.position.fromArray(pose.position);
  camera.quaternion.fromArray(pose.quaternion);
  if (pose.fovY) hud.setSlider("fov", pose.fovY);
}

function poseKey() {
  return `wtp:pose:${manifest?.id ?? "none"}`;
}

/**
 * auto: saved pose (localStorage) → manifest sourceCamera → splat origin
 * manifest: skip the saved pose
 */
function resetToPhotographer(mode: "auto" | "manifest" = "auto") {
  if (!manifest) return;
  let pose: CameraPose | null = null;
  let from = "splat origin";
  if (mode === "auto") {
    const saved = localStorage.getItem(poseKey());
    if (saved) {
      pose = JSON.parse(saved) as CameraPose;
      from = "saved pose";
    }
  }
  if (!pose && manifest.sourceCamera) {
    pose = manifest.sourceCamera;
    from = "manifest sourceCamera";
  }
  if (!pose) pose = defaultPhotographerPose();
  applyPose(pose);
  hud.setStat("cam", from);
}

function cameraJson(): string {
  const pose: CameraPose & { convention: Convention; world: string } = {
    position: camera.position.toArray() as [number, number, number],
    quaternion: camera.quaternion.toArray() as [number, number, number, number],
    fovY: camera.fov,
    convention,
    world: manifest?.id ?? "",
  };
  return JSON.stringify(pose, null, 2);
}

function copyCamera() {
  const j = cameraJson();
  hud.setText(j);
  void navigator.clipboard?.writeText(j).then(
    () => hud.setStatus("camera JSON copied — paste as sourceCamera in world.json", "ok"),
    () => hud.setStatus("camera JSON shown below (clipboard blocked)"),
  );
}

function savePose() {
  if (!manifest) return;
  const pose: CameraPose = {
    position: camera.position.toArray() as [number, number, number],
    quaternion: camera.quaternion.toArray() as [number, number, number, number],
    fovY: camera.fov,
  };
  localStorage.setItem(poseKey(), JSON.stringify(pose));
  hud.setStatus(`pose saved for "${manifest.id}" (R restores it, Shift+R ignores it)`, "ok");
  hud.setStat("cam", "saved pose");
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
/**
 * Number of splats in the loaded file. At runtime SplatMesh exposes a plain
 * `numSplats` number; with `lod: true` the packed data itself moves into
 * `packedSplats.lodSplats` (the LoD tree, larger than the file), so prefer the former.
 */
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
      if (ev.lengthComputable) {
        hud.setStatus(`downloading ${(ev.loaded / 1e6).toFixed(1)} / ${(ev.total / 1e6).toFixed(1)} MB`);
      } else {
        hud.setStatus(`decoding… ${(ev.loaded / 1e6).toFixed(1)} MB`);
      }
    },
  });
  metricGroup.add(mesh);
  splatMesh = mesh;
  await mesh.initialized;
  const n = splatCount(mesh);
  hud.setStat("splats", n.toLocaleString());
  hud.setStatus(`loaded ${n.toLocaleString()} splats in ${((performance.now() - t0) / 1000).toFixed(1)} s`, "ok");
  // the file's own count settles a moment after `initialized` when LoD is on
  setTimeout(() => splatMesh === mesh && hud.setStat("splats", splatCount(mesh).toLocaleString()), 2000);
  return mesh;
}

async function loadWorld(id: string) {
  hud.setStatus(`loading manifest for "${id}"…`);
  try {
    manifest = await loadManifest(id);
  } catch (e) {
    hud.setStatus(String(e), "bad");
    return;
  }
  document.title = `${manifest.name} — Walk the Past`;
  hud.setStat("gen", manifest.generator);

  // metric transform (Marble)
  const s = manifest.metric?.scaleFactor ?? 1;
  const g = manifest.metric?.groundPlaneOffset ?? 0;
  metricGroup.scale.setScalar(s);
  metricGroup.position.set(0, -g, 0); // raw frame: ground offset is applied along raw y before the axis flip
  photographer.position.set(0, 0, 0);
  photographer.quaternion.identity();

  setConvention(manifest.splat.convention ?? "opencv");

  // source photo overlay + letterbox
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
  layout();

  const lod = params.has("lod") ? params.get("lod") !== "0" : manifest.splat.lod ?? true;
  // ?splat=splat_500k.spz swaps in another tier from the same world folder (for quality/FPS comparisons)
  const splatUrl = params.get("splat") ? resolveAsset(manifest.id, params.get("splat")!) : manifest.splat.url;
  try {
    await mountSplat({ url: splatUrl, lod });
  } catch (e) {
    hud.setStatus(`splat load failed: ${String(e)}`, "bad");
    return;
  }
  resetToPhotographer();
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
  manifest = {
    id: `dropped:${f.name}`,
    name: f.name,
    generator: "other",
    splat: { url: "", convention: "opencv" },
  };
  hud.setStat("gen", "dropped file");
  metricGroup.scale.setScalar(1);
  metricGroup.position.set(0, 0, 0);
  setConvention("opencv");
  sourceAspect = null;
  overlay.removeAttribute("src");
  layout();
  hud.setStatus(`reading ${f.name}…`);
  try {
    await mountSplat({ fileBytes: await f.arrayBuffer(), fileName: f.name, lod: true });
    resetToPhotographer("manifest");
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
  hud.setStatus("benchmark running for 10 s — walk around the scene", "ok");
  await new Promise((r) => setTimeout(r, 10_000));
  benchmarking = false;
  const ft = [...benchSamples].sort((a, b) => a - b);
  if (ft.length === 0) return;
  const avg = ft.reduce((a, b) => a + b, 0) / ft.length;
  const p = (q: number) => ft[Math.min(ft.length - 1, Math.floor(q * ft.length))];
  const gl = renderer.getContext();
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  const gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "unknown";
  const report = {
    world: manifest?.id,
    generator: manifest?.generator,
    splats: splatMesh ? splatCount(splatMesh) : 0,
    resolution: `${canvas.width}x${canvas.height} @${renderer.getPixelRatio()}x`,
    gpu,
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
  hud.setStatus(`benchmark: ${report.fps_avg} fps avg, ${report.fps_p1_low} fps 1% low`, report.fps_p1_low >= 30 ? "ok" : "bad");
  console.log("[bench]", report);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
let lastT = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = now - lastT;
  lastT = now;
  controls.update(camera);
  renderer.render(scene, camera);
  hud.tick(dt);
  if (benchmarking) benchSamples.push(dt);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async () => {
  layout();
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
    wtp: { readonly mesh: SplatMesh | null; readonly manifest: WorldManifest | null; camera: THREE.PerspectiveCamera; scene: THREE.Scene; spark: SparkRenderer };
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
};
