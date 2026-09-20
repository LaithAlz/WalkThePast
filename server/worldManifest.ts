/**
 * world.json, the contract src/viewer/world.ts reads. Shared by the Vite bridge and the
 * Worker pipeline so the two cannot produce different manifests for the same world.
 *
 * `splat.url` and friends stay RELATIVE ("./splat_500k.spz"). resolveAsset() in
 * src/viewer/world.ts joins them onto the world directory, and passes absolute URLs
 * through untouched — so the same manifest works whether the folder is served from
 * public/worlds/<id>/ in dev or from R2 through the Worker in production.
 */
import type { MarbleWorld } from "./marbleClient.ts";

/** Splat tiers in preference order; full_res drives walking, the small tiers feed evidence mode. */
export const SPZ_TIERS = ["full_res", "500k", "150k", "100k"] as const;

export type ManifestInput = {
  id: string;
  name: string;
  model: string;
  marbleWorldId?: string;
  world: MarbleWorld;
  /** asset filename by tier/kind, as actually written ("full_res" -> "splat_full_res.spz") */
  files: Record<string, string>;
  sourceName: string;
  guide?: string;
  description?: string;
  painted: boolean;
  mode: string;
  inputImages: number;
  azimuths: number[];
};

export function buildManifest(i: ManifestInput) {
  const meta = i.world.assets.splats?.semantics_metadata ?? {};
  return {
    id: i.id,
    name: i.name,
    generator: "marble",
    splat: { url: `./${i.files.full_res ?? i.files["500k"]}`, convention: "opencv", lod: true },
    metric: { scaleFactor: meta.metric_scale_factor ?? 1, groundPlaneOffset: meta.ground_plane_offset ?? 0 },
    source: { image: `./${i.sourceName}`, fovY: 55 },
    sourceCamera: null,
    pano: i.files.pano ? { url: "./pano.png", yawDeg: 90 } : null,
    bounds: { radiusM: 3.5 },
    credit: { title: i.name, photographer: "uploaded photograph", licence: "user upload" },
    marble: {
      world_id: i.marbleWorldId,
      model: i.world.model ?? i.model,
      world_marble_url: i.world.world_marble_url,
      files: i.files,
      caption: i.world.assets.caption,
      prompt: i.guide ?? null,
      description: i.description ?? null,
      painted: i.painted,
      mode: i.mode,
      inputImages: i.inputImages,
      azimuths: i.azimuths,
    },
    notes: "Generated through the Marble bridge. Align the photographer (R, nudge, L) to make provenance exact.",
  };
}
