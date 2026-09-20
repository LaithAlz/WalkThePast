import type { IncomingMessage, ServerResponse } from "node:http";
import { alignCaptionWords, estimateCaptionWords } from "./captionAlignment.ts";

const MAX_BODY_BYTES = 8_192;
const MAX_TEXT_LENGTH = 1_200;
const MAX_AUDIO_BYTES = 16 * 1_024 * 1_024;

class NarrationError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

type Options = { apiKey?: string; fetchImpl?: typeof fetch; timeoutMs?: number };

function readText(req: IncomingMessage, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    const cleanup = () => {
      req.off("data", data); req.off("end", end); req.off("error", error);
      signal.removeEventListener("abort", abort);
    };
    const fail = (reason: unknown) => { cleanup(); req.resume(); reject(reason); };
    const data = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_BODY_BYTES) fail(new NarrationError(413, "Narration request is too large"));
      else chunks.push(bytes);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks).toString("utf8")); };
    const error = () => fail(new NarrationError(400, "Could not read narration request"));
    const abort = () => fail(signal.reason);
    req.on("data", data); req.once("end", end); req.once("error", error);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
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

function normalizeWav(audio: Buffer): number {
  if (audio.length < 44 || audio.toString("ascii", 0, 4) !== "RIFF" || audio.toString("ascii", 8, 12) !== "WAVE") {
    throw new NarrationError(502, "Narration returned invalid audio");
  }
  const declaredSize = audio.readUInt32LE(4);
  if (declaredSize !== 0xFFFFFFFF && declaredSize !== audio.length - 8) throw new NarrationError(502, "Narration returned truncated audio");
  let byteRate = 0;
  let blockAlign = 0;
  for (let offset = 12; offset + 8 <= audio.length;) {
    const kind = audio.toString("ascii", offset, offset + 4);
    const size = audio.readUInt32LE(offset + 4);
    const content = offset + 8;
    if (kind === "fmt " && size >= 16 && content + size <= audio.length) {
      const format = audio.readUInt16LE(content);
      const channels = audio.readUInt16LE(content + 2);
      const sampleRate = audio.readUInt32LE(content + 4);
      byteRate = audio.readUInt32LE(content + 8);
      blockAlign = audio.readUInt16LE(content + 12);
      const bitsPerSample = audio.readUInt16LE(content + 14);
      if (format !== 1 || channels < 1 || channels > 2 || sampleRate < 8_000 || sampleRate > 192_000
        || ![8, 16, 24, 32].includes(bitsPerSample) || blockAlign !== channels * bitsPerSample / 8
        || byteRate !== sampleRate * blockAlign) throw new NarrationError(502, "Narration returned invalid audio");
    }
    if (kind === "data" && byteRate > 0) {
      const available = audio.length - content;
      if (size !== 0xFFFFFFFF && size > available) throw new NarrationError(502, "Narration returned truncated audio");
      const dataSize = size === 0xFFFFFFFF ? available : size;
      const duration = dataSize / byteRate;
      if (dataSize % blockAlign !== 0) throw new NarrationError(502, "Narration returned truncated audio");
      if (duration > 0 && Number.isFinite(duration)) {
        // TTS may stream UINT32_MAX header sizes. The browser and transcription
        // receive identical, complete WAV bytes with a finite, seekable duration.
        audio.writeUInt32LE(audio.length - 8, 4);
        audio.writeUInt32LE(dataSize, offset + 4);
        return duration;
      }
    }
    offset = content + size + (size % 2);
  }
  throw new NarrationError(502, "Narration returned invalid audio");
}

/** Prepare audio and its observed word boundaries before the browser plays either. */
export function createNarrationHandler({ apiKey, fetchImpl = fetch, timeoutMs = 45_000 }: Options) {
  return async (req: IncomingMessage, res: ServerResponse, next: () => void = () => undefined) => {
    if (req.method !== "POST") { next(); return; }
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const abort = () => controller.abort();
    const close = () => { if (!res.writableEnded) abort(); };
    req.once("aborted", abort);
    res.once("close", close);
    const reply = (status: number, body: unknown) => {
      if (res.destroyed || res.writableEnded) return;
      res.statusCode = status;
      res.end(JSON.stringify(body));
    };
    try {
      if (!apiKey) throw new NarrationError(503, "OPENAI_API_KEY is not configured on the server");
      if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) throw new NarrationError(415, "Narration request must be JSON");
      if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) { req.resume(); throw new NarrationError(413, "Narration request is too large"); }
      let payload: unknown;
      try { payload = JSON.parse(await readText(req, controller.signal)); }
      catch (error) {
        if (error instanceof NarrationError || controller.signal.aborted) throw error;
        throw new NarrationError(400, "Narration request must contain valid JSON");
      }
      const text = payload && typeof payload === "object" && "text" in payload && typeof payload.text === "string" ? payload.text.trim() : "";
      if (!text || text.length > MAX_TEXT_LENGTH || !/[\p{L}\p{N}]/u.test(text)) {
        throw new NarrationError(400, `Narration text must contain between 1 and ${MAX_TEXT_LENGTH} characters`);
      }
      const speech = await fetchImpl("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: "marin", input: text, response_format: "wav",
          instructions: "Read the supplied text verbatim in the measured, confident, engaging voice of an expert museum historian. Use natural narrative cadence and brief pauses between ideas. Do not add or omit words." }),
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
        const timing = await fetchImpl("https://api.openai.com/v1/audio/transcriptions", {
          method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal: controller.signal,
        });
        if (timing.ok) {
          const transcription = await timing.json() as { words?: unknown };
          transcriptionWords = transcription?.words;
        } else {
          // The audio is already complete and playable. Timestamp generation is
          // an enhancement, so an upstream alignment failure must not discard it.
          await timing.body?.cancel().catch(() => undefined);
        }
      } catch (error) {
        // Timeouts and disconnected clients still cancel the entire request.
        // Other transcription failures fall through to duration-based captions.
        if (controller.signal.aborted) throw error;
      }
      let words;
      try { words = alignCaptionWords(text, transcriptionWords, duration); }
      catch { words = estimateCaptionWords(text, transcriptionWords, duration); }
      if (!controller.signal.aborted) reply(200, { audio: audio.toString("base64"), words });
    } catch (error) {
      if (timedOut) reply(504, { error: "Preparing synchronized narration timed out. Please retry." });
      else if (!controller.signal.aborted) reply(error instanceof NarrationError ? error.status : 502,
        { error: error instanceof NarrationError ? error.message : "Could not prepare synchronized narration. Please retry." });
    } finally {
      clearTimeout(timer);
      req.off("aborted", abort);
      res.off("close", close);
    }
  };
}
