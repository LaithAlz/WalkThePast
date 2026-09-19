export type NarrationState = "idle" | "buffering" | "playing";

export interface NarrationWord {
  word: string;
  start: number;
  end: number;
}

export interface TimedNarration {
  /** A complete, base64 encoded WAV, paired with timestamps from this audio. */
  audio: string;
  words: NarrationWord[];
}

type NarrationAudio = Pick<HTMLAudioElement,
  "currentTime" | "duration" | "paused" | "src" | "preload" |
  "play" | "pause" | "load" | "removeAttribute" | "addEventListener" | "removeEventListener"
>;

export interface NarrationDependencies {
  createAudio: () => NarrationAudio;
  createAudioUrl: (base64: string) => string;
  revokeAudioUrl: (url: string) => void;
  requestFrame: (callback: () => void) => number;
  cancelFrame: (id: number) => void;
}

export interface TimedNarrationPlayerOptions {
  load: (text: string, signal: AbortSignal) => Promise<TimedNarration>;
  onCaption: (caption: string) => void;
  onState: (state: NarrationState) => void;
  onError: (error: Error) => void;
  onComplete?: () => void;
  onReplayAvailable?: (available: boolean) => void;
  deps?: Partial<NarrationDependencies>;
}

export const MAX_NARRATION_CHARS = 1600;
export const MAX_NARRATION_WORDS = 250;
const MAX_PENDING_CHARS = 16000;
const MAX_PENDING_CLIPS = 64;
const MAX_AUDIO_BASE64_CHARS = 48 * 1024 * 1024;
const MAX_AUDIO_SECONDS = 300;
const PREFETCH_CLIPS = 2;
const WORDS_PER_CARD = 14;

interface QueuedClip {
  text: string;
  status: "queued" | "loading" | "ready";
  controller?: AbortController;
  narration?: TimedNarration;
}

interface ActiveClip {
  text: string;
  narration: TimedNarration;
  audio: NarrationAudio;
  url: string;
  generation: number;
  prefix: string[];
  playing: boolean;
  endedWhilePaused: boolean;
  playAttempt: number;
  listeners: Array<[string, EventListener]>;
}

function createAudioUrl(base64: string): string {
  const binary = atob(base64);
  if (binary.slice(0, 4) !== "RIFF" || binary.slice(8, 12) !== "WAVE") {
    throw new Error("Narration did not contain a complete WAV audio file.");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
}

function validateNarration(narration: TimedNarration, text: string): TimedNarration {
  if (!narration || typeof narration.audio !== "string" || !narration.audio.length || narration.audio.length > MAX_AUDIO_BASE64_CHARS) {
    throw new Error("Narration audio is missing or exceeds the playback limit.");
  }
  const expected = text.split(/\s+/u);
  if (!Array.isArray(narration.words) || narration.words.length !== expected.length) {
    throw new Error("Narration is missing accurate word timestamps. Please try again.");
  }
  let previousStart = -1;
  const words = narration.words.map((word, index) => {
    if (!word || word.word !== expected[index] || !Number.isFinite(word.start) || !Number.isFinite(word.end) ||
      word.start < 0 || word.start < previousStart || word.end < word.start || word.end > MAX_AUDIO_SECONDS) {
      throw new Error("Narration word timestamps do not match the spoken text. Please try again.");
    }
    previousStart = word.start;
    return { word: word.word, start: word.start, end: word.end };
  });
  return { audio: narration.audio, words };
}

/** Reveal words using only the media playhead, including after a delayed frame. */
export function captionAtTime(words: NarrationWord[], currentTime: number, prefix: string[] = []): string {
  if (!Number.isFinite(currentTime) || currentTime < 0) return prefix.join(" ");
  let low = 0;
  let high = words.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (words[middle].start <= currentTime) low = middle + 1;
    else high = middle;
  }
  const visible = [...prefix, ...words.slice(0, low).map((word) => word.word)];
  const cardStart = Math.max(0, Math.floor((visible.length - 1) / WORDS_PER_CARD) * WORDS_PER_CARD);
  return visible.slice(cardStart).join(" ");
}

/**
 * Finite audio clips replace an unseekable live stream. Text never has its own
 * clock: every caption reads the exact audio element currently being heard.
 */
export class TimedNarrationPlayer {
  private readonly options: TimedNarrationPlayerOptions;
  private readonly deps: NarrationDependencies;
  private queue: QueuedClip[] = [];
  private active: ActiveClip | null = null;
  private last: { text: string; narration: TimedNarration } | null = null;
  private card: string[] = [];
  private caption = "";
  private currentState: NarrationState = "idle";
  private replayAvailable = false;
  private paused = false;
  private disposed = false;
  private inputFinished = true;
  private completionSent = true;
  private generation = 0;
  private frame: number | null = null;

