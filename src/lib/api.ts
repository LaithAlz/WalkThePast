/** Client for the in-app Marble bridge (server/marble.ts). */
import type { PreppedImage } from "./prep";
import { api, worlds, authHeaders } from "./backend";

export type MarbleModel = "marble-1.0-draft" | "marble-1.1" | "marble-1.1-plus";
export type JobStatus = "queued" | "guide" | "painting" | "uploading" | "generating" | "downloading" | "ready" | "error";
export type Job = { id: string; name: string; model: MarbleModel; status: JobStatus; stage: string; progress: number; elapsedS: number; startedAt: number; hasImage: boolean; /** blob URL of the staged photograph, resolved client-side (see jobImage) */ image?: string; worldId?: string; error?: string; credits?: number; guide?: string };

/** `image` is the source file inside the world folder (source.jpg, or source.png for a painted one); older entries lack it. */
export type WorldIndexEntry = { id: string; name: string; createdAt?: string; image?: string };
/** Generated worlds on disk, newest first. */
export async function listWorlds(): Promise<WorldIndexEntry[]> {
  const r = await fetch(worlds(`/worlds/index.json?t=${Date.now()}`), { cache: "no-store" });
  const list = r.ok ? ((await apiJson(r)) as WorldIndexEntry[]) : [];
  // An entry written before the index named the source file (every painted world on the
  // old pipeline) is completed from its manifest, which always has.
  const filled = await Promise.all(list.map(async (w) => (w.image ? w : { ...w, image: await sourceFileOf(w.id) })));
  return filled.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

const sourceFiles = new Map<string, Promise<string>>();
/** The source file named by a world's manifest; "source.jpg" when it cannot be read. */
function sourceFileOf(id: string): Promise<string> {
  let pending = sourceFiles.get(id);
  if (!pending) {
    pending = fetch(worlds(`/worlds/${id}/world.json`))
      .then((r) => (r.ok ? r.json() : null))
      .then((m: { source?: { image?: string } } | null) => m?.source?.image?.replace(/^\.\//, "").split("/").pop() || "source.jpg")
      .catch(() => "source.jpg");
    sourceFiles.set(id, pending);
  }
  return pending;
}

/** Every generation the server knows about, newest first (they run in the background). */
export async function listJobs(): Promise<Job[]> {
  const r = await fetch(api("/api/worlds/jobs"), { headers: await authHeaders(), cache: "no-store" });
  return r.ok ? ((await apiJson(r)) as Job[]) : [];
}

const jobImages = new Map<string, Promise<string | null>>();
/**
 * The photograph behind a building card, as a blob URL. The route sits behind the session
 * like every other job route, and an <img> cannot send the token, so it is fetched here
 * once per job and the URL is reused by every later poll.
 */
export function jobImage(id: string): Promise<string | null> {
  let pending = jobImages.get(id);
  if (!pending) {
    pending = (async () => {
      try {
        const r = await fetch(api(`/api/worlds/jobs/${id}/image`), { headers: await authHeaders(), cache: "no-store" });
        if (!r.ok) throw new Error(`job image ${r.status}`);
        return URL.createObjectURL(await r.blob());
      } catch {
        jobImages.delete(id); // try again on the next poll rather than caching the failure
        return null;
      }
    })();
    jobImages.set(id, pending);
  }
  return pending;
}

/** Credit cost per generation (docs.worldlabs.ai/api/pricing), single image, non-pano. */
export const MODEL_CREDITS: Record<MarbleModel, string> = { "marble-1.0-draft": "230", "marble-1.1": "1 580", "marble-1.1-plus": "1 580–3 080" };
/** Multi-image runs cost ~20 credits more (docs.worldlabs.ai/api/pricing). */
export const MULTI_IMAGE_CREDITS: Record<MarbleModel, string> = { "marble-1.0-draft": "250", "marble-1.1": "1 600", "marble-1.1-plus": "1 600–3 100" };

/** Parse an API response; a non-JSON answer means the API is not deployed behind this origin (e.g. a Vercel rewrite
 *  pointing nowhere), so say that instead of surfacing the JSON parser's message. */
async function apiJson(r: Response): Promise<any> {
  const text = await r.text();
  try { return JSON.parse(text); } catch {
    throw new Error(r.ok ? "The API answered with something that is not JSON." : `The API is not reachable from this site (HTTP ${r.status}). If this is a deployment, the Worker behind /api is not set up yet.`);
  }
}

export async function getCredits(): Promise<number | null> {
  try {
    const r = await fetch(api("/api/credits"), { headers: await authHeaders() });
    if (!r.ok) return null;
    return (await apiJson(r)).remaining_credits ?? null;
  } catch {
    return null;
  }
}

export type ViewProvider = "gemini" | "openai" | null;
export type GeneratedView = { direction: "right" | "back" | "left"; azimuth: number; mime?: string; dataBase64?: string; error?: string };

export async function getViewProvider(): Promise<ViewProvider> {
  try {
    const r = await fetch(api("/api/views/provider"), { headers: await authHeaders() });
    return r.ok ? ((await apiJson(r)).provider as ViewProvider) : null;
  } catch {
    return null;
  }
}

/** Ask the image model for the right / back / left views from the photographer's spot. */
export async function generateViews(image: PreppedImage, context?: string, directions?: GeneratedView["direction"][]): Promise<GeneratedView[]> {
  const r = await fetch(api("/api/views/generate"), {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({ image: { mime: image.mime, dataBase64: image.dataBase64 }, context, directions }),
  });
  const body = await apiJson(r);
  if (!r.ok) throw new Error(body.error ?? `view generation failed (${r.status})`);
  return body.views as GeneratedView[];
}

/** A Marble world guide: what to build for the whole scene, especially outside the frame (OpenAI). */
export async function writeGuide(image: PreppedImage | null, description?: string): Promise<string> {
  const r = await fetch(api("/api/views/guide"), { method: "POST", headers: { "content-type": "application/json", ...(await authHeaders()) }, body: JSON.stringify({ image: image ? { mime: image.mime, dataBase64: image.dataBase64 } : undefined, description }) });
  const body = await apiJson(r);
  if (!r.ok) throw new Error(body.error ?? `guide failed (${r.status})`);
  return body.guide as string;
}

/** The photograph for a text-only world, painted from the guide (OpenAI). */
export async function imagineImage(prompt: string): Promise<{ mime: string; dataBase64: string }> {
  const r = await fetch(api("/api/views/image"), { method: "POST", headers: { "content-type": "application/json", ...(await authHeaders()) }, body: JSON.stringify({ prompt }) });
  const body = await apiJson(r);
  if (!r.ok) throw new Error(body.error ?? `image failed (${r.status})`);
  return body as { mime: string; dataBase64: string };
}

export type WorldImage = { name: string; mime: string; dataBase64: string; azimuth?: number };

export async function generateWorld(input: { name: string; description?: string; text?: string; model: MarbleModel; images: WorldImage[]; mode?: "single" | "azimuth" | "reconstruct" }): Promise<string> {
  const r = await fetch(api("/api/worlds/generate"), {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({ name: input.name, description: input.description, text: input.text, model: input.model, mode: input.mode, images: input.images.map((i) => ({ name: i.name, mime: i.mime, dataBase64: i.dataBase64, azimuth: i.azimuth })) }),
  });
  const body = await apiJson(r);
  if (!r.ok) throw new Error(body.error ?? `generate failed (${r.status})`);
  return body.jobId as string;
}

export async function getJob(jobId: string): Promise<Job> {
  const r = await fetch(api(`/api/worlds/jobs/${jobId}`), { headers: await authHeaders(), cache: "no-store" });
  if (!r.ok) throw new Error((await apiJson(r)).error ?? "job lookup failed");
  return (await apiJson(r)) as Job;
}

/** Suggested guidance for historical photographs; the user can edit it. */
export function historicalPrompt(place?: string, year?: string): string {
  const where = [place, year].filter(Boolean).join(", ");
  return `A photorealistic reconstruction of ${where || "this historical photograph"} exactly as photographed: keep the composition, architecture, materials and lighting of the photograph faithful, extend the street and buildings beyond the frame in the same period style, no picture frame, no border, no modern objects.`;
}

/** Delete a generated world: its folder in R2 and its line in the library index. */
export async function deleteWorld(worldId: string): Promise<void> {
  const r = await fetch(api(`/api/worlds/${encodeURIComponent(worldId)}`), { method: "DELETE", headers: await authHeaders() });
  if (!r.ok) throw new Error((await apiJson(r))?.error ?? `could not delete that world (${r.status})`);
}

/** Take a finished or failed generation off the library shelf. */
export async function dismissJob(jobId: string): Promise<void> {
  const r = await fetch(api(`/api/worlds/jobs/${encodeURIComponent(jobId)}`), { method: "DELETE", headers: await authHeaders() });
  if (!r.ok) throw new Error((await apiJson(r))?.error ?? `could not dismiss that generation (${r.status})`);
}
