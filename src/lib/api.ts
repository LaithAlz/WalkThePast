/** Client for the in-app Marble bridge (server/marble.ts). */
import type { PreppedImage } from "./prep";

export type MarbleModel = "marble-1.0-draft" | "marble-1.1" | "marble-1.1-plus";
export type JobStatus = "queued" | "uploading" | "generating" | "downloading" | "ready" | "error";
export type Job = { id: string; name: string; model: MarbleModel; status: JobStatus; stage: string; elapsedS: number; worldId?: string; error?: string; credits?: number };

/** Credit cost per generation (docs.worldlabs.ai/api/pricing), single image, non-pano. */
export const MODEL_CREDITS: Record<MarbleModel, string> = { "marble-1.0-draft": "230", "marble-1.1": "1 580", "marble-1.1-plus": "1 580–3 080" };

export async function getCredits(): Promise<number | null> {
  try {
    const r = await fetch("/api/credits");
    if (!r.ok) return null;
    return (await r.json()).remaining_credits ?? null;
  } catch {
    return null;
  }
}

export async function generateWorld(input: { name: string; text?: string; model: MarbleModel; images: PreppedImage[] }): Promise<string> {
  const r = await fetch("/api/worlds/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: input.name, text: input.text, model: input.model, images: input.images.map((i) => ({ name: i.name, mime: i.mime, dataBase64: i.dataBase64 })) }),
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