  constructor(options: TimedNarrationPlayerOptions) {
    this.options = options;
    this.deps = {
      createAudio: () => new Audio(),
      createAudioUrl,
      revokeAudioUrl: (url) => URL.revokeObjectURL(url),
      requestFrame: (callback) => requestAnimationFrame(callback),
      cancelFrame: (id) => cancelAnimationFrame(id),
      ...options.deps,
    };
  }

  get state(): NarrationState { return this.currentState; }

  get canReplay(): boolean {
    return !this.disposed && this.inputFinished && !this.active && this.queue.length === 0 && this.last !== null;
  }

  enqueue(text: string): void {
    if (this.disposed) return;
    const normalized = text.trim().replace(/\s+/gu, " ");
    if (!normalized) return;
    const pendingChars = this.queue.reduce((total, clip) => total + clip.text.length, this.active?.text.length ?? 0);
    if (normalized.length > MAX_NARRATION_CHARS || normalized.split(" ").length > MAX_NARRATION_WORDS ||
      pendingChars + normalized.length > MAX_PENDING_CHARS || this.queue.length >= MAX_PENDING_CLIPS) {
      this.fail(new Error("Narration exceeds the buffered playback limit. Please try a shorter question."));
      return;
    }
    this.inputFinished = false;
    this.completionSent = false;
    this.queue.push({ text: normalized, status: "queued" });
    this.pump();
  }

  /** Call only after the complete response, including tool continuations. */
  finish(): void {
    if (this.disposed) return;
    this.inputFinished = true;
    this.pump();
  }

  pause(): void {
    if (this.disposed || this.paused) return;
    if (this.active?.playing && !this.active.audio.paused) this.syncCaption(this.active);
    this.paused = true;
    this.stopFrame();
    if (this.active) {
      this.active.playAttempt += 1;
      this.active.playing = false;
      this.active.audio.pause();
    }
    this.updateState();
  }

  resume(): void {
    if (this.disposed || !this.paused) return;
    this.paused = false;
    if (this.active?.endedWhilePaused) this.completeClip(this.active);
    else if (this.active) this.play(this.active);
    else this.pump();
  }

  /** Cancel all speech but preserve transport pause intent. */
  reset(): void {
    this.generation += 1;
    this.stopFrame();
    const active = this.active;
    this.active = null;
    if (active) this.release(active);
    for (const clip of this.queue) clip.controller?.abort();
    this.queue = [];
    this.last = null;
    this.card = [];
    this.inputFinished = true;
    this.completionSent = true;
    this.setCaption("");
    this.updateState();
  }

  dispose(): void {
    this.reset();
    this.disposed = true;
  }

  /** Replay the last completed sentence from its cached audio and timestamps. */
  replayLast(): boolean {
    if (!this.canReplay || this.paused || !this.last) return false;
    const last = this.last;
    this.reset();
    this.queue.push({ text: last.text, narration: last.narration, status: "ready" });
    this.completionSent = false;
    this.pump();
    return true;
  }

  private pump(): void {
    if (this.disposed) return;
    // Only a small window is fetched; later sentences cannot overtake its head.
    for (const clip of this.queue.slice(0, PREFETCH_CLIPS)) {
      if (clip.status !== "queued") continue;
      clip.status = "loading";
      const controller = new AbortController();
      clip.controller = controller;
      const generation = this.generation;
      void Promise.resolve().then(() => {
        if (generation !== this.generation || controller.signal.aborted) return null;
        return this.options.load(clip.text, controller.signal);
      }).then((narration) => {
        if (generation !== this.generation || controller.signal.aborted || !this.queue.includes(clip)) return;
        clip.narration = validateNarration(narration!, clip.text);
        clip.status = "ready";
        clip.controller = undefined;
        this.pump();
      }).catch((error: unknown) => {
        if (generation === this.generation && !controller.signal.aborted) this.fail(error);
      });
    }
    if (!this.active && !this.paused && this.queue[0]?.status === "ready") {
      const clip = this.queue.shift()!;
      this.start(clip);
      this.pump();
      return;
    }
    this.updateState();
    if (this.inputFinished && !this.active && this.queue.length === 0 && !this.completionSent) {
      this.completionSent = true;
      this.options.onComplete?.();
    }
  }

