import * as THREE from "three";
import { SparkControls, SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import type { World } from "../worlds";

export type ViewerStatus =
  | { kind: "empty" }
  | { kind: "loading"; world: World; progress: number }
  | { kind: "ready"; world: World; splats: number }
  | { kind: "error"; world: World; message: string };

export type ViewerCallbacks = {
  onStatus?: (status: ViewerStatus) => void;
  onFps?: (fps: number) => void;
};

/**
 * Owns the Three.js + Spark render loop. Deliberately written as a plain class
 * rather than react-three-fiber: Phase 2 (geometric provenance) needs direct
 * access to Spark's dyno shader graph, and an imperative viewer keeps React out
 * of the per-frame path entirely.
 */
export class Viewer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly spark: SparkRenderer;
  private readonly controls: SparkControls;
  private readonly canvas: HTMLCanvasElement;
  private readonly callbacks: ViewerCallbacks;
  private readonly placeholder: THREE.Group;

  private splat: SplatMesh | null = null;
  private frameHandle = 0;
  private disposed = false;

  // Rolling FPS window. Phase 0's exit gate is "acceptable FPS on the demo
  // laptop", so this is instrumentation, not a debug nicety.
  private frames = 0;
  private fpsWindowStart = 0;

  constructor(canvas: HTMLCanvasElement, callbacks: ViewerCallbacks = {}) {
    this.canvas = canvas;
    this.callbacks = callbacks;

    // antialias must stay false: MSAA does nothing for Gaussian splats and
    // costs a large amount of fill rate. This is Spark's documented setting.
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    this.camera.position.set(0, 1.6, 3);

    this.spark = new SparkRenderer({ renderer: this.renderer });
    this.scene.add(this.spark);

    // Free-fly camera so a freshly generated world can be inspected at all.
    // Phase 1 replaces this with pointer-lock WASD + reset-to-photographer.
    this.controls = new SparkControls({ canvas });

    this.placeholder = buildPlaceholder();
    this.scene.add(this.placeholder);

    this.resize();
    this.callbacks.onStatus?.({ kind: "empty" });
  }

  start() {
    if (this.frameHandle || this.disposed) return;
    this.fpsWindowStart = performance.now();
    const tick = () => {
      this.frameHandle = requestAnimationFrame(tick);
      this.controls.update(this.camera);
      this.renderer.render(this.scene, this.camera);
      this.sampleFps();
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

  /** Loads a Marble export (.ply / .spz / .splat) and swaps out the previous world. */
  async load(world: World) {
    this.clearSplat();
    this.callbacks.onStatus?.({ kind: "loading", world, progress: 0 });

    const splat = new SplatMesh({
      url: world.splatUrl,
      onProgress: (event) => {
        const progress = event.lengthComputable ? event.loaded / event.total : 0;
        this.callbacks.onStatus?.({ kind: "loading", world, progress });
      },
    });

    // Marble and most PLY exporters use a Y-down convention relative to
    // Three.js. This quaternion is a 180-degree roll about X that puts the
    // world right side up; flip it off per-world if an export comes in upright.
    if (world.flipY !== false) splat.quaternion.set(1, 0, 0, 0);
    if (world.position) splat.position.fromArray(world.position);
    if (world.scale) splat.scale.setScalar(world.scale);

    this.splat = splat;
    this.scene.add(splat);

    try {
      await splat.initialized;
      if (this.disposed || this.splat !== splat) return;
      this.placeholder.visible = false;
      this.callbacks.onStatus?.({ kind: "ready", world, splats: splat.numSplats });
    } catch (error) {
      if (this.disposed || this.splat !== splat) return;
      this.clearSplat();
      this.callbacks.onStatus?.({
        kind: "error",
        world,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  dispose() {
    this.disposed = true;
    this.stop();
    this.clearSplat();
    this.renderer.dispose();
  }

  private clearSplat() {
    if (!this.splat) return;
    this.scene.remove(this.splat);
    this.splat.dispose();
    this.splat = null;
    this.placeholder.visible = true;
  }

  private sampleFps() {
    this.frames += 1;
    const now = performance.now();
    const elapsed = now - this.fpsWindowStart;
    if (elapsed < 500) return;
    this.callbacks.onFps?.(Math.round((this.frames * 1000) / elapsed));
    this.frames = 0;
    this.fpsWindowStart = now;
  }
}

/** Something to look at before a world is loaded, so a blank scene is still verifiable. */
function buildPlaceholder(): THREE.Group {
  const group = new THREE.Group();
  const grid = new THREE.GridHelper(20, 20, 0x5a4a3a, 0x2a2420);
  group.add(grid, new THREE.AxesHelper(1));
  return group;
}
