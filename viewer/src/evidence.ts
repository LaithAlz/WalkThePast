/**
 * Evidence rendering for Phase 2.
 *  - per-splat class lives in an RgbaArray on the GPU; a dyno object modifier tints
 *    each Gaussian from it (no per-frame CPU work)
 *  - Exploration mode: source-visible splats stay natural; inferred/unsupported ones
 *    desaturate and dim as the viewer leaves observed space (`shift` uniform 0..1)
 *  - Evidence mode: green / amber / purple, plus the historical camera frustum
 */
import * as THREE from "three";
import { RgbaArray, SplatMesh, dyno, readRgbaArray } from "@sparkjsdev/spark";
import { CLASS_COLORS, type ProvenanceResult, type SourceCamera } from "./provenance";

// biome-ignore lint: dyno's generic helper types are too strict to compose readably; we build the block untyped.
const D = dyno as unknown as Record<string, (...a: unknown[]) => unknown>;

function v3(hex: string): THREE.Vector3 {
  const c = new THREE.Color(hex);
  return new THREE.Vector3(c.r, c.g, c.b);
}

export class EvidenceLayer {
  readonly rgba = new RgbaArray();
  /** 0 = exploration, 1 = evidence colours */
  readonly modeU = dyno.dynoFloat(0);
  /** 0..1 how far the viewer has left observed space (exploration mode only) */
  readonly shiftU = dyno.dynoFloat(0);
  private mesh: SplatMesh | null = null;
  readonly frustum = new THREE.Group();

  constructor() {
    this.frustum.visible = false;
  }

  /** Upload classes and install the tint modifier on the mesh. */
  attach(mesh: SplatMesh, res: ProvenanceResult) {
    this.mesh = mesh;
    const n = res.classes.length;
    const arr = this.rgba.ensureCapacity(n);
    for (let i = 0; i < n; i++) {
      arr[i * 4] = res.classes[i] * 127; // 0, 127, 254 -> 0, ~0.5, ~1.0 in the shader
      arr[i * 4 + 1] = 0;
      arr[i * 4 + 2] = 0;
      arr[i * 4 + 3] = 255;
    }
    this.rgba.count = n;
    this.rgba.needsUpdate = true;

    const green = D.dynoConst("vec3", v3(CLASS_COLORS[2]));
    const amber = D.dynoConst("vec3", v3(CLASS_COLORS[1]));
    const purple = D.dynoConst("vec3", v3(CLASS_COLORS[0]));
    const lumW = D.dynoConst("vec3", new THREE.Vector3(0.299, 0.587, 0.114));
    const f = (x: number) => D.dynoConst("float", x);
    const rgbaDyno = this.rgba.dyno;
    const modeU = this.modeU, shiftU = this.shiftU;

    mesh.objectModifier = D.dynoBlock(
      { gsplat: dyno.Gsplat },
      { gsplat: dyno.Gsplat },
      ({ gsplat }: { gsplat?: unknown }) => {
        if (!gsplat) return {};
        // dyno nodes expose their results on `.outputs`
        const s = (D.splitGsplat(gsplat) as { outputs: { index: unknown; rgb: unknown } }).outputs;
        const cls = readRgbaArray(rgbaDyno as never, s.index as never); // already a vec4 value
        const tag = (D.split(cls) as { outputs: { x: unknown } }).outputs.x; // 0 / 0.5 / 1
        const visible = D.smoothstep(f(0.7), f(0.9), tag);
        const inFrame = D.smoothstep(f(0.2), f(0.4), tag);
        const occluded = D.mul(inFrame, D.sub(f(1), visible));
        const unsupported = D.sub(f(1), inFrame);
        const rgb = s.rgb;
        // exploration: fade non-visible splats towards dim grey by `shift`
        const lum = D.dot(rgb, lumW);
        const grey = D.mul(D.vec3(lum), f(0.55));
        const fade = D.mul(D.mul(shiftU, D.sub(f(1), visible)), D.sub(f(1), modeU));
        const explored = D.mix(rgb, grey, D.mul(fade, f(0.7)));
        // evidence: blend towards the class colour
        const classColor = D.add(D.add(D.mul(green, visible), D.mul(amber, occluded)), D.mul(purple, unsupported));
        const evidence = D.mix(explored, classColor, D.mul(modeU, f(0.78)));
        return { gsplat: D.combineGsplat({ gsplat, rgb: evidence }) };
      },
    ) as never;
    mesh.updateGenerator();
  }

  detach() {
    if (this.mesh) {
      this.mesh.objectModifier = undefined;
      this.mesh.updateGenerator();
    }
    this.mesh = null;
  }

  setMode(evidence: boolean) {
    this.modeU.value = evidence ? 1 : 0;
    this.frustum.visible = evidence;
  }

  setShift(k: number) {
    this.shiftU.value = Math.max(0, Math.min(1, k));
  }

  /** Historical camera: frustum lines + the photograph on its image plane, 1 m in front. */
  buildFrustum(cam: SourceCamera, photo: HTMLImageElement | null, far = 2.5) {
    this.frustum.clear();
    const c = new THREE.PerspectiveCamera(cam.fovY, cam.aspect, 0.08, far);
    c.position.copy(cam.position);
    c.quaternion.copy(cam.quaternion);
    c.updateMatrixWorld(true);
    const helper = new THREE.CameraHelper(c);
    (helper.material as THREE.LineBasicMaterial).color.set(0xd8b46a);
    (helper.material as THREE.LineBasicMaterial).transparent = true;
    (helper.material as THREE.LineBasicMaterial).opacity = 0.85;
    this.frustum.add(c, helper);
    if (photo) {
      const tex = new THREE.Texture(photo);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      const dist = 1.0;
      const h = 2 * Math.tan(THREE.MathUtils.degToRad(cam.fovY) / 2) * dist;
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(h * cam.aspect, h),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false }),
      );
      plane.position.set(0, 0, -dist);
      c.add(plane);
    }
  }
}
