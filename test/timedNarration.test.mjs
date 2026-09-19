import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const exports = {};
const source = ts.transpileModule(
  readFileSync(new URL("../src/voice/TimedNarrationPlayer.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;
runInNewContext(source, { exports, AbortController, Uint8Array, Blob, URL, atob }, { filename: "TimedNarrationPlayer.js" });
const { TimedNarrationPlayer, captionAtTime } = exports;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function narration(text, starts = text.split(/\s+/u).map((_, index) => index * 0.5)) {
  return {
    audio: "fixture-audio",
    words: text.split(/\s+/u).map((word, index) => ({ word, start: starts[index], end: starts[index] + 0.2 })),
  };
}

async function flush() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function fixture({ deferredPlay = false } = {}) {
  const requests = [];
  const audios = [];
  const frames = new Map();
  const captions = [];
  const states = [];
  const errors = [];
  const replay = [];
  const revoked = [];
  let serial = 0;
  let completed = 0;
  class FakeAudio {
    currentTime = 0;
    duration = 120;
    paused = true;
    src = "";
    preload = "";
    listeners = new Map();
    attempts = [];
    constructor() { audios.push(this); }
    addEventListener(event, callback) {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(callback);
      this.listeners.set(event, listeners);
    }
    removeEventListener(event, callback) {
      this.listeners.set(event, (this.listeners.get(event) ?? []).filter((listener) => listener !== callback));
    }
    emit(event) { for (const callback of [...this.listeners.get(event) ?? []]) callback(); }
    play() {
      const attempt = deferred();
      this.attempts.push(attempt);
      if (!deferredPlay) {
        this.paused = false;
        this.emit("playing");
        attempt.resolve();
      }
      return attempt.promise;
    }
    resolvePlay(index = this.attempts.length - 1) {
      this.paused = false;
      this.emit("playing");
      this.attempts[index].resolve();
    }
    pause() { this.paused = true; this.emit("pause"); }
    removeAttribute(name) { if (name === "src") this.src = ""; }
    load() {}
  }
  const player = new TimedNarrationPlayer({
    load(text, signal) {
      const request = { text, signal, ...deferred() };
      requests.push(request);
      return request.promise;
    },
    onCaption: (caption) => captions.push(caption),
    onState: (state) => states.push(state),
    onError: (error) => errors.push(error),
    onComplete: () => { completed += 1; },
    onReplayAvailable: (available) => replay.push(available),
    deps: {
      createAudio: () => new FakeAudio(),
      createAudioUrl: () => `blob:fixture-${++serial}`,
      revokeAudioUrl: (url) => revoked.push(url),
      requestFrame(callback) { const id = ++serial; frames.set(id, callback); return id; },
      cancelFrame: (id) => frames.delete(id),
    },
  });
  return {
    player, requests, audios, captions, states, errors, replay, revoked, frames,
    get audio() { return audios.at(-1); },
    get caption() { return captions.at(-1) ?? ""; },
    get completed() { return completed; },
    frame() {
      const ready = [...frames.values()];
      frames.clear();
      for (const callback of ready) callback();
    },
    end(time = 120) {
      this.audio.currentTime = time;
      this.audio.paused = true;
      this.audio.emit("ended");
    },
  };
}

test("network jitter cannot reorder speech, prefetch is bounded, and response completion waits for audio", async () => {
  const f = fixture();
  for (const text of ["First sentence.", "Second sentence.", "Third sentence.", "Fourth sentence."]) f.player.enqueue(text);
  f.player.finish();
  await flush();
  assert.equal(f.player.state, "buffering");
  assert.equal(f.requests.length, 2);
  assert.equal(f.audios.length, 0);
  f.requests[1].resolve(narration("Second sentence."));
  await flush();
  assert.equal(f.audios.length, 0, "later audio waits for the earlier sentence");
  assert.equal(f.requests.length, 2, "a completed prefetched clip does not open an unbounded window");
  f.requests[0].resolve(narration("First sentence."));
  await flush();
  assert.equal(f.caption, "First");
  assert.equal(f.player.state, "playing");
  assert.equal(f.requests.length, 3, "two future clips may be prepared while one plays");
  assert.equal(f.completed, 0);
  f.end();
  await flush();
  assert.equal(f.caption, "First sentence. Second");
  assert.equal(f.requests.length, 4);
  f.requests[3].resolve(narration("Fourth sentence."));
  f.end();
  await flush();
  assert.equal(f.player.state, "buffering");
  assert.equal(f.caption, "First sentence. Second sentence.");
  assert.equal(f.completed, 0);
  f.requests[2].resolve(narration("Third sentence."));
  await flush();
  assert.ok(f.caption.endsWith("Third"));
  f.end();
  await flush();
  assert.ok(f.caption.endsWith("Fourth"));
  assert.equal(f.completed, 0);
  f.end();
  assert.equal(f.completed, 1);
  assert.equal(f.player.state, "idle");
  assert.equal(f.player.canReplay, true);
  assert.equal(f.revoked.length, 4);
  assert.equal(f.frames.size, 0);
  f.player.finish();
  assert.equal(f.completed, 1, "duplicate server completion does not complete twice");
});

test("captions read the audio playhead after stalled or throttled frames and hold through silence", async () => {
  const f = fixture();
  f.player.enqueue("One two three four five.");
  f.player.finish();
  await flush();
  f.requests[0].resolve(narration("One two three four five.", [0.3, 0.9, 3.5, 3.6, 4.2]));
  await flush();
  assert.equal(f.caption, "", "leading silence must not reveal the first word early");
  f.audio.currentTime = 0.31;
  f.frame();
  assert.equal(f.caption, "One");
  for (let index = 0; index < 50; index += 1) f.frame();
  assert.equal(f.caption, "One", "elapsed animation frames do not advance stationary audio");
  f.audio.currentTime = 2.9;
  f.frame();
  assert.equal(f.caption, "One two", "timestamp gaps hold the existing caption");
  f.audio.emit("waiting");
  assert.equal(f.player.state, "buffering");
  assert.equal(f.frames.size, 0);
  f.audio.currentTime = 3.65;
  f.audio.emit("playing");
  assert.equal(f.caption, "One two three four", "resume catches up in one render after a throttled frame");
  f.audio.currentTime = 4.21;
  f.audio.emit("timeupdate");
  assert.equal(f.caption, "One two three four five.");
  assert.equal(f.completed, 0, "the final timestamp is separate from the audio-ended event");
  f.end(4.4);
  assert.equal(f.completed, 1);
});

test("fourteen-word cards follow actual word boundaries, including across clips", () => {
  const words = narration(Array.from({ length: 32 }, (_, index) => `word${index + 1}`).join(" ")).words;
  assert.equal(captionAtTime(words, 6.49), words.slice(0, 13).map((word) => word.word).join(" "));
  assert.equal(captionAtTime(words, 6.5), words.slice(0, 14).map((word) => word.word).join(" "));
  assert.equal(captionAtTime(words, 7), "word15");
  assert.equal(captionAtTime(words, 14.6), "word29 word30");
  assert.equal(captionAtTime(narration("next word").words, 0, words.slice(0, 14).map((word) => word.word)), "next");
});

test("pause freezes media time and captions while remaining clips finish fetching, resume reuses the same audio", async () => {
  const f = fixture();
  f.player.enqueue("Keep this position.");
  f.player.enqueue("Next sentence.");
  await flush();
  f.requests[0].resolve(narration("Keep this position."));
  await flush();
  const audio = f.audio;
  audio.currentTime = 0.65;
  f.frame();
  f.player.pause();
  const frozen = f.caption;
  assert.equal(frozen, "Keep this");
  assert.equal(audio.paused, true);
  f.requests[1].resolve(narration("Next sentence."));
  f.player.finish();
  await flush();
  f.frame();
  audio.emit("timeupdate");
  assert.equal(f.caption, frozen);
  assert.equal(f.audios.length, 1);
  assert.equal(f.completed, 0);
  assert.equal(f.requests[1].signal.aborted, false);
  f.player.resume();
  await flush();
  assert.equal(f.audio, audio);
  assert.equal(audio.currentTime, 0.65);
  assert.equal(audio.paused, false);
  assert.equal(audio.attempts.length, 2);
  audio.currentTime = 1.01;
  f.frame();
  assert.equal(f.caption, "Keep this position.");
  f.end();
  await flush();
  assert.equal(f.audios.length, 2);
  assert.equal(f.caption, "Keep this position. Next");
  f.player.dispose();
});

test("pause before audio is ready retains the queue and never autoplays", async () => {
  const f = fixture();
  f.player.enqueue("Buffered sentence.");
  f.player.pause();
  f.player.finish();
  await flush();
  f.requests[0].resolve(narration("Buffered sentence."));
  await flush();
  assert.equal(f.audios.length, 0);
  assert.equal(f.caption, "");
  f.player.resume();
  await flush();
  assert.equal(f.caption, "Buffered");
  assert.equal(f.audio.paused, false);
  f.player.dispose();
});

test("a play promise resolving after pause cannot start sound or captions", async () => {
  const f = fixture({ deferredPlay: true });
  f.player.enqueue("Stay paused.");
  f.player.finish();
  await flush();
  f.requests[0].resolve(narration("Stay paused."));
  await flush();
  f.player.pause();
  f.audio.resolvePlay();
  await flush();
  assert.equal(f.audio.paused, true);
  assert.equal(f.caption, "");
  assert.equal(f.frames.size, 0);
  f.player.resume();
  f.audio.resolvePlay();
  await flush();
  assert.equal(f.audio.paused, false);
  assert.equal(f.caption, "Stay");
  f.player.dispose();
});

test("pausing after a throttled frame snapshots the actual audible position", async () => {
  const f = fixture();
  f.player.enqueue("One two three.");
  f.player.finish();
  await flush();
  f.requests[0].resolve(narration("One two three."));
  await flush();
  assert.equal(f.caption, "One");
  f.audio.currentTime = 0.75;
  f.player.pause();
  assert.equal(f.caption, "One two", "pause catches up from media time even without a recent frame");
  f.player.dispose();
});

test("an ended event queued during pause completes on resume without replaying the clip", async () => {
  const f = fixture();
  f.player.enqueue("Finish this sentence.");
  f.player.finish();
  await flush();
  f.requests[0].resolve(narration("Finish this sentence."));
  await flush();
  f.audio.currentTime = 1.5;
  f.player.pause();
  const lastCaption = f.caption;
  f.audio.emit("ended");
  assert.equal(f.completed, 0);
  assert.equal(f.caption, lastCaption);
  f.player.resume();
  assert.equal(f.completed, 1);
  assert.equal(f.audio.attempts.length, 1, "play at the end would incorrectly restart finite audio");
  assert.equal(f.player.state, "idle");
});

test("a canceled animation callback cannot lose the active frame after reset", async () => {
  const f = fixture();
  f.player.enqueue("Old sentence.");
  await flush();
  f.requests[0].resolve(narration("Old sentence."));
  await flush();
  const oldFrame = [...f.frames.values()][0];
  f.player.reset();
  f.player.enqueue("Current sentence.");
  await flush();
  f.requests[1].resolve(narration("Current sentence."));
  await flush();
  oldFrame();
  assert.equal(f.caption, "Current");
  assert.equal(f.frames.size, 1);
  f.player.pause();
  assert.equal(f.frames.size, 0, "the new frame handle remains cancellable");
  f.player.dispose();
});

test("reset aborts requests and fences late loader, play-promise, and event callbacks", async () => {
  const f = fixture({ deferredPlay: true });
  f.player.enqueue("Old audio.");
  f.player.enqueue("Late old request.");
  await flush();
  f.requests[0].resolve(narration("Old audio."));
  await flush();
  const oldAudio = f.audio;
  const stalePlaying = oldAudio.listeners.get("playing")[0];
  const staleEnded = oldAudio.listeners.get("ended")[0];
  f.player.reset();
  assert.equal(f.requests[1].signal.aborted, true);
  assert.equal(oldAudio.src, "");
  assert.equal(f.revoked.length, 1);
  f.player.enqueue("New speech.");
  f.player.finish();
  await flush();
  f.requests[2].resolve(narration("New speech."));
  await flush();
  const newAudio = f.audio;
  newAudio.resolvePlay();
  await flush();
  assert.equal(f.caption, "New");
  oldAudio.resolvePlay();
  stalePlaying();
  staleEnded();
  f.requests[1].resolve(narration("Late old request."));
  await flush();
  assert.equal(oldAudio.paused, true);
  assert.equal(newAudio.paused, false);
  assert.equal(f.caption, "New");
  assert.equal(f.audios.length, 2);
  assert.equal(f.completed, 0);
  f.end();
  assert.equal(f.completed, 1);
});

test("input remains open between sentences and tool continuations until finish is called", async () => {
  const f = fixture();
  f.player.enqueue("Before the tool.");
  await flush();
  f.requests[0].resolve(narration("Before the tool."));
  await flush();
  f.end();
  assert.equal(f.player.state, "buffering");
  assert.equal(f.completed, 0);
  assert.equal(f.player.canReplay, false);
  f.player.enqueue("After the tool.");
  await flush();
  f.requests[1].resolve(narration("After the tool."));
  await flush();
  f.player.finish();
  assert.equal(f.completed, 0);
  f.end();
  assert.equal(f.completed, 1);
  assert.equal(f.player.state, "idle");
});

test("replay uses the cached final sentence without another loader request", async () => {
  const f = fixture();
  f.player.enqueue("Cached final sentence.");
  f.player.finish();
  await flush();
  f.requests[0].resolve(narration("Cached final sentence."));
  await flush();
  assert.equal(f.player.replayLast(), false);
  f.end();
  assert.equal(f.player.canReplay, true);
  assert.equal(f.player.replayLast(), true);
  await flush();
  assert.equal(f.requests.length, 1);
  assert.equal(f.caption, "Cached");
  assert.equal(f.audios.length, 2);
  f.end();
  assert.equal(f.completed, 2);
  assert.equal(f.player.canReplay, true);
  f.player.reset();
  assert.equal(f.player.canReplay, false);
  assert.equal(f.player.replayLast(), false);
});

for (const [label, change] of [
  ["missing", (data) => { data.words = []; }],
  ["negative", (data) => { data.words[0].start = -1; }],
  ["non-finite", (data) => { data.words[0].end = NaN; }],
  ["out of order", (data) => { data.words[0].start = 0.75; data.words[0].end = 0.8; }],
  ["mismatched words", (data) => { data.words[0].word = "Invented"; }],
]) {
  test(`invalid ${label} timestamps fail visibly without guessed speech timing`, async () => {
    const f = fixture();
    f.player.enqueue("Correct words.");
    f.player.finish();
    await flush();
    const data = narration("Correct words.");
    change(data);
    f.requests[0].resolve(data);
    await flush();
    assert.equal(f.errors.length, 1);
    assert.equal(f.audios.length, 0);
    assert.equal(f.completed, 0);
    assert.equal(f.player.state, "idle");
  });
}

test("timestamps outside the actual audio duration stop playback", async () => {
  const f = fixture({ deferredPlay: true });
  f.player.enqueue("Too long.");
  await flush();
  f.requests[0].resolve(narration("Too long.", [0, 6]));
  await flush();
  f.audio.duration = 3;
  f.audio.emit("loadedmetadata");
  assert.equal(f.errors.length, 1);
  assert.equal(f.audio.paused, true);
  assert.equal(f.audio.src, "");
  assert.equal(f.revoked.length, 1);
  assert.equal(f.frames.size, 0);
});

test("browser autoplay rejection is actionable and leaves no pending speech", async () => {
  const f = fixture({ deferredPlay: true });
  f.player.enqueue("Please play.");
  f.player.finish();
  await flush();
  f.requests[0].resolve(narration("Please play."));
  await flush();
  f.audio.attempts[0].reject({ name: "NotAllowedError", message: "Not permitted" });
  await flush();
  assert.equal(f.errors.length, 1);
  assert.match(f.errors[0].message, /blocked by your browser/i);
  assert.match(f.errors[0].message, /start voice again/i);
  assert.equal(f.player.state, "idle");
  assert.equal(f.audio.paused, true);
  assert.equal(f.revoked.length, 1);
});

test("oversized input is rejected before synthesis and disposal prevents future work", async () => {
  const f = fixture();
  f.player.enqueue("x".repeat(1601));
  await flush();
  assert.equal(f.errors.length, 1);
  assert.equal(f.requests.length, 0);
  f.player.enqueue("Pending request.");
  await flush();
  f.player.dispose();
  assert.equal(f.requests[0].signal.aborted, true);
  f.requests[0].resolve(narration("Pending request."));
  f.player.enqueue("Ignored sentence.");
  await flush();
  assert.equal(f.requests.length, 1);
  assert.equal(f.audios.length, 0);
  assert.equal(f.frames.size, 0);
});
