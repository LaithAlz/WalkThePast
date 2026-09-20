/**
 * Job state for a running generation.
 *
 * This was KV, and KV is the wrong tool: a write "can take up to 60 seconds to be visible
 * in other parts of the world", and reads are cached for 60s by default. The Workflow
 * writes progress from wherever it runs while the browser polls from wherever the reader
 * is, so the library sat at "QUEUED · 2%" for an entire five-minute generation — which
 * looks exactly like a failed upload.
 *
 * A Durable Object has one instance, so a read always observes the last write. Job volume
 * is tiny (one row per generation, kept a day), so routing every poll to a single object
 * costs a little latency and buys correctness.
 */
import { DurableObject } from "cloudflare:workers";
import type { JobRecord } from "./types.ts";

/** A finished job only needs to outlive the client's next poll. */
const TTL_MS = 24 * 60 * 60 * 1000;

export class JobStore extends DurableObject {
  async put(job: JobRecord): Promise<void> {
    await this.ctx.storage.put(job.id, job);
  }

  async get(id: string): Promise<JobRecord | null> {
    return (await this.ctx.storage.get<JobRecord>(id)) ?? null;
  }

  async delete(id: string): Promise<boolean> {
    return await this.ctx.storage.delete(id);
  }

  /** Newest first, dropping anything past its day. */
  async list(): Promise<JobRecord[]> {
    const all = await this.ctx.storage.list<JobRecord>();
    const cutoff = Date.now() - TTL_MS;
    const live: JobRecord[] = [];
    const stale: string[] = [];
    for (const [key, job] of all) {
      if (job.startedAt < cutoff) stale.push(key);
      else live.push(job);
    }
    if (stale.length) await this.ctx.storage.delete(stale);
    return live.sort((a, b) => b.startedAt - a.startedAt);
  }
}
