/** Bindings declared in wrangler.toml, and the job record the client polls. */
export type JobStatus = "queued" | "guide" | "painting" | "uploading" | "generating" | "downloading" | "ready" | "error";

export type JobRecord = {
  id: string;
  name: string;
  model: string;
  status: JobStatus;
  stage: string;
  startedAt: number;
  /** when the current status began: progress within a stage is estimated from this */
  stageAt: number;
  worldId?: string;
  marbleWorldId?: string;
  credits?: number;
  error?: string;
  /** staged photograph in R2, served as the library thumbnail while the world builds */
  imageKey?: string;
  imageMime?: string;
};

export type WorldIndexEntry = { id: string; name: string; createdAt?: string };

export interface Env {
  /** every world folder: <worldId>/splat_*.spz, pano.png, collider.glb, source.*, world.json, and splat_full.ply when asked for */
  WORLDS: R2Bucket;
  /** job status while a generation runs; the worlds themselves live in R2 */
  JOBS: KVNamespace;
  MARBLE_PIPELINE: Workflow;
  /** the built Vite site */
  ASSETS: Fetcher;

  WORLDLAB_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
  OPENAI_REALTIME_MODEL?: string;
  OPENAI_TEXT_MODEL?: string;
  VIEW_PROVIDER?: string;
}
