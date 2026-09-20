/**
 * The Worker: the API routes that used to exist only inside the Vite dev server
 * (see the note in README under "Voice narration"), plus the world assets, plus the
 * built site. One origin, so the client's relative /api and /worlds paths are unchanged.
 *
 * Worlds live in R2 under <worldId>/..., and /worlds/* streams them back. The viewer's
 * resolveAsset() joins relative manifest paths onto that prefix exactly as it does in dev.
 */
import { Marble } from "../server/marbleClient.ts";
import { worldGuide, imagineImage } from "../server/views.ts";
import { fetchWithRetry } from "../server/retryFetch.ts";
import { narrate } from "./narration.ts";
import { deleteJob, getJob, listJobs, publicJob, putJob, reconcile } from "./store.ts";
import type { Env } from "./types.ts";
import { base64ToBytes } from "./marbleWorkflow.ts";
import { allowedOrigin, preflight, withCors } from "./cors.ts";

export { MarbleWorkflow } from "./marbleWorkflow.ts";
export { JobStore } from "./jobs.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    // The frontend may be served from Vercel, so /api and /worlds are cross-origin.
    const backend = path.startsWith("/api/") || path.startsWith("/worlds/");
    const origin = backend ? allowedOrigin(request, env) : null;
    if (backend && request.method === "OPTIONS") return preflight(request, origin);
    try {
      if (path.startsWith("/api/")) return withCors(await api(request, env, path), origin);
      if (path.startsWith("/worlds/")) return withCors(await serveWorld(env, path), origin);
      return await env.ASSETS.fetch(request);
    } catch (error) {
      console.error("[worker]", path, error instanceof Error ? error.message : error);
      return withCors(json({ error: error instanceof Error ? error.message : "request failed" }, 500), origin);
    }
  },
} satisfies ExportedHandler<Env>;

