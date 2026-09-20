/**
 * The Marble pipeline as a Cloudflare Workflow.
 *
 * Replaces the fire-and-forget runJob() + in-memory Map in server/marble.ts, neither of
 * which survives a Worker isolate. Each stage is a step, so a failure retries from that
 * stage instead of re-running a paid generation.
 *
 * Two platform limits shape this file:
 *   - a step's non-stream return value is capped at 1 MiB, so downloaded splats are
 *     streamed straight into R2 inside the step and only the filename comes back;
 *   - the event payload is capped at 1 MiB, so the uploaded photographs are staged in
 *     R2 by the route handler and this workflow receives only their keys.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { Marble, worldPrompt, slug, type MarbleOperation, type MarbleWorld } from "../server/marbleClient.ts";
import { buildManifest, SPZ_TIERS } from "../server/worldManifest.ts";
import { worldGuide, imagineImage } from "../server/views.ts";
import type { Env, JobRecord, JobStatus } from "./types.ts";
import { putJob, readIndex, writeIndex } from "./store.ts";

export type MarbleEvent = {
  jobId: string;
  name: string;
  model: string;
  mode: "single" | "azimuth" | "reconstruct";
  ply: boolean;
  text?: string;
  description?: string;
  /** photographs already staged in R2; images[0] is the provenance source */
  images: { key: string; name: string; mime: string; azimuth?: number }[];
};

/** Marble polls every 6s in the Vite bridge; keep the same cadence, with a ceiling so a
 *  stuck operation fails the instance instead of sleeping for a year. */
const POLL_MS = 6_000;
const MAX_POLLS = 400; // 40 minutes

