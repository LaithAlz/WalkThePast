/** Client for the in-app Marble bridge (server/marble.ts). */
import type { PreppedImage } from "./prep";

export type MarbleModel = "marble-1.0-draft" | "marble-1.1" | "marble-1.1-plus";
export type JobStatus = "queued" | "guide" | "painting" | "uploading" | "generating" | "downloading" | "ready" | "error";
export type Job = { id: string; name: string; model: MarbleModel; status: JobStatus; stage: string; progress: number; elapsedS: number; startedAt: number; hasImage: boolean; worldId?: string; error?: string; credits?: number; guide?: string };

export type WorldIndexEntry = { id: string; name: string; createdAt?: string };
/** Generated worlds on disk, newest first. */
export async function listWorlds(): Promise<WorldIndexEntry[]> {
  const r = await fetch(`/worlds/index.json?t=${Date.now()}`);
  const list = r.ok ? ((await r.json()) as WorldIndexEntry[]) : [];
  return list.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

/** Every generation the server knows about, newest first (they run in the background). */
export async function listJobs(): Promise<Job[]> {
  const r = await fetch("/api/worlds/jobs");
  return r.ok ? ((await r.json()) as Job[]) : [];
}

/** Credit cost per generation (docs.worldlabs.ai/api/pricing), single image, non-pano. */
export const MODEL_CREDITS: Record<MarbleModel, string> = { "marble-1.0-draft": "230", "marble-1.1": "1 580", "marble-1.1-plus": "1 580–3 080" };
/** Multi-image runs cost ~20 credits more (docs.worldlabs.ai/api/pricing). */
export const MULTI_IMAGE_CREDITS: Record<MarbleModel, string> = { "marble-1.0-draft": "250", "marble-1.1": "1 600", "marble-1.1-plus": "1 600–3 100" };

export async function getCredits(): Promise<number | null> {
  try {
    const r = await fetch("/api/credits");
    if (!r.ok) return null;
    return (await r.json()).remaining_credits ?? null;
  } catch {
    return null;
  }
}

export type ViewProvider = "gemini" | "openai" | null;
export type GeneratedView = { direction: "right" | "back" | "left"; azimuth: number; mime?: string; dataBase64?: string; error?: string };

export async function getViewProvider(): Promise<ViewProvider> {
  try {
    const r = await fetch("/api/views/provider");
    return r.ok ? ((await r.json()).provider as ViewProvider) : null;
  } catch {
    return null;
  }
}

/** Ask the image model for the right / back / left views from the photographer's spot. */
export async function generateViews(image: PreppedImage, context?: string, directions?: GeneratedView["direction"][]): Promise<GeneratedView[]> {
  const r = await fetch("/api/views/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ image: { mime: image.mime, dataBase64: image.dataBase64 }, context, directions }),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error ?? `view generation failed (${r.status})`);
  return body.views as GeneratedView[];
}

/** A Marble world guide: what to build for the whole scene, especially outside the frame (OpenAI). */
export async function writeGuide(image: PreppedImage | null, description?: string): Promise<string> {
  const r = await fetch("/api/views/guide", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ image: image ? { mime: image.mime, dataBase64: image.dataBase64 } : undefined, description }) });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error ?? `guide failed (${r.status})`);
  return body.guide as string;
}

/** The photograph for a text-only world, painted from the guide (OpenAI). */
export async function imagineImage(prompt: string): Promise<{ mime: string; dataBase64: string }> {
  const r = await fetch("/api/views/image", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt }) });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error ?? `image failed (${r.status})`);
  return body as { mime: string; dataBase64: string };
}

export type WorldImage = { name: string; mime: string; dataBase64: string; azimuth?: number };

export async function generateWorld(input: { name: string; description?: string; text?: string; model: MarbleModel; images: WorldImage[]; mode?: "single" | "azimuth" | "reconstruct" }): Promise<string> {
  const r = await fetch("/api/worlds/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: input.name, description: input.description, text: input.text, model: input.model, mode: input.mode, images: input.images.map((i) => ({ name: i.name, mime: i.mime, dataBase64: i.dataBase64, azimuth: i.azimuth })) }),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error ?? `generate failed (${r.status})`);
  return body.jobId as string;
}

export async function getJob(jobId: string): Promise<Job> {
  const r = await fetch(`/api/worlds/jobs/${jobId}`);
  if (!r.ok) throw new Error((await r.json()).error ?? "job lookup failed");
  return (await r.json()) as Job;
}

/** Suggested guidance for historical photographs; the user can edit it. */
export function historicalPrompt(place?: string, year?: string): string {
  const where = [place, year].filter(Boolean).join(", ");
  return `A photorealistic reconstruction of ${where || "this historical photograph"} exactly as photographed: keep the composition, architecture, materials and lighting of the photograph faithful, extend the street and buildings beyond the frame in the same period style, no picture frame, no border, no modern objects.`;
}
