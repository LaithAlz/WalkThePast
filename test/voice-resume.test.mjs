// Exercise the actual hook, splitter, and audio player with deterministic browser fixtures.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function compile(filename) {
  return ts.transpileModule(readFileSync(new URL(filename, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
const hookCode = compile("../src/voice/useRealtimeHistorian.ts");
const playerCode = compile("../src/voice/TimedNarrationPlayer.ts");
const splitterCode = compile("../src/voice/narrationText.ts");
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function createHistorian({ blockedPlayback = false } = {}) {
  const slots = [], effects = [], sent = [], audios = [], requests = [], revoked = [];
  const frames = new Map();
  let cursor = 0, dirty = true, value, serial = 0, peer, responseId = "opening", received = "";
  const sameDeps = (a, b) => a && b && a.length === b.length && a.every((item, index) => Object.is(item, b[index]));
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) {
        const slot = { value: typeof initial === "function" ? initial() : initial };
        slot.set = (next) => {
          const result = typeof next === "function" ? next(slot.value) : next;
          if (!Object.is(result, slot.value)) { slot.value = result; dirty = true; }
        };
        slots[index] = slot;
      }
      return [slots[index].value, slots[index].set];
    },
    useRef(initial) { const index = cursor++; slots[index] ??= { current: initial }; return slots[index]; },
    useCallback(callback, deps) {
      const index = cursor++;
      if (!sameDeps(slots[index]?.deps, deps)) slots[index] = { callback, deps };
      return slots[index].callback;
    },
    useEffect(effect, deps) {
      const index = cursor++;
      if (sameDeps(slots[index]?.deps, deps)) return;
      const previous = slots[index];
      const slot = { deps };
      slots[index] = slot;
      effects.push(() => { previous?.cleanup?.(); slot.cleanup = effect(); });
    },
  };
  const microphone = { enabled: true, readyState: "live", stop() { this.readyState = "ended"; } };
  const stream = { getTracks: () => [microphone], getAudioTracks: () => [microphone] };
  const channel = {
    readyState: "connecting",
    send(data) { assert.equal(this.readyState, "open"); sent.push(JSON.parse(data)); },
    close() { this.readyState = "closed"; },
  };
  class MockAudio {
    currentTime = 0; duration = 60; paused = true; src = ""; preload = ""; playCalls = 0;
    listeners = new Map();
    constructor() { audios.push(this); }
    addEventListener(event, callback) { this.listeners.set(event, [...this.listeners.get(event) ?? [], callback]); }
    removeEventListener(event, callback) {
      this.listeners.set(event, (this.listeners.get(event) ?? []).filter((listener) => listener !== callback));
    }
    emit(event) { for (const callback of [...this.listeners.get(event) ?? []]) callback(); }
    pause() { this.paused = true; this.emit("pause"); }
    async play() {
      this.playCalls += 1;
      if (blockedPlayback) throw Object.assign(new Error("Browser blocked playback"), { name: "NotAllowedError" });
      this.paused = false;
      this.emit("playing");
    }
    removeAttribute(name) { if (name === "src") this.src = ""; }
    load() {}
  }
  const timers = new Map();
  const clock = {
    set(callback, delay) { const id = ++serial; timers.set(id, { callback, delay }); return id; },
    clear(id) { timers.delete(id); },
    /** Fire every timer due within `ms`, as a real clock would. */
    advance(ms) {
      for (const [id, timer] of [...timers]) {
        if (timer.delay > ms) continue;
        timers.delete(id);
        timer.callback();
      }
    },
  };
  class MockPeer {
    connectionState = "connected";
    constructor() { peer = this; }
    /** Drive the ICE lifecycle the way the browser does. */
    reach(state) { this.connectionState = state; this.onconnectionstatechange?.(); }
    createDataChannel() { return channel; }
    addTrack() {}
    async createOffer() { return { type: "offer", sdp: "fixture-offer" }; }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    close() {}
  }
  const playerExports = {}, splitterExports = {}, exports = {};
  runInNewContext(playerCode, { exports: playerExports, AbortController }, { filename: "TimedNarrationPlayer.js" });
  runInNewContext(splitterCode, { exports: splitterExports }, { filename: "narrationText.js" });
  runInNewContext(hookCode, {
    exports,
    require(name) {
      if (name === "react") return react;
      if (name === "./historian") return {
        HISTORIAN_INSTRUCTIONS: "Fixture historian", HISTORIAN_TOOLS: [],
        sceneMetadata: () => "Fixture scene", runHistorianTool: () => ({ status: "linked" }),
      };
      if (name === "./narrationText") return splitterExports;
      // The hook routes its calls through the configured backend. VITE_API_BASE is empty
      // for local dev, so api() is identity and the fetch fixtures below stay as they are.
      if (name === "../lib/backend") return { api: (path) => path, authHeaders: async () => ({}) };
      if (name === "./TimedNarrationPlayer") return {
        TimedNarrationPlayer: class extends playerExports.TimedNarrationPlayer {
          constructor(options) {
            super({ ...options, deps: {
              createAudio: () => new MockAudio(),
              createAudioUrl: () => "blob:fixture-" + ++serial,
              revokeAudioUrl: (url) => revoked.push(url),
              requestFrame(callback) { const id = ++serial; frames.set(id, callback); return id; },
              cancelFrame: (id) => frames.delete(id),
            } });
          }
        },
      };
      throw new Error("Unexpected import: " + name);
    },
    navigator: { mediaDevices: { async getUserMedia() { return stream; } } },
    async fetch(url, options) {
      if (url === "/api/realtime/session") return { ok: true, json: async () => ({ value: "fixture-token" }) };
      if (url === "/fixture.png") return { ok: true, blob: async () => ({}) };
      if (url === "https://api.openai.com/v1/realtime/calls") return { ok: true, text: async () => "fixture-answer" };
      if (url === "/api/realtime/narration") {
        const request = { ...deferred(), text: JSON.parse(options.body).text, signal: options.signal };
        requests.push(request);
        return request.promise;
      }
      throw new Error("Unexpected fetch: " + url);
    },
    FileReader: class { readAsDataURL() { this.result = "data:image/png;base64,fixture"; this.onload(); } },
    RTCPeerConnection: MockPeer, URL, AbortController, console,
    setTimeout: clock.set, clearTimeout: clock.clear,
  }, { filename: "useRealtimeHistorian.js" });
  const context = {
    world: { id: "giza", title: "Giza", place: "Egypt", date: "Old Kingdom", description: "Fixture", sourceImage: "/fixture.png" },
    evidenceEnabled: false, evidenceCounts: null, verdict: null,
  };
  function flush() {
    for (let renders = 0; dirty || effects.length; renders += 1) {
      assert.ok(renders < 100, "hook settles after state updates");
      if (dirty) { dirty = false; cursor = 0; value = exports.useRealtimeHistorian(context); }
      for (const effect of effects.splice(0)) effect();
    }
  }
  const fixture = {
    sent, microphone, requests, audios, frames, revoked, clock, timers,
    get voice() { flush(); return value; },
    get audio() { return audios.at(-1); },
    get peer() { return peer; },
    act(action) { action(this.voice); flush(); },
    event(type, data = {}) {
      const responseFields = type.startsWith("response.") ? { response_id: responseId } : {};
      channel.onmessage({ data: JSON.stringify({ ...responseFields, ...data, type }) });
      flush();
    },
    begin(text, id = "opening") {
      responseId = id; received = "";
      this.event("response.created", { response: { id, status: "in_progress", output: [] } });
      this.delta(text);
    },
    delta(text) {
      received += text;
      this.event("response.output_text.delta", { item_id: responseId + "-text", content_index: 0, delta: text });
    },
    finishText() {
      this.event("response.output_text.done", { item_id: responseId + "-text", content_index: 0, text: received });
    },
    finishResponse(output = []) {
      this.event("response.done", { response: { id: responseId, status: "completed", output } });
    },
    async settle() {
      for (let step = 0; step < 16; step += 1) { await Promise.resolve(); flush(); }
    },
    async ready(index) {
      await this.settle();
      const request = requests[index ?? requests.length - 1];
      assert.ok(request, "a buffered narration request exists");
      const narration = {
        audio: "fixture-audio",
        words: request.text.split(/\s+/u).map((word, i) => ({ word, start: i * 0.5, end: i * 0.5 + 0.3 })),
      };
      request.resolve({ ok: true, json: async () => narration });
      await this.settle();
    },
    async start(text, id = "opening") {
      this.begin(text, id); this.finishText(); await this.settle(); await this.ready();
    },
    frame() {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback();
      flush();
    },
    sample(time) { this.audio.currentTime = time; this.audio.emit("timeupdate"); this.frame(); },
    end() { this.audio.currentTime = this.audio.duration; this.audio.paused = true; this.audio.emit("ended"); flush(); },
    creates() { return sent.filter((event) => event.type === "response.create"); },
    cleanup() { this.act((voice) => voice.disconnect()); assert.equal(frames.size, 0); },
  };
  flush();
  await value.connect();
  flush();
  assert.equal(value.error, "", "fixture connection succeeds");
  channel.readyState = "open";
  channel.onopen();
  flush();
  return fixture;
}

