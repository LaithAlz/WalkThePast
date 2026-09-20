/**
 * POST /api/realtime/narration for the Worker.
 *
 * Same contract and same upstream calls as the Vite handler in server/narration.ts —
 * gpt-4o-mini-tts for the audio, whisper-1 for word timestamps — but driven by the
 * Request/Response pair instead of Node streams. The WAV normaliser and the caption
 * aligner are imported rather than re-written, so the two paths cannot disagree about
 * duration or word boundaries. Buffer comes from nodejs_compat (see wrangler.toml).
 */
import { Buffer } from "node:buffer";
import { NarrationError, normalizeWav } from "../server/narration.ts";
import { alignCaptionWords, estimateCaptionWords } from "../server/captionAlignment.ts";

const MAX_BODY_BYTES = 8_192;
const MAX_TEXT_LENGTH = 1_200;
const MAX_AUDIO_BYTES = 16 * 1_024 * 1_024;
const TIMEOUT_MS = 45_000;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function narrate(request: Request, apiKey: string | undefined): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, TIMEOUT_MS);
  try {
    if (!apiKey) throw new NarrationError(503, "OPENAI_API_KEY is not configured on the server");
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      throw new NarrationError(415, "Narration request must be JSON");
    }
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) throw new NarrationError(413, "Narration request is too large");
    let payload: unknown;
    try { payload = JSON.parse(raw); }
    catch { throw new NarrationError(400, "Narration request must contain valid JSON"); }

    const text = payload && typeof payload === "object" && "text" in payload && typeof payload.text === "string" ? payload.text.trim() : "";
    if (!text || text.length > MAX_TEXT_LENGTH || !/[\p{L}\p{N}]/u.test(text)) {
      throw new NarrationError(400, `Narration text must contain between 1 and ${MAX_TEXT_LENGTH} characters`);
    }

    const speech = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: "gpt-4o-mini-tts", voice: "marin", input: text, response_format: "wav",
        instructions: "Read the supplied text verbatim in the measured, confident, engaging voice of an expert museum historian. Use natural narrative cadence and brief pauses between ideas. Do not add or omit words.",
      }),
    });
    if (!speech.ok) { await speech.body?.cancel(); throw new NarrationError(502, "Narration audio generation failed. Please retry."); }

    const audio = await readAudio(speech);
    const duration = normalizeWav(audio);

    const form = new FormData();
    form.append("model", "whisper-1");
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "word");
    form.append("prompt", text);
    form.append("file", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), "narration.wav");

    let transcriptionWords: unknown;
    try {
      const timing = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal: controller.signal,
      });
      if (timing.ok) transcriptionWords = ((await timing.json()) as { words?: unknown })?.words;
      // The audio is already complete and playable. Timestamp generation is an
      // enhancement, so an upstream alignment failure must not discard it.
      else await timing.body?.cancel().catch(() => undefined);
    } catch (error) {
      if (controller.signal.aborted) throw error;
    }

    let words;
    try { words = alignCaptionWords(text, transcriptionWords, duration); }
    catch { words = estimateCaptionWords(text, transcriptionWords, duration); }
    return json({ audio: audio.toString("base64"), words }, 200);
  } catch (error) {
    if (timedOut) return json({ error: "Preparing synchronized narration timed out. Please retry." }, 504);
    return json(
      { error: error instanceof NarrationError ? error.message : "Could not prepare synchronized narration. Please retry." },
      error instanceof NarrationError ? error.status : 502,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function readAudio(response: Response): Promise<Buffer> {
  if (!response.body) throw new NarrationError(502, "Narration audio was empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_AUDIO_BYTES) { await reader.cancel(); throw new NarrationError(502, "Narration audio exceeded its size limit"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
