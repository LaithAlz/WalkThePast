/**
 * "Imagine the other angles": given the photograph, ask an image model for what the
 * photographer would have seen turning right, around, and left. Those views feed
 * Marble's multi-image prompt by azimuth (0 = the photograph, 90 right, 180 back, 270 left).
 *
 * They are NOT evidence. The provenance layer keeps the original photograph as the only
 * source camera, so everything these views contribute lands in the imagined class.
 *
 * World guide (the two upload flows): OpenAI writes a Marble-style "world guide", a long description of the whole
 * scene including what lies outside the frame, from the photograph and/or a brief description. With no photograph,
 * OpenAI also paints one from the guide. Marble gets the guide as text_prompt with recaptioning off.
 *
 *   POST /api/views/guide     { image?:{mime,dataBase64}, description? } -> { guide }
 *   POST /api/views/image     { prompt } -> { mime, dataBase64 }
 *
 *   GET  /api/views/provider  -> { provider: "gemini" | "openai" | null }
 *   POST /api/views/generate  { image:{mime,dataBase64}, context?, directions?: ("right"|"back"|"left")[] }
 *                             -> { provider, views:[{ direction, azimuth, mime, dataBase64 }] }
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

type Direction = "right" | "back" | "left";
const AZIMUTH: Record<Direction, number> = { right: 90, back: 180, left: 270 };
const TURN: Record<Direction, string> = {
  right: "turned 90 degrees to the RIGHT",
  back: "turned 180 degrees, looking directly BEHIND the camera",
  left: "turned 90 degrees to the LEFT",
};

function prompt(direction: Direction, context?: string): string {
  const what = context?.trim() ? `This photograph shows ${context.trim()}.` : "This is a historical photograph.";
  return `${what} Generate the photograph the same photographer would have taken from the exact same spot, at the same moment, ${TURN[direction]}. Keep the same era, architecture style, street level viewpoint, horizon height, lens, weather, lighting, film grain, tonality and colour treatment as the original so the two images join seamlessly at the edges. Photorealistic, no people looking at the camera, no text, no border, no caption.`;
}

const GUIDE_STYLE = `The scene is a highly realistic portrayal of an abandoned, sand-filled room, exuding a sense of mystery and desolation. The overall tone is one of stark neglect and decay, amplified by the dusty environment and worn machinery. The room is enclosed by rough-hewn brick walls, a portion of which has crumbled away, revealing a more uneven, earthen texture beneath. The ceiling, also constructed from similar bricks, suggests a subterranean or deeply embedded structure. A series of small, rectangular openings high on one wall allows shafts of bright, golden light to penetrate the gloom. The floor is entirely covered in fine sand, forming dunes that partially engulf discarded machinery. On the right side of the room, a tall server rack stands amidst the sand. To the left, several industrial machines lie partially buried. A lone wooden chair stands in the center of the room, facing the wall with the light-emitting openings. The brick walls extend around the entire perimeter, and the sand dunes undulate consistently across the floor, suggesting a uniform environment outside the visible area.`;

/** A Marble world guide from a photograph and/or a brief description (OpenAI, vision when a photograph is given). */
export async function worldGuide(key: string, image: { mime: string; dataBase64: string } | undefined, description: string | undefined): Promise<string> {
  const model = process.env.OPENAI_TEXT_MODEL || "gpt-5.4-mini";
  const task = image
    ? `Write the world guide for this photograph${description?.trim() ? `. The user says: "${description.trim()}"` : ""}. Describe what the photograph shows and then, consistently with it, what lies outside the frame: behind the camera, to the left, to the right, above and beyond what is visible, so a 3D model can build the whole surroundings.`
    : `Write the world guide for this scene: "${description?.trim()}". Invent a specific, coherent, realistic place that matches it, and describe it all the way around the viewer.`;
  const content: Record<string, unknown>[] = [{ type: "text", text: task }];
  if (image) content.push({ type: "image_url", image_url: { url: `data:${image.mime};base64,${image.dataBase64}` } });
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: `You write "world guides" for a 3D world generator: one paragraph of 250 to 350 words of present-tense prose that tells the model what to generate for the whole scene, especially the parts not shown in the input image. Start with "The scene is ..." and state the style and tone; then the enclosing structure (walls, ceiling or sky, floor or ground); then what stands to the left, to the right, behind the viewer and in the distance, with materials, lighting, objects, people and their clothing where relevant; end with what continues beyond the visible area. Everything must be consistent with the photograph when one is given. No headings, no lists, no mention of the photograph, the camera, the viewer's position or uncertainty. Match this style exactly:\n\n${GUIDE_STYLE}` },
        { role: "user", content },
      ],
    }),
  });
  const body = (await r.json()) as { error?: { message?: string }; choices?: { message?: { content?: string } }[] };
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${body.error?.message ?? "request failed"}`);
  const text = body.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("OpenAI returned no world guide");
  return text;
}

/** Paint the photograph for a text-only world: the guide is the prompt (OpenAI gpt-image-1). */
export async function imagineImage(key: string, prompt: string): Promise<{ mime: string; dataBase64: string }> {
  const r = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: process.env.OPENAI_IMAGE_MODEL || "gpt-image-1", prompt: `A photorealistic photograph, eye level, natural perspective, no text, no border, no caption. ${prompt}`.slice(0, 4000), size: "1536x1024", quality: "high", n: 1 }),
  });
  const body = (await r.json()) as { error?: { message?: string }; data?: { b64_json?: string }[] };
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${body.error?.message ?? "request failed"}`);
  const b64 = body.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI returned no image");
  return { mime: "image/png", dataBase64: b64 };
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}
function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store"); // live state: never let the browser reuse an old answer
  res.end(JSON.stringify(body));
}