const opening = "Giza holds great pyramids and ancient temples.";
const link = (callId, label = "Giza") => ({
  type: "function_call", id: "item-" + callId, name: "linkHistoricalEntity", call_id: callId,
  arguments: JSON.stringify({ label, kind: "site", articleUrl: "https://en.wikipedia.org/wiki/Giza", summary: "A historical site." }),
});

test("an article return resumes the same buffered audio and exact caption playhead", async (t) => {
  const f = await createHistorian(); t.after(() => f.cleanup());
  await f.start(opening);
  f.sample(0.6);
  assert.equal(f.voice.caption, "Giza holds");
  const audio = f.audio;
  f.act((voice) => voice.pause("detour"));
  f.finishResponse();
  for (let frame = 0; frame < 120; frame += 1) f.frame();
  assert.equal(f.voice.caption, "Giza holds");
  assert.equal(audio.currentTime, 0.6);
  assert.equal(audio.paused, true);
  assert.equal(f.microphone.enabled, false);
  f.act((voice) => voice.resume("detour"));
  await f.settle();
  assert.equal(f.audio, audio);
  assert.equal(f.audio.paused, false);
  assert.equal(f.creates().length, 1, "resuming does not regenerate or duplicate speech");
  assert.equal(f.requests.length, 1);
  f.sample(1.1);
  assert.equal(f.voice.caption, "Giza holds great");
});

