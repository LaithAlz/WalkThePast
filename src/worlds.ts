/**
 * Registry of hero worlds. Phase 0 fills this in as Marble exports land.
 *
 * Splat files live in `public/worlds/` and are served at `/worlds/<file>`.
 * They are gitignored (they are hundreds of MB) — see public/worlds/README.md.
 */
export type World = {
  id: string;
  title: string;
  /** Path or URL to the Marble export (.ply, .spz, .splat). */
  splatUrl: string;
  /** The historical photograph this world was generated from. */
  sourcePhotoUrl?: string;
  year?: string;
  /** Most PLY exports need a 180-degree roll about X. Set false if one arrives upright. */
  flipY?: boolean;
  position?: [number, number, number];
  scale?: number;
};

export const WORLDS: World[] = [
  // Phase 0 drops the first Marble export in here, e.g.
  // {
  //   id: "hero-1",
  //   title: "<place>, <year>",
  //   splatUrl: "/worlds/hero-1.spz",
  //   sourcePhotoUrl: "/sources/hero-1.jpg",
  // },
];

/**
 * Lets anyone test an arbitrary splat without editing code:
 *   http://localhost:5173/?splat=/worlds/whatever.ply
 *   http://localhost:5173/?splat=https://sparkjs.dev/assets/splats/butterfly.spz
 */
export function worldFromQuery(search: string): World | null {
  const splatUrl = new URLSearchParams(search).get("splat");
  if (!splatUrl) return null;
  return { id: "query", title: splatUrl.split("/").pop() ?? splatUrl, splatUrl };
}