async function gemini(key: string, mime: string, dataBase64: string, text: string): Promise<{ mime: string; dataBase64: string }> {
  const model = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ inline_data: { mime_type: mime, data: dataBase64 } }, { text }] }],
      generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
    }),
  });
  const body = (await r.json()) as { error?: { message?: string }; candidates?: { content?: { parts?: { inlineData?: { mimeType: string; data: string }; inline_data?: { mime_type: string; data: string } }[] } }[] };
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${body.error?.message ?? "request failed"}`);
  for (const part of body.candidates?.[0]?.content?.parts ?? []) {
    const img = part.inlineData ?? (part.inline_data && { mimeType: part.inline_data.mime_type, data: part.inline_data.data });
    if (img?.data) return { mime: img.mimeType, dataBase64: img.data };
  }
  throw new Error("Gemini returned no image (safety block or text-only answer)");
}

async function openai(key: string, mime: string, dataBase64: string, text: string): Promise<{ mime: string; dataBase64: string }> {
  const form = new FormData();
  form.append("model", process.env.OPENAI_IMAGE_MODEL || "gpt-image-1");
  form.append("prompt", text);
  form.append("size", "1536x1024");
  form.append("quality", "medium");
  form.append("image", new Blob([Buffer.from(dataBase64, "base64")], { type: mime }), mime === "image/png" ? "source.png" : "source.jpg");
  const r = await fetch("https://api.openai.com/v1/images/edits", { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form });
  const body = (await r.json()) as { error?: { message?: string }; data?: { b64_json?: string }[] };
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${body.error?.message ?? "request failed"}`);
  const b64 = body.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI returned no image");
  return { mime: "image/png", dataBase64: b64 };
}

export function viewsApi(opts: { geminiKey?: string; openaiKey?: string; prefer?: string }): Plugin {
  // VIEW_PROVIDER=openai|gemini forces one; otherwise Gemini first, OpenAI as fallback when Gemini errors (quota, safety)
  const order = (["gemini", "openai"] as const).filter((p) => (p === "gemini" ? opts.geminiKey : opts.openaiKey));
  if (opts.prefer && order.includes(opts.prefer as "gemini" | "openai")) order.sort((a) => (a === opts.prefer ? -1 : 1));
  const provider: "gemini" | "openai" | null = order[0] ?? null;
  const handler = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = req.url ?? "";
    if (!url.startsWith("/api/views")) return next();
    try {
      if (req.method === "GET" && url === "/api/views/provider") return send(res, 200, { provider });
      if (req.method === "POST" && (url === "/api/views/guide" || url === "/api/views/image")) {
        if (!opts.openaiKey) return send(res, 503, { error: "OPENAI_API_KEY is not set in .env" });
        if (url === "/api/views/guide") {
          const body = await readJson<{ image?: { mime: string; dataBase64: string }; description?: string }>(req);
          if (!body.image?.dataBase64 && !body.description?.trim()) return send(res, 400, { error: "a photograph or a description is required" });
          return send(res, 200, { guide: await worldGuide(opts.openaiKey, body.image?.dataBase64 ? body.image : undefined, body.description) });
        }
        const body = await readJson<{ prompt?: string }>(req);
        if (!body.prompt?.trim()) return send(res, 400, { error: "prompt required" });
        return send(res, 200, await imagineImage(opts.openaiKey, body.prompt.trim()));
      }
      if (req.method === "POST" && url === "/api/views/generate") {
        if (!provider) return send(res, 503, { error: "No image model key: set GEMINI_API_KEY or OPENAI_API_KEY in .env" });
        const body = await readJson<{ image: { mime: string; dataBase64: string }; context?: string; directions?: Direction[] }>(req);
        const dirs = body.directions?.length ? body.directions : (["right", "back", "left"] as Direction[]);
        const run = async (p: "gemini" | "openai", t: string) =>
          p === "gemini" ? gemini(opts.geminiKey!, body.image.mime, body.image.dataBase64, t) : openai(opts.openaiKey!, body.image.mime, body.image.dataBase64, t);
        const gen = async (t: string): Promise<{ mime: string; dataBase64: string; provider: string }> => {
          let lastErr: unknown = new Error("no provider");
          for (const p of order) {
            try {
              return { ...(await run(p, t)), provider: p };
            } catch (e) {
              lastErr = e;
              console.warn(`[views] ${p} failed: ${e instanceof Error ? e.message.slice(0, 120) : e}`);
            }
          }
          throw lastErr;
        };
        const results = await Promise.allSettled(dirs.map((d) => gen(prompt(d, body.context))));
        const views = results.map((r, i) => ({ direction: dirs[i], azimuth: AZIMUTH[dirs[i]], ...(r.status === "fulfilled" ? r.value : { error: (r.reason as Error).message }) }));
        return send(res, 200, { provider: views.find((v) => "provider" in v && (v as { provider?: string }).provider)?.["provider" as keyof typeof views[0]] ?? provider, views });
      }
      return send(res, 404, { error: "no such route" });
    } catch (e) {
      return send(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  };
  return {
    name: "walk-the-past-views-api",
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}