test("a quick return continues buffered speech while text generation is still running", async (t) => {
  const f = await createHistorian(); t.after(() => f.cleanup());
  await f.start(opening);
  f.act((voice) => voice.pause("detour"));
  f.act((voice) => voice.resume("detour"));
  await f.settle();
  assert.equal(f.audio.paused, false);
  assert.equal(f.creates().length, 1);
  f.sample(0.6);
  assert.equal(f.voice.caption, "Giza holds");
  f.finishResponse();
  assert.equal(f.voice.status, "speaking", "generation completion cannot end audible speech");
  assert.equal(f.voice.canReplay, false);
  f.end();
  assert.equal(f.voice.status, "listening");
  assert.equal(f.voice.canReplay, true);
});

test("audio prepared during a detour stays silent until return", async (t) => {
  const f = await createHistorian(); t.after(() => f.cleanup());
  f.begin(opening); f.finishText();
  f.act((voice) => voice.pause("detour"));
  f.finishResponse();
  await f.ready();
  assert.equal(f.audios.length, 0);
  assert.equal(f.voice.caption, "");
  f.act((voice) => voice.resume("detour"));
  await f.settle();
  assert.equal(f.audio.paused, false);
  assert.equal(f.voice.caption, "Giza");
  assert.equal(f.creates().length, 1);
});

test("out-of-order network responses cannot reorder audio or expose future captions", async (t) => {
  const f = await createHistorian(); t.after(() => f.cleanup());
  f.begin("First sentence. Second sentence."); f.finishText(); f.finishResponse();
  await f.settle();
  assert.equal(f.requests.length, 2);
  await f.ready(1);
  assert.equal(f.audios.length, 0);
  assert.equal(f.voice.caption, "");
  await f.ready(0);
  assert.equal(f.voice.caption, "First");
  f.end(); await f.settle();
  assert.equal(f.audios.length, 2);
  assert.equal(f.voice.caption, "First sentence. Second");
  f.end();
  assert.equal(f.voice.status, "listening");
});

test("parallel tools request one follow-up and preserve queued speech during a detour", async (t) => {
  const f = await createHistorian(); t.after(() => f.cleanup());
  await f.start("Giza holds pyramids.");
  f.act((voice) => voice.pause("detour"));
  const calls = [link("giza-link"), link("temple-link", "Temple")];
  for (const call of calls) f.event("response.function_call_arguments.done", call);
  assert.equal(f.creates().length, 1, "parallel tools wait for their response to end");
  f.finishResponse(calls);
  assert.equal(f.creates().length, 2);
  assert.equal(f.sent.filter((event) => event.type === "conversation.item.create" && event.item?.type === "function_call_output").length, 2);
  assert.equal(f.voice.entities.length, 2);
  f.begin("Temples stand nearby.", "tool-followup"); f.finishText(); f.finishResponse();
  await f.ready();
  assert.equal(f.voice.caption, "Giza");
  assert.equal(f.audio.paused, true);
  f.act((voice) => voice.resume("detour"));
  await f.settle(); f.end(); await f.settle();
  assert.equal(f.voice.caption, "Giza holds pyramids. Temples");
  assert.equal(f.creates().length, 2);
  f.end();
  assert.equal(f.voice.status, "listening");
});

