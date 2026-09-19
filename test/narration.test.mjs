import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createNarrationHandler } from "../server/narration.ts";
import { alignCaptionWords } from "../server/captionAlignment.ts";

const word = (text, start, end = start + 0.2) => ({ word: text, start, end });
const wav = (seconds = 5) => {
  const bytes = Buffer.alloc(44 + seconds * 48_000);
  bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVE", 8);
  bytes.write("fmt ", 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24_000, 24); bytes.writeUInt32LE(48_000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
};

function request(body, options = {}) {
  const req = new PassThrough();
  req.method = "POST";
  req.headers = { "content-type": "application/json", ...options.headers };
  const res = new EventEmitter();
  res.headers = {};
  res.setHeader = (name, value) => { res.headers[name] = value; };
  res.end = (value) => { res.body = JSON.parse(value); res.writableEnded = true; };
  const complete = createNarrationHandler({ apiKey: "test-secret", ...options })(req, res);
  req.end(typeof body === "string" ? body : JSON.stringify(body));
  return { req, res, complete };
}

test("alignment preserves historical names and punctuation using measured word boundaries", () => {
  assert.deepEqual(alignCaptionWords("Khufu’s modern-day Giza, in 2,500 BCE.", [
    word("Khufu's", 0.2), word("modern", 0.5), word("day", 0.75), word("Giza", 1),
    word("in", 1.4), word("twenty", 1.6), word("five", 1.85), word("hundred", 2.1),
    word("B", 2.5), word("C", 2.7), word("E", 2.9),
  ], 5), [
    word("Khufu’s", 0.2), { word: "modern-day", start: 0.5, end: 0.95 }, word("Giza,", 1),
    word("in", 1.4), { word: "2,500", start: 1.6, end: 2.1 + 0.2 }, { word: "BCE.", start: 2.5, end: 3.1 },
  ]);
});

test("joined ASR words share observed boundaries instead of fabricated internal timestamps", () => {
  assert.deepEqual(alignCaptionWords("can not — stop.", [word("cannot", 0.3, 1.1), word("stop", 1.8, 2)], 3), [
    word("can", 0.3, 1.1), word("not", 0.3, 1.1), word("—", 1.8, 1.8), word("stop.", 1.8, 2),
  ]);
});

test("mismatched names, wrong numbers, missing and invalid timestamps fail closed", () => {
  for (const [text, words] of [
    ["Khafre", [word("Khufu", 0)]], ["3", [word("one", 0), word("two", 0.3)]],
    ["2.5 meters", [word("25", 0), word("meters", 0.3)]],
    ["Hello", []], ["Hello", [word("Hello", -1)]],
    ["Hello", [word("Hello", 0, 10)]], ["Hello", [word("Hello", Number.NaN)]],
  ]) assert.throws(() => alignCaptionWords(text, words, 5));
});

test("endpoint prepares WAV plus aligned captions without exposing credentials", async () => {
  const calls = [];
  const audio = wav();
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return calls.length === 1 ? new Response(audio) : Response.json({ words: [word("Hello", 0.25), word("Giza", 0.75)] });
  };
  const { res, complete } = request({ text: "Hello Giza." }, { fetchImpl });
  await complete;
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.deepEqual(Buffer.from(res.body.audio, "base64"), audio);
  assert.deepEqual(res.body.words, [word("Hello", 0.25), word("Giza.", 0.75)]);
  assert.equal(JSON.parse(calls[0].init.body).response_format, "wav");
  assert.equal(calls[1].init.body.get("timestamp_granularities[]"), "word");
  assert.equal(calls[1].init.body.get("prompt"), "Hello Giza.");
  assert.equal(calls[1].init.body.get("file").type, "audio/wav");
  assert.equal(JSON.stringify(res.body).includes("test-secret"), false);
});

test("bad input is rejected before any paid upstream request", async () => {
  const fetchImpl = async () => { throw new Error("unexpected upstream request"); };
  for (const [payload, expected] of [["{", 400], [{}, 400], [{ text: "x".repeat(1201) }, 400], ["x".repeat(8193), 413]]) {
    const { res, complete } = request(payload, { fetchImpl });
    await complete;
    assert.equal(res.statusCode, expected);
  }
});

test("streaming WAV size fields are finalized before transcription and playback", async () => {
  const streamed = wav(2);
  streamed.writeUInt32LE(0xFFFFFFFF, 4);
  streamed.writeUInt32LE(0xFFFFFFFF, 40);
  let transcribed;
  let calls = 0;
  const { res, complete } = request({ text: "Giza" }, { fetchImpl: async (_url, init) => {
    if (++calls === 1) return new Response(streamed);
    transcribed = Buffer.from(await init.body.get("file").arrayBuffer());
    return Response.json({ words: [word("Giza", 0.2, 1.1)] });
  } });
  await complete;
  assert.equal(res.statusCode, 200);
  const played = Buffer.from(res.body.audio, "base64");
  assert.equal(played.readUInt32LE(4), played.length - 8);
  assert.equal(played.readUInt32LE(40), played.length - 44);
  assert.deepEqual(played, transcribed);
});

test("truncated audio and inconsistent PCM metadata fail before transcription", async () => {
  const truncated = wav(2);
  truncated.writeUInt32LE(truncated.length, 40);
  const invalidFormat = wav(2);
  invalidFormat.writeUInt32LE(1, 28);
  for (const audio of [truncated, invalidFormat]) {
    let calls = 0;
    const { res, complete } = request({ text: "Giza" }, { fetchImpl: async () => { calls += 1; return new Response(audio); } });
    await complete;
    assert.equal(calls, 1);
    assert.equal(res.statusCode, 502);
    assert.equal("audio" in res.body, false);
  }
});

test("upstream and alignment failures return useful errors without upstream secrets or audio", async () => {
  for (const reply of [new Response("private upstream diagnostic", { status: 500 }), Response.json({ words: [word("Wrong", 0.1)] })]) {
    let calls = 0;
    const { res, complete } = request({ text: "Giza" }, {
      fetchImpl: async () => ++calls === 1 ? new Response(wav()) : reply,
    });
    await complete;
    assert.equal(res.statusCode, 502);
    assert.equal("audio" in res.body, false);
    assert.equal(JSON.stringify(res.body).includes("private"), false);
  }
});

test("timeout aborts upstream work and responds with a retryable error", async () => {
  let signal;
  const { res, complete } = request({ text: "Giza" }, { timeoutMs: 10, fetchImpl: async (_url, init) => {
    signal = init.signal;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } });
  await complete;
  assert.equal(signal.aborted, true);
  assert.equal(res.statusCode, 504);
});

test("browser disconnect aborts upstream work and never replies with a late clip", async () => {
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  let signal;
  const { res, complete } = request({ text: "Giza" }, { fetchImpl: async (_url, init) => {
    signal = init.signal;
    started();
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } });
  await ready;
  res.destroyed = true;
  res.emit("close");
  await complete;
  assert.equal(signal.aborted, true);
  assert.equal(res.body, undefined);
});
