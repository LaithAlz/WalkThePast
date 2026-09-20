/**
 * Marble REST client. Runtime-agnostic on purpose: only fetch, no node APIs, so the
 * same client serves the Vite dev bridge (server/marble.ts) and the Worker pipeline
 * (worker/marbleWorkflow.ts). Keep it that way — a second copy would drift.
 */
export const MARBLE_API = "https://api.worldlabs.ai/marble/v1";

export type MarbleWorld = {
  world_id?: string;
  id?: string;
  world_marble_url?: string;
  model?: string;
  assets: {
    splats?: { spz_urls?: Record<string, string>; semantics_metadata?: { metric_scale_factor?: number; ground_plane_offset?: number } };
    imagery?: { pano_url?: string };
    mesh?: { collider_mesh_url?: string };
    caption?: string;
  };
};

export type MarbleOperation = {
  operation_id: string;
  done?: boolean;
  error?: { message?: string };
  response?: Record<string, unknown>;
  cost?: { total_credits?: number };
  metadata?: { progress?: { status?: string } };
};

export class Marble {
  // Explicit field rather than a constructor parameter property: this branch
  // runs tsc with erasableSyntaxOnly so Node can strip types and execute .ts
  // directly for `node --test`.
  private key: string;
  constructor(key: string) { this.key = key; }
  private async call(method: string, url: string, body?: unknown): Promise<Record<string, unknown>> {
    const r = await fetch(url, {
      method,
      headers: { "WLT-Api-Key": this.key, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${url} -> ${r.status} ${text.slice(0, 300)}`);
    return JSON.parse(text);
  }
  async credits() {
    return this.call("GET", `${MARBLE_API}/credits`);
  }
  async uploadImage(name: string, mime: string, bytes: Uint8Array): Promise<string> {
    const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
    const prep = (await this.call("POST", `${MARBLE_API}/media-assets:prepare_upload`, { file_name: name.slice(0, 64), kind: "image", extension: ext })) as {
      media_asset: { media_asset_id?: string; id?: string };
      upload_info: { upload_url: string; upload_method?: string; required_headers?: Record<string, string> };
    };
    const info = prep.upload_info;
    const put = await fetch(info.upload_url, {
      method: (info.upload_method || "PUT").toUpperCase(),
      headers: info.required_headers ?? {},
      // Uint8Array rather than Buffer: Workers has no Buffer without nodejs_compat,
      // and a Buffer is a Uint8Array anyway, so the Node caller is unaffected.
      body: bytes,
      signal: AbortSignal.timeout(180_000),
    });
    if (!put.ok) throw new Error(`upload PUT failed ${put.status}`);
    return prep.media_asset.media_asset_id ?? prep.media_asset.id!;
  }
  async generate(body: unknown) {
    return this.call("POST", `${MARBLE_API}/worlds:generate`, body);
  }
  async operation(id: string) {
    return this.call("GET", `${MARBLE_API}/operations/${id}`);
  }
  async exportPly(worldId: string) {
    return this.call("POST", `${MARBLE_API}/worlds/${worldId}:export`, { asset_type: "splats", format: "ply", resolution: "full_res" });
  }
}

/** The world_prompt Marble expects, given the uploaded asset ids and how they relate. */
export function worldPrompt(
  assetIds: string[],
  mode: "single" | "azimuth" | "reconstruct",
  azimuths: number[],
  guide: string | undefined,
): Record<string, unknown> {
  const guidance = guide ? { text_prompt: guide, disable_recaption: true } : {};
  if (mode === "single" || assetIds.length === 1) {
    return { type: "image", image_prompt: { source: "media_asset", media_asset_id: assetIds[0] }, is_pano: "auto", ...guidance };
  }
  if (mode === "azimuth") {
    return {
      type: "multi-image",
      multi_image_prompt: assetIds.map((id, i) => ({ azimuth: azimuths[i] ?? 0, content: { source: "media_asset", media_asset_id: id } })),
      reconstruct_images: false,
      ...guidance,
    };
  }
  return {
    type: "multi-image",
    multi_image_prompt: assetIds.map((id) => ({ content: { source: "media_asset", media_asset_id: id } })),
    reconstruct_images: true,
    ...guidance,
  };
}

/** Typical Marble generation time per model, seconds, for the progress estimate. */
export const EXPECTED_S: Record<string, number> = { "marble-1.0-draft": 75, "marble-1.1": 330, "marble-1.1-plus": 540 };

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "world";
}