test("an interrupted tool continuation stays cancelled after the visitor stops speaking", async (t) => {
  const f = await createHistorian(); t.after(() => f.cleanup());
  f.begin("");
  f.event("response.function_call_arguments.done", link("giza-link"));
  f.finishResponse();
  assert.equal(f.creates().length, 2);
  f.act((voice) => voice.setMicrophoneMuted(false));
  f.event("input_audio_buffer.speech_started");
  f.event("input_audio_buffer.speech_stopped");
  f.begin(opening, "cancelled-continuation"); f.finishText(); f.finishResponse();
  await f.settle();
  assert.ok(f.sent.some((event) => event.type === "response.cancel" && event.response_id === "cancelled-continuation"));
  assert.equal(f.requests.length, 0);
  assert.equal(f.voice.caption, "");
  assert.equal(f.voice.isMicMuted, false);
  assert.equal(f.microphone.enabled, true);
  assert.equal(f.creates().length, 2);
});

test("closing an article preserves a separate manual pause", async (t) => {
  const f = await createHistorian(); t.after(() => f.cleanup());
  await f.start(opening);
  f.act((voice) => { voice.pause("transport"); voice.pause("detour"); });
  f.finishResponse();
  f.act((voice) => voice.resume("detour"));
  await f.settle();
  assert.equal(f.voice.isPaused, true);
  assert.equal(f.voice.isTransportPaused, true);
  assert.equal(f.audio.paused, true);
  assert.equal(f.voice.caption, "Giza");
  f.act((voice) => voice.resume("transport"));
  await f.settle();
  assert.equal(f.voice.isPaused, false);
  assert.equal(f.voice.isTransportPaused, false);
  assert.equal(f.audio.paused, false);
  assert.equal(f.creates().length, 1);
});

test("reopening an article preserves the clip and exact unheard position", async (t) => {
  const f = await createHistorian(); t.after(() => f.cleanup());
  await f.start(opening);
  const audio = f.audio;
  f.sample(0.6);
  f.act((voice) => voice.pause("detour"));
  f.act((voice) => voice.resume("detour"));
  f.act((voice) => voice.pause("detour"));
  f.finishResponse(); await f.settle();
  assert.equal(f.audio.paused, true);
  f.act((voice) => voice.resume("detour"));
  await f.settle(); f.sample(1.1);
  f.act((voice) => voice.pause("detour"));
  f.act((voice) => voice.resume("detour"));
  await f.settle();
  assert.equal(f.audio, audio);
  assert.equal(f.audio.currentTime, 1.1);
  assert.equal(f.voice.caption, "Giza holds great");
  assert.equal(f.creates().length, 1);
  assert.equal(f.requests.length, 1);
});

test("return after completed narration stays silent and replay uses cached audio", async (t) => {
  const f = await createHistorian(); t.after(() => f.cleanup());
  await f.start(opening); f.finishResponse(); f.end();
  const completedCaption = f.voice.caption;
  f.act((voice) => voice.pause("detour"));
  f.act((voice) => voice.resume("detour"));
  await f.settle();
  assert.equal(f.audios.length, 1);
  assert.equal(f.voice.caption, completedCaption);
  assert.equal(f.voice.status, "listening");
  f.act((voice) => voice.replayLastSentence());
  await f.settle();
  assert.equal(f.voice.caption, "Giza");
  assert.equal(f.audios.length, 2);
  assert.equal(f.requests.length, 1);
  assert.equal(f.creates().length, 1);
});

test("detours preserve unmuted microphone preference while disabling paused input", async (t) => {
  const f = await createHistorian(); t.after(() => f.cleanup());
  await f.start("Welcome."); f.finishResponse(); f.end();
  f.act((voice) => voice.setMicrophoneMuted(false));
  await f.start(opening, "answer");
  f.act((voice) => voice.pause("detour"));
  assert.equal(f.voice.isMicMuted, false);
  assert.equal(f.microphone.enabled, false);
  f.finishResponse();
  f.act((voice) => voice.resume("detour"));
  await f.settle();
  assert.equal(f.audio.paused, false);
  assert.equal(f.voice.isMicMuted, false);
  assert.equal(f.microphone.enabled, true);
});

