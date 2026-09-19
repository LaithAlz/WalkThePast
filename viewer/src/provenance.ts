/**
 * Geometric provenance (Phase 2).
 *
 * For every Gaussian: transform it into the historical source camera, project it
 * into the original photograph, compare its depth with the surface the photograph
 * actually shows along that pixel, and classify:
 *
 *   SOURCE_VISIBLE     inside the photo frame and at (or in front of) the visible surface
 *   OCCLUDED_INFERRED  inside the frame but behind the surface the photo shows there
 *   UNSUPPORTED        outside the frame or behind the camera
 *
 * The "visible source depth" is the nearest opaque surface of the generated world
 * as seen from the photographer's pose: the generator reproduces the photograph from
 * that pose, so its front surface there *is* what the photograph observed. Everything
 * here is pure math on typed arrays so it can be unit-tested without a GPU.
 */
import * as THREE from "three";

export const CLASS_UNSUPPORTED = 0;
export const CLASS_OCCLUDED = 1;
export const CLASS_VISIBLE = 2;
export type ClassId = 0 | 1 | 2;
export const CLASS_NAMES = ["UNSUPPORTED", "OCCLUDED_INFERRED", "SOURCE_VISIBLE"] as const;
export const CLASS_COLORS = ["#a96bff", "#f2b134", "#3ddc84"] as const; // purple, amber, green

export interface SourceCamera {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  /** vertical field of view, degrees */
  fovY: number;
  /** image width / height */
  aspect: number;
}

export interface ProvenanceOptions {
  /** depth-map width in pixels (height follows the aspect) */
  width?: number;
  /** Gaussians below this opacity do not write the depth map (floaters, haze) */
  opacityMin?: number;
  /** relative depth tolerance: a Gaussian this far behind the surface still counts as visible */
  relTol?: number;
  /** absolute tolerance in world units, added to `scaleTol * maxScale` */
  absTol?: number;
  scaleTol?: number;
  near?: number;
}

export interface ProvenanceResult {
  classes: Uint8Array;
  counts: [number, number, number];
  /** per-splat photo coordinates in [0,1] (NaN when behind the camera) and depth along the view axis */
  uv: Float32Array;
  depth: Float32Array;
  /** depth map from the source camera: Infinity where nothing opaque was seen */
  depthMap: Float32Array;
  width: number;
  height: number;
  cam: SourceCamera;
  view: THREE.Matrix4;
  tanHalfX: number;
  tanHalfY: number;
  opts: Required<ProvenanceOptions>;
}

export interface PointVerdict {
  cls: ClassId;
  u: number;
  v: number;
  depth: number;
  surfaceDepth: number;
  reason: string;
}

const DEFAULTS: Required<ProvenanceOptions> = {
  width: 768,
  opacityMin: 0.45,
  relTol: 0.04,
  absTol: 0.03,
  scaleTol: 1.5,
  near: 0.02,
};

export function makeSourceCamera(position: ArrayLike<number>, quaternion: ArrayLike<number>, fovY: number, aspect: number): SourceCamera {
  return {
    position: new THREE.Vector3().fromArray(position as number[]),
    quaternion: new THREE.Quaternion().fromArray(quaternion as number[]),
    fovY,
    aspect,
  };
}

function viewMatrix(cam: SourceCamera): THREE.Matrix4 {
  const world = new THREE.Matrix4().compose(cam.position, cam.quaternion, new THREE.Vector3(1, 1, 1));
  return world.invert();
}

/**
 * @param positions  N*3 world-space centres
 * @param maxScales  N   largest axis scale per Gaussian, world units
 * @param opacities  N   0..1
 */
