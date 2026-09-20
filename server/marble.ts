/**
 * Marble API bridge, mounted inside the Vite dev/preview server as /api/*.
 * Keeps WORLDLAB_API_KEY on the server side and turns an uploaded photograph into a
 * world folder under public/worlds/<id>/ that the viewer can load.
 *
 *   POST /api/worlds/generate   { name?, description?, text?, model?, images?:[{name, mime, dataBase64}] }
 *                               -> { jobId }      (no text: the world guide is written here; no images: one is painted)
 *   GET  /api/worlds/jobs       -> [{ id, name, status, stage, progress, elapsedS, worldId?, error?, guide? }]  newest first
 *   GET  /api/worlds/jobs/:id   -> the same for one job
 *   GET  /api/worlds/jobs/:id/image -> the photograph (real or painted) while the job runs
 *   GET  /api/credits           -> { remaining_credits }
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import type { Plugin } from "vite";
import { imagineImage, worldGuide } from "./views.ts";

const API = "https://api.worldlabs.ai/marble/v1";

type JobStatus = "queued" | "guide" | "painting" | "uploading" | "generating" | "downloading" | "ready" | "error";
type Job = {
  id: string;
  name: string;
  model: string;
  status: JobStatus;
  stage: string;
  startedAt: number;
  /** when the current status began: progress within a stage is estimated from this */
  stageAt: number;
  /** the world guide sent to Marble (written here when the client did not send one) */
  guide?: string;
  /** the photograph (real or painted), kept for the library thumbnail while building; not in the jobs list */
  image?: { mime: string; dataBase64: string };
  worldId?: string;
  marbleWorldId?: string;
  operationId?: string;
  credits?: number;
  error?: string;
};

type GenerateBody = {
  name?: string;
  /** the world guide; written from the photograph and/or description when absent */
  text?: string;
  /** the user's brief note about the place */
  description?: string;
  model?: string;
  /** images[0] is always the real photograph (the provenance source). Others may carry an azimuth. Empty: painted from the guide. */
  images: { name: string; mime: string; dataBase64: string; azimuth?: number }[];
  /** azimuth: images placed around the photographer (max 4); reconstruct: overlapping views of one scene (max 8) */
  mode?: "single" | "azimuth" | "reconstruct";
  /** keep the free PLY export too (100+ MB; only needed for offline tooling) */
  ply?: boolean;
};

// Vite restarts the dev server (any .env or config edit) inside the same Node process: the plugin module is
// re-evaluated, but in-flight runJob promises keep running. Keep the table on globalThis so they stay reachable.
const jobs: Map<string, Job> = ((globalThis as { __wtpJobs?: Map<string, Job> }).__wtpJobs ??= new Map());

/** Typical Marble generation time per model, seconds, for the progress estimate. */
const EXPECTED_S: Record<string, number> = { "marble-1.0-draft": 75, "marble-1.1": 330, "marble-1.1-plus": 540 };
function progressOf(job: Job): number {
  const inStage = (Date.now() - job.stageAt) / 1000;
  const ramp = (from: number, to: number, typicalS: number) => from + (to - from) * Math.min(1, inStage / typicalS);
  switch (job.status) {
    case "queued": return 2;
    case "guide": return ramp(3, 10, 15);
    case "painting": return ramp(10, 25, 60);
    case "uploading": return ramp(26, 30, 45);
    case "generating": return Math.min(95, ramp(30, 96, EXPECTED_S[job.model] ?? 330));
    case "downloading": return 97;
    case "ready": return 100;
    case "error": return 100;
  }
}
const publicJob = (job: Job) => {
  const { image, ...rest } = job;
  return { ...rest, hasImage: !!image, progress: Math.round(progressOf(job)), elapsedS: Math.round((Date.now() - job.startedAt) / 1000) };
};

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "world";
}

async function readJson<T>(req: IncomingMessage, limitBytes = 60 * 1024 * 1024): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limitBytes) throw new Error("payload too large");
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

class Marble {
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
    return this.call("GET", `${API}/credits`);
  }
  async uploadImage(name: string, mime: string, bytes: Buffer): Promise<string> {
    const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
    const prep = (await this.call("POST", `${API}/media-assets:prepare_upload`, { file_name: name.slice(0, 64), kind: "image", extension: ext })) as {
      media_asset: { media_asset_id?: string; id?: string };
      upload_info: { upload_url: string; upload_method?: string; required_headers?: Record<string, string> };
    };
    const info = prep.upload_info;
    const put = await fetch(info.upload_url, { method: (info.upload_method || "PUT").toUpperCase(), headers: info.required_headers ?? {}, body: bytes, signal: AbortSignal.timeout(180_000) });
    if (!put.ok) throw new Error(`upload PUT failed ${put.status}`);
    return prep.media_asset.media_asset_id ?? prep.media_asset.id!;
  }
  async generate(body: unknown) {
    return this.call("POST", `${API}/worlds:generate`, body);
  }
  async operation(id: string) {
    return this.call("GET", `${API}/operations/${id}`);
  }
  async exportPly(worldId: string) {
    return this.call("POST", `${API}/worlds/${worldId}:export`, { asset_type: "splats", format: "ply", resolution: "full_res" });
  }
}

