/**
 * Job records in KV, the world index in R2.
 *
 * The index lives in R2 rather than KV so that GET /worlds/index.json is served from the
 * same bucket as the worlds it lists — one source of truth, and the client contract in
 * src/lib/api.ts is unchanged.
 */
import { EXPECTED_S } from "../server/marbleClient.ts";
import type { Env, JobRecord, WorldIndexEntry } from "./types.ts";

const JOB_PREFIX = "job:";
const INDEX_KEY = "index.json";
/** a finished job only needs to outlive the client's next poll */
const JOB_TTL_S = 24 * 60 * 60;

export async function putJob(env: Env, job: JobRecord): Promise<void> {
  await env.JOBS.put(JOB_PREFIX + job.id, JSON.stringify(job), { expirationTtl: JOB_TTL_S });
}

export async function getJob(env: Env, id: string): Promise<JobRecord | null> {
  return await env.JOBS.get<JobRecord>(JOB_PREFIX + id, "json");
}

export async function listJobs(env: Env): Promise<JobRecord[]> {
  const listed = await env.JOBS.list({ prefix: JOB_PREFIX });
  const jobs = await Promise.all(listed.keys.map((k) => env.JOBS.get<JobRecord>(k.name, "json")));
  return jobs.filter((j): j is JobRecord => !!j).sort((a, b) => b.startedAt - a.startedAt);
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