export class MarbleWorkflow extends WorkflowEntrypoint<Env, MarbleEvent> {
  async run(event: WorkflowEvent<MarbleEvent>, step: WorkflowStep) {
    const p = event.payload;
    const env = this.env;
    const marble = new Marble(requireKey(env.WORLDLAB_API_KEY, "WORLDLAB_API_KEY"));

    // Job status is reported to the client from KV: a Workflow instance knows it is
    // "running" but not that it is "painting the photograph". `sticky` carries the fields
    // that outlive a single stage, so the library keeps its thumbnail as the job advances.
    const sticky: Partial<JobRecord> = {};
    const mark = (status: JobStatus, stage: string, extra: Partial<JobRecord> = {}) => {
      Object.assign(sticky, extra);
      return putJob(env, { id: p.jobId, name: p.name, model: p.model, status, stage, startedAt: event.timestamp.getTime(), stageAt: Date.now(), ...sticky });
    };

    try {
      // 1. The world guide: what to build for the whole scene. Written here unless the client sent one.
      const guide = await step.do("write the world guide", async () => {
        if (p.text?.trim()) return p.text.trim();
        if (!p.images.length && !p.description?.trim()) return "";
        await mark("guide", "writing the world guide");
        const key = requireKey(env.OPENAI_API_KEY, "OPENAI_API_KEY");
        const first = p.images[0] ? await readStagedImage(env, p.images[0]) : undefined;
        return await worldGuide(key, first, p.description);
      });

      // 2. No photograph: paint one from the guide, and stage it like an upload.
      const images = await step.do("paint the photograph", async () => {
        if (p.images.length) return p.images;
        if (!guide) throw new NonRetryableError("a photograph or a description is required");
        await mark("painting", "painting the photograph");
        const im = await imagineImage(requireKey(env.OPENAI_API_KEY, "OPENAI_API_KEY"), guide);
        const key = `_staging/${p.jobId}/painted.png`;
        await env.WORLDS.put(key, base64ToBytes(im.dataBase64), { httpMetadata: { contentType: im.mime } });
        return [{ key, name: "imagined.png", mime: im.mime }];
      });

      // 3. Hand the photographs to Marble.
      const assetIds = await step.do("upload photographs to Marble", async () => {
        await mark("uploading", "uploading photograph", { imageKey: images[0].key, imageMime: images[0].mime });
        const ids: string[] = [];
        for (const im of images) ids.push(await marble.uploadImage(im.name, im.mime, await readStagedBytes(env, im.key)));
        return ids;
      });

      // 4. Start the generation. Its own step so a retry of the poll never pays twice.
      const operationId = await step.do("start Marble generation", async () => {
        await mark("generating", "generating with Marble (about 5 minutes)");
        const op = (await marble.generate({
          display_name: p.name.slice(0, 64),
          model: p.model,
          world_prompt: worldPrompt(assetIds, p.mode, images.map((i) => i.azimuth ?? 0), guide || undefined),
          tags: ["walk-the-past", "upload"],
          permission: { public: false },
        })) as MarbleOperation;
        return op.operation_id;
      });

      // 5. Poll to completion. step.sleep does not count against the step limit.
      let world: MarbleWorld | undefined;
      let credits: number | undefined;
      for (let i = 0; i < MAX_POLLS; i++) {
        const poll = await step.do(`poll Marble ${i}`, async () => {
          const op = (await marble.operation(operationId)) as MarbleOperation;
          const progress = op.metadata?.progress?.status;
          if (progress) await mark("generating", `Marble: ${progress.toLowerCase().replace(/_/g, " ")}`);
          if (op.error) throw new NonRetryableError(op.error.message ?? "generation failed");
          // A step's return value is serialized, and the world is an open-ended object
          // that Serializable<T> cannot vouch for, so carry it as JSON text. It is
          // metadata — urls and numbers — so it stays far inside the 1 MiB step limit.
          return {
            done: !!op.done,
            worldJson: op.response ? JSON.stringify(op.response) : null,
            credits: op.cost?.total_credits ?? null,
          };
        });
        if (poll.done && poll.worldJson) {
          world = JSON.parse(poll.worldJson) as MarbleWorld;
          credits = poll.credits ?? undefined;
          break;
        }
        await step.sleep(`wait ${i}`, POLL_MS);
      }
      if (!world) throw new NonRetryableError("Marble did not finish in time");

      // 6. Pull the world into R2. One step per asset: a dropped 100 MB splat retries alone.
      const worldId = `${slug(p.name)}-${p.jobId.slice(0, 6)}`;
      const marbleWorldId = world.world_id ?? world.id;
      const files: Record<string, string> = {};
      await mark("downloading", "downloading the world");

      const spz = world.assets.splats?.spz_urls ?? {};
      for (const tier of SPZ_TIERS) {
        if (!spz[tier]) continue;
        files[tier] = await step.do(`store splat ${tier}`, () => stream(env, spz[tier], `${worldId}/splat_${tier}.spz`, "application/octet-stream"));
      }
      if (world.assets.imagery?.pano_url) {
        files.pano = await step.do("store pano", () => stream(env, world!.assets.imagery!.pano_url!, `${worldId}/pano.png`, "image/png"));
      }
      if (world.assets.mesh?.collider_mesh_url) {
        files.collider = await step.do("store collider", () => stream(env, world!.assets.mesh!.collider_mesh_url!, `${worldId}/collider.glb`, "model/gltf-binary"));
      }
      if (p.ply) {
        files.ply_full = await step.do("export and store PLY", async () => {
          const ex = (await marble.exportPly(marbleWorldId!)) as { response?: { url?: string } };
          if (!ex.response?.url) throw new Error("PLY export returned no url");
          return stream(env, ex.response.url, `${worldId}/splat_full.ply`, "application/octet-stream");
        });
      }

      // 7. The provenance source, the manifest, and the library index.
      const sourceName = await step.do("store the source photograph", async () => {
        const first = images[0];
        const name = first.mime === "image/png" ? "source.png" : "source.jpg";
        await env.WORLDS.put(`${worldId}/${name}`, await readStagedBytes(env, first.key), { httpMetadata: { contentType: first.mime } });
        return name;
      });

      await step.do("write the manifest and index", async () => {
        const manifest = buildManifest({
          id: worldId,
          name: p.name,
          model: p.model,
          marbleWorldId,
          world: world!,
          files,
          sourceName,
          guide: guide || undefined,
          description: p.description,
          painted: !p.images.length,
          mode: p.mode,
          inputImages: images.length,
          azimuths: images.map((i) => i.azimuth ?? 0),
        });
        await env.WORLDS.put(`${worldId}/world.json`, JSON.stringify(manifest, null, 2), { httpMetadata: { contentType: "application/json" } });
        await env.WORLDS.put(`${worldId}/marble_world.json`, JSON.stringify(world, null, 2), { httpMetadata: { contentType: "application/json" } });
        const index = await readIndex(env);
        await writeIndex(env, [{ id: worldId, name: p.name, createdAt: new Date().toISOString() }, ...index.filter((w) => w.id !== worldId)]);
      });

      await step.do("clear the staged uploads", async () => {
        for (const im of images) await env.WORLDS.delete(im.key);
      });

      // the staged copy is gone; the library now reads the world's own source image
      await mark("ready", "ready", { worldId, marbleWorldId, credits, imageKey: undefined, imageMime: undefined });
      return { worldId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await mark("error", "failed", { error: message });
      throw error;
    }
  }
}

/** Download straight into R2 so the bytes never become a step return value. */
async function stream(env: Env, url: string, key: string, contentType: string): Promise<string> {
  const r = await fetch(url, { signal: AbortSignal.timeout(600_000) });
  if (!r.ok || !r.body) throw new Error(`download ${key} -> ${r.status}`);
  await env.WORLDS.put(key, r.body, { httpMetadata: { contentType } });
  return key.slice(key.indexOf("/") + 1);
}

async function readStagedBytes(env: Env, key: string): Promise<Uint8Array> {
  const o = await env.WORLDS.get(key);
  if (!o) throw new NonRetryableError(`staged upload ${key} is gone`);
  return new Uint8Array(await o.arrayBuffer());
}

async function readStagedImage(env: Env, im: { key: string; mime: string }) {
  return { mime: im.mime, dataBase64: bytesToBase64(await readStagedBytes(env, im.key)) };
}

function requireKey(value: string | undefined, name: string): string {
  if (!value) throw new NonRetryableError(`${name} is not configured on the Worker`);
  return value;
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  // chunked: String.fromCharCode(...bytes) blows the stack on a multi-MB photograph
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