/** R2 is the filesystem the Vite bridge used to write into. */
async function serveWorld(env: Env, path: string): Promise<Response> {
  const key = decodeURIComponent(path.slice("/worlds/".length));
  if (!key || key.includes("..")) return new Response("not found", { status: 404 });
  const object = await env.WORLDS.get(key);
  if (!object) return new Response("not found", { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  // Worlds are immutable once written; the index changes with every generation.
  headers.set("cache-control", key === "index.json" ? "no-store" : "public, max-age=31536000, immutable");
  return new Response(object.body, { headers });
}

async function api(request: Request, env: Env, path: string): Promise<Response> {
  // --- the voice historian -------------------------------------------------
  if (path === "/api/realtime/session") {
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
    if (!env.OPENAI_API_KEY) return json({ error: "OPENAI_API_KEY is not configured on the server" }, 503);
    const model = env.OPENAI_REALTIME_MODEL || "gpt-realtime-2.1";
    try {
      const r = await fetchWithRetry(fetch, "https://api.openai.com/v1/realtime/client_secrets", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          session: {
            type: "realtime",
            model,
            output_modalities: ["text"],
            audio: {
              input: { transcription: { model: "gpt-4o-mini-transcribe" }, turn_detection: { type: "server_vad", create_response: true, interrupt_response: true } },
              output: { voice: "marin" },
            },
          },
        }),
      }, { attempts: 3, attemptTimeoutMs: 15_000 });
      const body = await r.text();
      return new Response(r.ok ? body : JSON.stringify({ error: "OpenAI session creation failed", status: r.status }),
        { status: r.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    } catch {
      return json({ error: "Unable to reach OpenAI after several attempts. Please try again." }, 502);
    }
  }

  if (path === "/api/realtime/narration") {
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
    return narrate(request, env.OPENAI_API_KEY);
  }

  // --- the world guide and the painted photograph --------------------------
  if (path === "/api/views/provider") {
    return json({ provider: env.VIEW_PROVIDER || (env.OPENAI_API_KEY ? "openai" : env.GEMINI_API_KEY ? "gemini" : "none") });
  }

  if (path === "/api/views/guide" && request.method === "POST") {
    if (!env.OPENAI_API_KEY) return json({ error: "OPENAI_API_KEY is not configured on the server" }, 503);
    const body = (await request.json()) as { image?: { mime: string; dataBase64: string }; description?: string };
    if (!body.image?.dataBase64 && !body.description?.trim()) return json({ error: "a photograph or a description is required" }, 400);
    // key is "guide", matching the Vite bridge and what writeGuide() reads
    return json({ guide: await worldGuide(env.OPENAI_API_KEY, body.image?.dataBase64 ? body.image : undefined, body.description) });
  }

  if (path === "/api/views/image" && request.method === "POST") {
    if (!env.OPENAI_API_KEY) return json({ error: "OPENAI_API_KEY is not configured on the server" }, 503);
    const body = (await request.json()) as { prompt?: string };
    if (!body.prompt?.trim()) return json({ error: "a prompt is required" }, 400);
    return json(await imagineImage(env.OPENAI_API_KEY, body.prompt));
  }

  // --- Marble ---------------------------------------------------------------
  if (path === "/api/credits") {
    if (!env.WORLDLAB_API_KEY) return json({ error: "WORLDLAB_API_KEY is not configured on the server" }, 503);
    return json(await new Marble(env.WORLDLAB_API_KEY).credits());
  }

  if (path === "/api/worlds/generate" && request.method === "POST") {
    return startGeneration(request, env);
  }

  if (path === "/api/worlds/jobs") {
    const jobs = await Promise.all((await listJobs(env)).map((j) => reconcile(env, j)));
    return json(jobs.map(publicJob));
  }

  const jobImage = path.match(/^\/api\/worlds\/jobs\/([\w-]+)\/image$/);
  if (jobImage) {
    const job = await getJob(env, jobImage[1]);
    if (!job?.imageKey) return new Response("not found", { status: 404 });
    const object = await env.WORLDS.get(job.imageKey);
    if (!object) return new Response("not found", { status: 404 });
    return new Response(object.body, { headers: { "content-type": job.imageMime ?? "image/jpeg", "cache-control": "no-store" } });
  }

  const jobOne = path.match(/^\/api\/worlds\/jobs\/([\w-]+)$/);
  if (jobOne && request.method === "DELETE") {
    // Dismissing a card must never abandon a generation that is still paying for itself,
    // so only a job that has already finished can be removed.
    const existing = await getJob(env, jobOne[1]);
    if (!existing) return json({ error: "no such job" }, 404);
    const settled = await reconcile(env, existing);
    if (settled.status !== "ready" && settled.status !== "error") return json({ error: "this generation is still running" }, 409);
    await deleteJob(env, jobOne[1]);
    return json({ dismissed: jobOne[1] });
  }
  if (jobOne) {
    const job = await getJob(env, jobOne[1]);
    return job ? json(publicJob(await reconcile(env, job))) : json({ error: "no such job" }, 404);
  }

  return json({ error: "not found" }, 404);
}

/**
 * Stage the photographs in R2, then hand the Workflow their keys: a Workflow event
 * payload is capped at 1 MiB and an upload is routinely tens of megabytes.
 */
async function startGeneration(request: Request, env: Env): Promise<Response> {
  if (!env.WORLDLAB_API_KEY) return json({ error: "WORLDLAB_API_KEY is not configured on the server" }, 503);
  if (Number(request.headers.get("content-length")) > MAX_UPLOAD_BYTES) return json({ error: "payload too large" }, 413);

  const body = (await request.json()) as {
    name?: string;
    text?: string;
    description?: string;
    model?: string;
    mode?: "single" | "azimuth" | "reconstruct";
    ply?: boolean;
    images?: { name: string; mime: string; dataBase64: string; azimuth?: number }[];
  };
  const images = body.images ?? [];
  if (!images.length && !body.text?.trim() && !body.description?.trim()) {
    return json({ error: "a photograph or a description is required" }, 400);
  }

  const jobId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const name = body.name?.trim() || "Untitled world";
  const model = body.model || "marble-1.1";

  const staged: { key: string; name: string; mime: string; azimuth?: number }[] = [];
  for (const [i, im] of images.entries()) {
    const key = `_staging/${jobId}/${i}`;
    await env.WORLDS.put(key, base64ToBytes(im.dataBase64), { httpMetadata: { contentType: im.mime } });
    staged.push({ key, name: im.name, mime: im.mime, azimuth: im.azimuth });
  }

  await putJob(env, { id: jobId, name, model, status: "queued", stage: "queued", startedAt: Date.now(), stageAt: Date.now(),
    imageKey: staged[0]?.key, imageMime: staged[0]?.mime });

  await env.MARBLE_PIPELINE.create({
    id: jobId,
    params: {
      jobId, name, model,
      mode: body.mode ?? (images.length <= 1 ? "single" : "reconstruct"),
      ply: !!body.ply,
      text: body.text,
      description: body.description,
      images: staged,
    },
  });

  return json({ jobId });
}