test("remote audio cannot create an independent playback clock", async (t) => {
  const f = await createHistorian(); t.after(() => f.cleanup());
  f.act((voice) => voice.pause("detour"));
  f.peer.ontrack?.({ streams: [{}] });
  assert.equal(f.audios.length, 0);
  assert.equal(f.microphone.enabled, false);
  assert.deepEqual(f.sent.find((event) => event.type === "session.update").session.output_modalities, ["text"]);
});

test("disconnect aborts preparation and ignores a late network success", async (t) => {
  const f = await createHistorian(); t.after(() => f.cleanup());
  f.begin(opening); f.finishText(); await f.settle();
  f.act((voice) => voice.disconnect());
  assert.equal(f.requests[0].signal.aborted, true);
  await f.ready(0);
  assert.equal(f.audios.length, 0);
  assert.equal(f.voice.status, "idle");
  assert.equal(f.voice.caption, "");
  assert.equal(f.microphone.readyState, "ended");
});

test("late events from an interrupted response cannot affect its replacement", async (t) => {
  const f = await createHistorian(); t.after(() => f.cleanup());
  await f.start(opening);
  const abandoned = f.audio;
  f.act((voice) => voice.setMicrophoneMuted(false));
  f.event("input_audio_buffer.speech_started");
  f.event("input_audio_buffer.speech_stopped");
  await f.start("New answer.", "answer");
  f.event("response.output_text.delta", { response_id: "opening", item_id: "opening-text", delta: "Obsolete words." });
  f.event("response.done", { response_id: "opening", response: { id: "opening", status: "completed", output: [] } });
  abandoned.currentTime = 60; abandoned.emit("ended"); await f.settle();
  assert.equal(f.voice.caption, "New");
  assert.equal(f.voice.status, "speaking");
  assert.equal(f.requests.length, 2);
  assert.equal(abandoned.paused, true);
});

test("response fallback text completes a partial stream without duplicate speech", async (t) => {
  const f = await createHistorian(); t.after(() => f.cleanup());
  f.begin("Giza holds ");
  f.finishResponse([{ type: "message", id: "opening-text", content: [{ type: "output_text", text: opening }] }]);
  await f.ready();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].text, opening);
  assert.equal(f.voice.caption, "Giza");
  f.event("response.output_text.done", { item_id: "opening-text", text: opening });
  await f.settle();
  assert.equal(f.requests.length, 1);
});

test("a browser playback block reports an error and cannot advance captions", async (t) => {
  const f = await createHistorian({ blockedPlayback: true }); t.after(() => f.cleanup());
  await f.start(opening);
  assert.equal(f.voice.status, "error");
  assert.match(f.voice.error, /blocked by your browser/i);
  assert.equal(f.voice.caption, "");
  assert.equal(f.audio.paused, true);
  assert.equal(f.frames.size, 0);
  assert.equal(f.microphone.readyState, "ended");
});

// A pause is only worth resuming if the session is still there when you come
// back, so a network blip must not be mistaken for a lost conversation.
test("a transient ICE drop does not end the conversation", async (t) => {
  const f = await createHistorian(); t.after(() => f.cleanup());
  await f.start(opening);
  f.act((voice) => voice.pause("detour"));

  f.peer.reach("disconnected");
  f.act(() => {});
  assert.notEqual(f.voice.status, "error", "a drop alone does not fail the session");
  assert.equal(f.voice.error, "", "and says nothing to the visitor");

  f.peer.reach("connected");
  f.act(() => {});
  f.clock.advance(60_000);
  f.act(() => {});
  assert.equal(f.voice.error, "", "recovery cancels the pending failure");
  assert.equal(f.timers.size, 0, "and leaves no timer behind");

  f.act((voice) => voice.resume("detour"));
  assert.equal(f.voice.isPaused, false, "so the historian picks up where it left off");
  assert.notEqual(f.voice.status, "error");
});

test("an ICE drop that does not recover ends the session", async (t) => {
  const f = await createHistorian(); t.after(() => f.cleanup());
  await f.start(opening);
  f.peer.reach("disconnected");
  f.clock.advance(60_000);
  f.act(() => {});
  assert.equal(f.voice.status, "error");
  assert.match(f.voice.error, /connection lost/i);
});

test("a failed connection ends the session at once", async (t) => {
  const f = await createHistorian(); t.after(() => f.cleanup());
  await f.start(opening);
  f.peer.reach("failed");
  f.act(() => {});
  assert.equal(f.voice.status, "error");
  assert.equal(f.timers.size, 0, "failing outright waits for nothing");
});