async function download(url: string, dest: string) {
  const r = await fetch(url, { signal: AbortSignal.timeout(600_000) });
  if (!r.ok) throw new Error(`download ${url} -> ${r.status}`);
  await fs.writeFile(dest, Buffer.from(await r.arrayBuffer()));
}

async function runJob(job: Job, body: GenerateBody, marble: Marble, worldsDir: string, openaiKey?: string) {
  const t = (stage: string, status: JobStatus = job.status) => {
    job.stage = stage;
    if (status !== job.status) job.stageAt = Date.now();
    job.status = status;
  };
  try {
    // The world guide: what to build for the whole scene. Written here unless the client sent one.
    let guide = body.text?.trim() || undefined;
    if (!guide && (body.images[0] || body.description?.trim())) {
      if (!openaiKey) throw new Error("OPENAI_API_KEY is not set in .env: the world guide needs it");
      t("writing the world guide", "guide");
      guide = await worldGuide(openaiKey, body.images[0] ? { mime: body.images[0].mime, dataBase64: body.images[0].dataBase64 } : undefined, body.description);
    }
    job.guide = guide;
    // No photograph: paint one from the guide.
    if (!body.images.length) {
      if (!guide) throw new Error("a photograph or a description is required");
      if (!openaiKey) throw new Error("OPENAI_API_KEY is not set in .env: painting the photograph needs it");
      t("painting the photograph", "painting");
      const im = await imagineImage(openaiKey, guide);
      body.images = [{ name: "imagined.png", mime: im.mime, dataBase64: im.dataBase64 }];
    }
    job.image = { mime: body.images[0].mime, dataBase64: body.images[0].dataBase64 };
    t("uploading photograph", "uploading");
    const assetIds: string[] = [];
    for (const im of body.images) {
      assetIds.push(await marble.uploadImage(im.name, im.mime, Buffer.from(im.dataBase64, "base64")));
    }
    const text = guide;
    const guidance = text ? { text_prompt: text, disable_recaption: true } : {};
    const mode = body.mode ?? (assetIds.length === 1 ? "single" : "reconstruct");
    const prompt =
      mode === "single" || assetIds.length === 1
        ? { type: "image", image_prompt: { source: "media_asset", media_asset_id: assetIds[0] }, is_pano: "auto", ...guidance }
        : mode === "azimuth"
          ? {
              type: "multi-image",
              multi_image_prompt: assetIds.map((id, i) => ({ azimuth: body.images[i].azimuth ?? 0, content: { source: "media_asset", media_asset_id: id } })),
              reconstruct_images: false,
              ...guidance,
            }
          : {
              type: "multi-image",
              multi_image_prompt: assetIds.map((id) => ({ content: { source: "media_asset", media_asset_id: id } })),
              reconstruct_images: true,
              ...guidance,
            };
    t("generating with Marble (about 5 minutes)", "generating");
    let op = (await marble.generate({
      display_name: job.name.slice(0, 64),
      model: job.model,
      world_prompt: prompt,
      tags: ["walk-the-past", "upload"],
      permission: { public: false },
    })) as { operation_id: string; done?: boolean };
    job.operationId = op.operation_id;
    while (!op.done) {
      await new Promise((r) => setTimeout(r, 6000));
      op = (await marble.operation(job.operationId)) as typeof op & { error?: { message?: string }; response?: Record<string, unknown>; metadata?: { progress?: { status?: string } } };
      const prog = (op as { metadata?: { progress?: { status?: string } } }).metadata?.progress?.status;
      if (prog) t(`Marble: ${prog.toLowerCase().replace(/_/g, " ")}`);
    }
    const done = op as { error?: { message?: string }; response?: Record<string, unknown>; cost?: { total_credits?: number } };
    if (done.error) throw new Error(done.error.message ?? "generation failed");
    job.credits = done.cost?.total_credits;
    const world = done.response as {
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
    job.marbleWorldId = world.world_id ?? world.id;

    t("downloading the world", "downloading");
    const id = `${slug(job.name)}-${job.id.slice(0, 6)}`;
    const dir = path.join(worldsDir, id);
    await fs.mkdir(dir, { recursive: true });
    const spz = world.assets.splats?.spz_urls ?? {};
    const files: Record<string, string> = {};
    for (const tier of ["full_res", "500k", "150k", "100k"]) {
      if (spz[tier]) {
        await download(spz[tier], path.join(dir, `splat_${tier}.spz`));
        files[tier] = `splat_${tier}.spz`;
      }
    }
    if (world.assets.imagery?.pano_url) {
      await download(world.assets.imagery.pano_url, path.join(dir, "pano.png"));
      files.pano = "pano.png";
    }
    if (world.assets.mesh?.collider_mesh_url) {
      await download(world.assets.mesh.collider_mesh_url, path.join(dir, "collider.glb"));
      files.collider = "collider.glb";
    }
    if (body.ply) {
      const ex = (await marble.exportPly(job.marbleWorldId!)) as { response?: { url?: string } };
      if (ex.response?.url) {
        await download(ex.response.url, path.join(dir, "splat_full.ply"));
        files.ply_full = "splat_full.ply";
      }
    }
    // the prepped photograph exactly as Marble saw it: this is the provenance source
    const first = body.images[0];
    const srcName = first.mime === "image/png" ? "source.png" : "source.jpg";
    await fs.writeFile(path.join(dir, srcName), Buffer.from(first.dataBase64, "base64"));
    const meta = world.assets.splats?.semantics_metadata ?? {};
    const manifest = {
      id,
      name: job.name,
      generator: "marble",
      splat: { url: `./${files.full_res ?? files["500k"]}`, convention: "opencv", lod: true },
      metric: { scaleFactor: meta.metric_scale_factor ?? 1, groundPlaneOffset: meta.ground_plane_offset ?? 0 },
      source: { image: `./${srcName}`, fovY: 55 },
      sourceCamera: null,
      pano: files.pano ? { url: "./pano.png", yawDeg: 90 } : null,
      bounds: { radiusM: 3.5 },
      credit: { title: job.name, photographer: "uploaded photograph", licence: "user upload" },
      marble: { world_id: job.marbleWorldId, model: world.model ?? job.model, world_marble_url: world.world_marble_url, files, caption: world.assets.caption, prompt: text ?? null, description: body.description ?? null, painted: srcName === "source.png" && body.images[0].name === "imagined.png", mode, inputImages: body.images.length, azimuths: body.images.map((i) => i.azimuth ?? 0) },
      notes: "Generated through the in-app Marble bridge (server/marble.ts). Align the photographer (R, nudge, L) to make provenance exact.",
    };
    await fs.writeFile(path.join(dir, "world.json"), JSON.stringify(manifest, null, 2));
    await fs.writeFile(path.join(dir, "marble_world.json"), JSON.stringify(world, null, 2));
    const indexPath = path.join(worldsDir, "index.json");
    let index: { id: string; name: string; createdAt?: string }[] = [];
    try {
      index = JSON.parse(await fs.readFile(indexPath, "utf8"));
    } catch {
      /* first world */
    }
    index = [{ id, name: job.name, createdAt: new Date().toISOString() }, ...index.filter((w) => w.id !== id)];
    await fs.writeFile(indexPath, JSON.stringify(index, null, 2));
    job.worldId = id;
    job.image = undefined;
    t("ready", "ready");
  } catch (e) {
    job.error = e instanceof Error ? e.message : String(e);
    t("failed", "error");
    console.error("[marble]", job.id, job.error);
  }
}

export function marbleApi(opts: { apiKey?: string; openaiKey?: string; worldsDir: string }): Plugin {
  const marble = opts.apiKey ? new Marble(opts.apiKey) : null;
  const handler = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = req.url ?? "";
    // Only the bridge's own routes. A bare "/api/" prefix also captured the voice
    // historian's /api/realtime/* endpoints and, because the key check below runs
    // before any route match, 503'd them whenever WORLDLAB_API_KEY was absent.
    if (!/^\/api\/(credits|worlds\/)/.test(url)) return next();
    try {
      if (!marble) return send(res, 503, { error: "WORLDLAB_API_KEY is not set in .env" });
      if (req.method === "GET" && url === "/api/credits") return send(res, 200, await marble.credits());
      if (req.method === "POST" && url === "/api/worlds/generate") {
        const body = await readJson<GenerateBody>(req);
        body.images ??= [];
        if (!body.images.length && !body.description?.trim() && !body.text?.trim()) return send(res, 400, { error: "a photograph or a description is required" });
        const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
        const name = body.name?.trim() || body.description?.trim().split(/[.\n]/)[0].slice(0, 48) || body.images[0]?.name.replace(/\.[^.]+$/, "") || "world";
        const job: Job = { id, name, model: body.model || "marble-1.1", status: "queued", stage: "queued", startedAt: Date.now(), stageAt: Date.now() };
        jobs.set(id, job);
        void runJob(job, body, marble, opts.worldsDir, opts.openaiKey);
        return send(res, 202, { jobId: id });
      }
      const thumb = url.match(/^\/api\/worlds\/jobs\/([a-z0-9]+)\/image$/);
      if (req.method === "GET" && thumb) {
        const job = jobs.get(thumb[1]);
        if (!job?.image) return send(res, 404, { error: "no image yet" });
        res.statusCode = 200;
        res.setHeader("content-type", job.image.mime);
        res.setHeader("cache-control", "private, max-age=3600");
        return res.end(Buffer.from(job.image.dataBase64, "base64"));
      }
      const m = url.match(/^\/api\/worlds\/jobs\/([a-z0-9]+)$/);
      if (req.method === "GET" && m) {
        const job = jobs.get(m[1]);
        if (!job) return send(res, 404, { error: "unknown job" });
        return send(res, 200, publicJob(job));
      }
      if (req.method === "GET" && url === "/api/worlds/jobs") return send(res, 200, [...jobs.values()].map(publicJob).sort((a, b) => b.startedAt - a.startedAt));
      return next(); // other /api/* plugins (views) get their turn
    } catch (e) {
      return send(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  };
  return {
    name: "walk-the-past-marble-api",
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}