  private start(clip: QueuedClip): void {
    try {
      const audio = this.deps.createAudio();
      const active: ActiveClip = {
        text: clip.text,
        narration: clip.narration!,
        audio,
        url: this.deps.createAudioUrl(clip.narration!.audio),
        generation: this.generation,
        prefix: [...this.card],
        playing: false,
        endedWhilePaused: false,
        playAttempt: 0,
        listeners: [],
      };
      this.active = active;
      const listen = (event: string, callback: () => void) => {
        const listener: EventListener = () => { if (this.isCurrent(active)) callback(); };
        active.listeners.push([event, listener]);
        audio.addEventListener(event, listener);
      };
      listen("loadedmetadata", () => this.validateDuration(active));
      listen("durationchange", () => this.validateDuration(active));
      listen("playing", () => this.didPlay(active));
      listen("timeupdate", () => {
        if (!this.paused && !audio.paused) this.syncCaption(active);
      });
      for (const event of ["waiting", "stalled", "pause"]) {
        listen(event, () => {
          active.playing = false;
          this.stopFrame();
          this.updateState();
        });
      }
      listen("error", () => this.fail(new Error("The buffered narration could not be played. Please try again.")));
      listen("ended", () => {
        if (this.paused) active.endedWhilePaused = true;
        else this.completeClip(active);
      });
      audio.preload = "auto";
      audio.src = active.url;
      this.play(active);
    } catch (error) {
      this.fail(error);
    }
  }

  private play(active: ActiveClip): void {
    if (!this.isCurrent(active) || this.paused) return;
    const attempt = ++active.playAttempt;
    this.updateState();
    try {
      void Promise.resolve(active.audio.play()).then(() => {
        // play() can settle after reset/pause, even when a browser ignores aborts.
        if (!this.isCurrent(active) || this.paused) {
          active.audio.pause();
          return;
        }
        if (active.playAttempt === attempt && !active.audio.paused) this.didPlay(active);
      }).catch((error: unknown) => {
        if (!this.isCurrent(active) || this.paused || active.playAttempt !== attempt) return;
        this.fail(error);
      });
    } catch (error) {
      this.fail(error);
    }
  }

  private didPlay(active: ActiveClip): void {
    if (!this.isCurrent(active)) return;
    if (this.paused) {
      active.audio.pause();
      return;
    }
    if (!this.validateDuration(active)) return;
    active.playing = true;
    this.syncCaption(active);
    this.updateState();
    this.scheduleFrame(active);
  }

  private validateDuration(active: ActiveClip): boolean {
    const duration = active.audio.duration;
    if (!Number.isNaN(duration) && (!Number.isFinite(duration) || duration <= 0 || duration > MAX_AUDIO_SECONDS ||
      active.narration.words.some((word) => word.start > duration || word.end > duration + 0.15))) {
      this.fail(new Error("Narration timestamps exceed the audio duration. Please try again."));
      return false;
    }
    return true;
  }

  private scheduleFrame(active: ActiveClip): void {
    if (this.frame !== null || !this.isCurrent(active) || this.paused || !active.playing) return;
    const frame = this.deps.requestFrame(() => {
      if (this.frame !== frame) return;
      this.frame = null;
      if (!this.isCurrent(active) || this.paused || !active.playing) return;
      this.syncCaption(active);
      this.scheduleFrame(active);
    });
    this.frame = frame;
  }

  private completeClip(active: ActiveClip): void {
    if (!this.isCurrent(active)) return;
    this.syncCaption(active);
    this.card = this.caption ? this.caption.split(" ") : [];
    this.last = { text: active.text, narration: active.narration };
    this.active = null;
    this.stopFrame();
    this.release(active);
    this.pump();
  }

  private syncCaption(active: ActiveClip): void {
    this.setCaption(captionAtTime(active.narration.words, active.audio.currentTime, active.prefix));
  }

  private setCaption(caption: string): void {
    if (this.caption === caption) return;
    this.caption = caption;
    this.options.onCaption(caption);
  }

  private updateState(): void {
    const state: NarrationState = this.active?.playing && !this.paused ? "playing"
      : this.active || this.queue.length || !this.inputFinished ? "buffering" : "idle";
    if (state !== this.currentState) {
      this.currentState = state;
      this.options.onState(state);
    }
    const canReplay = this.canReplay;
    if (canReplay !== this.replayAvailable) {
      this.replayAvailable = canReplay;
      this.options.onReplayAvailable?.(canReplay);
    }
  }

  private isCurrent(active: ActiveClip): boolean {
    return !this.disposed && this.active === active && active.generation === this.generation;
  }

  private stopFrame(): void {
    if (this.frame !== null) this.deps.cancelFrame(this.frame);
    this.frame = null;
  }

  private release(active: ActiveClip): void {
    for (const [event, listener] of active.listeners) active.audio.removeEventListener(event, listener);
    active.audio.pause();
    active.audio.removeAttribute("src");
    active.audio.load();
    this.deps.revokeAudioUrl(active.url);
  }

  private fail(error: unknown): void {
    this.reset();
    const name = error && typeof error === "object" && "name" in error ? error.name : "";
    const message = error && typeof error === "object" && "message" in error ? String(error.message) : "Narration could not be prepared. Please try again.";
    this.options.onError(new Error(name === "NotAllowedError"
      ? "Audio playback was blocked by your browser. Start voice again to allow playback."
      : message));
  }
}