export function computeProvenance(
  positions: Float32Array,
  maxScales: Float32Array,
  opacities: Float32Array,
  cam: SourceCamera,
  options: ProvenanceOptions = {},
): ProvenanceResult {
  const opts = { ...DEFAULTS };
  for (const [k, v] of Object.entries(options)) if (v !== undefined) (opts as Record<string, number>)[k] = v as number;
  const n = maxScales.length;
  const W = opts.width;
  const H = Math.max(1, Math.round(W / cam.aspect));
  const tanHalfY = Math.tan(THREE.MathUtils.degToRad(cam.fovY) / 2);
  const tanHalfX = tanHalfY * cam.aspect;
  const view = viewMatrix(cam);
  const e = view.elements;

  const uv = new Float32Array(n * 2);
  const depth = new Float32Array(n);
  const depthMap = new Float32Array(W * H).fill(Infinity);
  const classes = new Uint8Array(n);

  // pass 1: project, and splat opaque Gaussians into a min-depth map
  const pxPerUnitY = H / 2 / tanHalfY;
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    const cx = e[0] * x + e[4] * y + e[8] * z + e[12];
    const cy = e[1] * x + e[5] * y + e[9] * z + e[13];
    const cz = e[2] * x + e[6] * y + e[10] * z + e[14];
    const d = -cz;
    depth[i] = d;
    if (d <= opts.near) {
      uv[i * 2] = NaN;
      uv[i * 2 + 1] = NaN;
      continue;
    }
    const u = (cx / (d * tanHalfX) + 1) / 2;
    const v = (1 - cy / (d * tanHalfY)) / 2;
    uv[i * 2] = u;
    uv[i * 2 + 1] = v;
    if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
    if (opacities[i] < opts.opacityMin) continue;
    const px = (u * W) | 0, py = (v * H) | 0;
    const rPx = Math.min(3, Math.max(0, Math.round((maxScales[i] / d) * pxPerUnitY)));
    if (rPx === 0) {
      const k = py * W + px;
      if (d < depthMap[k]) depthMap[k] = d;
    } else {
      for (let yy = Math.max(0, py - rPx); yy <= Math.min(H - 1, py + rPx); yy++) {
        for (let xx = Math.max(0, px - rPx); xx <= Math.min(W - 1, px + rPx); xx++) {
          const k = yy * W + xx;
          if (d < depthMap[k]) depthMap[k] = d;
        }
      }
    }
  }

  // pass 2: classify against the visible surface
  const counts: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const u = uv[i * 2], v = uv[i * 2 + 1];
    let c: ClassId = CLASS_UNSUPPORTED;
    if (!Number.isNaN(u) && u >= 0 && u < 1 && v >= 0 && v < 1) {
      const D = depthMap[((v * H) | 0) * W + ((u * W) | 0)];
      const tol = opts.relTol * D + opts.scaleTol * maxScales[i] + opts.absTol;
      c = D === Infinity || depth[i] <= D + tol ? CLASS_VISIBLE : CLASS_OCCLUDED;
    }
    classes[i] = c;
    counts[c]++;
  }

  return { classes, counts, uv, depth, depthMap, width: W, height: H, cam, view, tanHalfX, tanHalfY, opts };
}

/** Classify an arbitrary world-space point (e.g. a raycast hit) with the same rule, and say why. */
export function classifyPoint(res: ProvenanceResult, p: THREE.Vector3, scale = 0): PointVerdict {
  const e = res.view.elements;
  const cx = e[0] * p.x + e[4] * p.y + e[8] * p.z + e[12];
  const cy = e[1] * p.x + e[5] * p.y + e[9] * p.z + e[13];
  const cz = e[2] * p.x + e[6] * p.y + e[10] * p.z + e[14];
  const d = -cz;
  if (d <= res.opts.near) {
    return { cls: CLASS_UNSUPPORTED, u: NaN, v: NaN, depth: d, surfaceDepth: NaN, reason: "This lies behind the historical camera: the photograph could not have recorded it." };
  }
  const u = (cx / (d * res.tanHalfX) + 1) / 2;
  const v = (1 - cy / (d * res.tanHalfY)) / 2;
  const px = Math.round(u * 100), py = Math.round(v * 100);
  if (u < 0 || u >= 1 || v < 0 || v >= 1) {
    const side = u < 0 ? "left of" : u >= 1 ? "right of" : v < 0 ? "above" : "below";
    return { cls: CLASS_UNSUPPORTED, u, v, depth: d, surfaceDepth: NaN, reason: `This falls ${side} the photograph's frame (${px}%, ${py}%): nothing in the source shows it. It is generated.` };
  }
  const D = res.depthMap[((v * res.height) | 0) * res.width + ((u * res.width) | 0)];
  const tol = res.opts.relTol * D + res.opts.scaleTol * scale + res.opts.absTol;
  if (D === Infinity || d <= D + tol) {
    return { cls: CLASS_VISIBLE, u, v, depth: d, surfaceDepth: D, reason: `This projects to (${px}%, ${py}%) of the photograph at ${d.toFixed(2)} m, on the surface the photograph shows there (${D === Infinity ? "nearest" : D.toFixed(2) + " m"}). The source observed it.` };
  }
  return { cls: CLASS_OCCLUDED, u, v, depth: d, surfaceDepth: D, reason: `This projects to (${px}%, ${py}%) of the photograph but sits ${(d - D).toFixed(2)} m behind the surface the photo shows there (${D.toFixed(2)} m). The photograph could not see it: it is inferred.` };
}
