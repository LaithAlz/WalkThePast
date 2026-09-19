/**
 * World manifest: one JSON file per generated world, living at
 * viewer/public/worlds/<id>/world.json. Both the Marble and Lyra pipelines
 * write this shape so the viewer does not care which generator produced it.
 */

/** Coordinate convention of the splat file itself. */
export type Convention =
  /** OpenCV camera frame: +x right, +y down, +z forward (Marble spz/ply, Lyra ply). */
  | "opencv"
  /** Already three.js: +x right, +y up, -z forward. */
  | "threejs";

export interface CameraPose {
  /** three.js world-space position (after convention transform). */
  position: [number, number, number];
  /** three.js world-space quaternion [x, y, z, w]. */
  quaternion: [number, number, number, number];
  /** Vertical field of view in degrees. */
  fovY?: number;
}

export interface WorldManifest {
  id: string;
  name: string;
  generator: "marble" | "lyra" | "other";
  splat: {
    /** Absolute URL or path relative to the manifest directory. */
    url: string;
    convention?: Convention;
    /** Build a level-of-detail tree at load time (recommended for >500k splats). */
    lod?: boolean;
  };
  /** Marble `semantics_metadata`; identity for Lyra. */
  metric?: {
    scaleFactor?: number;
    groundPlaneOffset?: number;
  };
  /** The historical source photograph this world was generated from. */
  source?: {
    image: string;
    width?: number;
    height?: number;
    /** Vertical FOV of the source camera in degrees, if known (Lyra: from MoGe intrinsics). */
    fovY?: number;
  } | null;
  /**
   * Manually aligned photographer pose, exported from the viewer's align tool.
   * When absent the viewer assumes the source camera sits at the splat origin
   * looking down its +z (OpenCV) axis, which is what both generators do.
   */
  sourceCamera?: CameraPose | null;
  notes?: string;
}

export interface WorldIndexEntry {
  id: string;
  name: string;
}

const base = import.meta.env.BASE_URL.replace(/\/$/, "");

export function worldDir(id: string): string {
  return `${base}/worlds/${id}`;
}

export function resolveAsset(id: string, p: string): string {
  if (/^(https?:)?\/\//.test(p) || p.startsWith("/") || p.startsWith("blob:")) return p;
  return `${worldDir(id)}/${p.replace(/^\.\//, "")}`;
}

export async function listWorlds(): Promise<WorldIndexEntry[]> {
  const r = await fetch(`${base}/worlds/index.json`);
  if (!r.ok) return [];
  return (await r.json()) as WorldIndexEntry[];
}

export async function loadManifest(id: string): Promise<WorldManifest> {
  const r = await fetch(`${worldDir(id)}/world.json`);
  if (!r.ok) throw new Error(`world.json for "${id}" not found (${r.status})`);
  const m = (await r.json()) as WorldManifest;
  m.id ||= id;
  m.name ||= id;
  m.splat.url = resolveAsset(id, m.splat.url);
  if (m.source?.image) m.source.image = resolveAsset(id, m.source.image);
  return m;
}
