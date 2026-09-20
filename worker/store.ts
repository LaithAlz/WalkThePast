/**
 * Job records in a Durable Object (see jobs.ts for why not KV), the world index in R2.
 *
 * The index lives in R2 so that GET /worlds/index.json is served from the same bucket as
 * the worlds it lists — one source of truth, and the client contract in src/lib/api.ts is
 * unchanged.
 */
import { EXPECTED_S } from "../server/marbleClient.ts";
import type { Env, JobRecord, WorldIndexEntry } from "./types.ts";

const INDEX_KEY = "index.json";

/** Every job lives in one Durable Object, so a poll always sees the Workflow's last write. */
const store = (env: Env) => env.JOB_STORE.get(env.JOB_STORE.idFromName("jobs"));

export async function putJob(env: Env, job: JobRecord): Promise<void> {
  await store(env).put(job);
}

export async function getJob(env: Env, id: string): Promise<JobRecord | null> {
  return await store(env).get(id);
}

export async function listJobs(env: Env): Promise<JobRecord[]> {
  return await store(env).list();
}

export async function deleteJob(env: Env, id: string): Promise<boolean> {
  return await store(env).delete(id);
}

export async function readIndex(env: Env): Promise<WorldIndexEntry[]> {
  const o = await env.WORLDS.get(INDEX_KEY);
  if (!o) return [];
  try {
    return (await o.json()) as WorldIndexEntry[];
  } catch {
    return [];
  }
}

export async function writeIndex(env: Env, index: WorldIndexEntry[]): Promise<void> {
  await env.WORLDS.put(INDEX_KEY, JSON.stringify(index, null, 2), { httpMetadata: { contentType: "application/json" } });
}

/** Same ramp the Vite bridge used, so the library's progress bar behaves identically. */
function progressOf(job: JobRecord): number {
  const inStage = (Date.now() - job.stageAt) / 1000;
  const ramp = (from: number, to: number, typicalS: number) => from + (to - from) * Math.min(1, inStage / typicalS);
  switch (job.status) {
    case "queued": return 2;
    case "guide": return ramp(3, 10, 15);
    case "painting": return ramp(10, 25, 60);
    case "uploading": return ramp(26, 30, 45);
    case "generating": return Math.min(95, ramp(30, 96, EXPECTED_S[job.model] ?? 330));
    case "downloading": return 97;
    default: return 100;
  }
}

/** The shape src/lib/api.ts expects from /api/worlds/jobs. */
export function publicJob(job: JobRecord) {
  const { imageKey, imageMime: _mime, ...rest } = job;
  return {
    ...rest,
    hasImage: !!imageKey,
    progress: Math.round(progressOf(job)),
    elapsedS: Math.round((Date.now() - job.startedAt) / 1000),
  };
}

/**
 * A Workflow can stop without its own catch running — terminated by an operator, or lost
 * before the handler recorded a failure. The stored record would then read "generating"
 * for the rest of its day, which is indistinguishable from a healthy long generation.
 * So for any job that is not already finished, trust the engine over the record.
 */
export async function reconcile(env: Env, job: JobRecord): Promise<JobRecord> {
  if (job.status === "ready" || job.status === "error") return job;
  try {
    const { status } = await (await env.MARBLE_PIPELINE.get(job.id)).status();
    if (status === "errored" || status === "terminated") {
      return { ...job, status: "error", stage: "failed", error: job.error ?? `generation ${status}` };
    }
  } catch {
    // the instance is gone entirely; leave the record alone rather than invent a verdict
  }
  return job;
}
