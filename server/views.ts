/**
 * "Imagine the other angles": given the photograph, ask an image model for what the
 * photographer would have seen turning right, around, and left. Those views feed
 * Marble's multi-image prompt by azimuth (0 = the photograph, 90 right, 180 back, 270 left).
 *
 * They are NOT evidence. The provenance layer keeps the original photograph as the only
 * source camera, so everything these views contribute lands in the imagined class.
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

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}
function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
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

export function viewsApi(opts: { geminiKey?: string; openaiKey?: string }): Plugin {
  const provider: "gemini" | "openai" | null = opts.geminiKey ? "gemini" : opts.openaiKey ? "openai" : null;
  const handler = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = req.url ?? "";
    if (!url.startsWith("/api/views")) return next();
    try {
      if (req.method === "GET" && url === "/api/views/provider") return send(res, 200, { provider });
      if (req.method === "POST" && url === "/api/views/generate") {
        if (!provider) return send(res, 503, { error: "No image model key: set GEMINI_API_KEY or OPENAI_API_KEY in .env" });
        const body = await readJson<{ image: { mime: string; dataBase64: string }; context?: string; directions?: Direction[] }>(req);
        const dirs = body.directions?.length ? body.directions : (["right", "back", "left"] as Direction[]);
        const gen = provider === "gemini" ? (t: string) => gemini(opts.geminiKey!, body.image.mime, body.image.dataBase64, t) : (t: string) => openai(opts.openaiKey!, body.image.mime, body.image.dataBase64, t);
        const results = await Promise.allSettled(dirs.map((d) => gen(prompt(d, body.context))));
        const views = results.map((r, i) => ({ direction: dirs[i], azimuth: AZIMUTH[dirs[i]], ...(r.status === "fulfilled" ? r.value : { error: (r.reason as Error).message }) }));
        return send(res, 200, { provider, views });
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
