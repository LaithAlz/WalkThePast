import type { WorldIndexEntry } from "./world";

type Slider = { input: HTMLInputElement; out: HTMLOutputElement };

export interface HudCallbacks {
  onWorldChange(id: string): void;
  onOverlay(opacity: number): void;
  onFov(deg: number): void;
  onSpeed(v: number): void;
  onReset(): void;
  onCopyCamera(): void;
  onSavePose(): void;
  onFlip(): void;
  onGrid(): void;
  onBench(): void;
  onCache(): void;
  onWipe(): void;
  onPhoto(): void;
}

export class Hud {
  root: HTMLElement;
  private status!: HTMLElement;
  private stats: Record<string, HTMLElement> = {};
  private sliders: Record<string, Slider> = {};
  private select!: HTMLSelectElement;
  private textarea!: HTMLTextAreaElement;
  private frames = 0;
  private lastFpsAt = performance.now();
  private frameTimes: number[] = [];

  constructor(root: HTMLElement, private cb: HudCallbacks) {
    this.root = root;
    root.innerHTML = "";
    const h = document.createElement("h1");
    h.textContent = "WALK THE PAST · phase 0";
    root.append(h);

    const wrow = this.row("world");
    this.select = document.createElement("select");
    this.select.style.flex = "1";
    this.select.onchange = () => cb.onWorldChange(this.select.value);
    wrow.append(this.select);

    this.status = document.createElement("div");
    this.status.className = "status";
    root.append(this.status);

    const stats = document.createElement("div");
    stats.className = "stats";
    for (const k of ["fps", "frame", "splats", "gen", "conv", "cam", "fov", "radius", "cache"]) {
      const a = document.createElement("span");
      a.textContent = k;
      const b = document.createElement("span");
      b.textContent = "–";
      stats.append(a, b);
      this.stats[k] = b;
    }
    root.append(stats);

    this.slider("overlay", 0, 1, 0.01, 0, (v) => cb.onOverlay(v));
    this.slider("fov", 20, 120, 0.5, 60, (v) => cb.onFov(v), "°");
    this.slider("speed", 0.2, 10, 0.1, 2, (v) => cb.onSpeed(v), "m/s");

    const btns = document.createElement("div");
    btns.className = "btns";
    const mk = (label: string, fn: () => void) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.onclick = fn;
      btns.append(b);
    };
    mk("Reset (R)", cb.onReset);
    mk("Copy camera (C)", cb.onCopyCamera);
    mk("Save pose (L)", cb.onSavePose);
    mk("Flip axes (F)", cb.onFlip);
    mk("Grid (G)", cb.onGrid);
    mk("Bench 10s (B)", cb.onBench);
    mk("Wipe (V)", cb.onWipe);
    mk("Show photo", cb.onPhoto);
    mk("Cache world offline", cb.onCache);
    root.append(btns);

    this.textarea = document.createElement("textarea");
    this.textarea.readOnly = true;
    this.textarea.placeholder = "camera JSON / benchmark output";
    root.append(this.textarea);

    const help = document.createElement("div");
    help.className = "help";
    help.innerHTML =
      "<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> move · <kbd>Q</kbd><kbd>E</kbd> down/up · click to look (Esc frees) · " +
      "<kbd>Shift</kbd> faster · <kbd>O</kbd> overlay 0/50/100 · <kbd>[</kbd><kbd>]</kbd> fov · " +
      "<kbd>R</kbd> photographer · <kbd>C</kbd> copy cam · <kbd>L</kbd> save · <kbd>F</kbd> flip · <kbd>G</kbd> grid · <kbd>B</kbd> bench · <kbd>X</kbd> walk radius";
    root.append(help);
  }

  private row(label: string): HTMLElement {
    const r = document.createElement("div");
    r.className = "row";
    const l = document.createElement("label");
    l.textContent = label;
    r.append(l);
    this.root.append(r);
    return r;
  }

  private slider(name: string, min: number, max: number, step: number, value: number, fn: (v: number) => void, unit = "") {
    const r = this.row(name);
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    const out = document.createElement("output");
    const show = () => (out.textContent = `${Number(input.value).toFixed(step < 1 ? 2 : 0)}${unit}`);
    input.oninput = () => {
      show();
      fn(Number(input.value));
    };
    // keep keyboard focus off the slider so WASD keeps working
    input.onpointerup = () => input.blur();
    show();
    r.append(input, out);
    this.sliders[name] = { input, out };
  }

  setSlider(name: string, v: number, fire = true) {
    const s = this.sliders[name];
    if (!s) return;
    s.input.value = String(v);
    s.input.dispatchEvent(new Event("input"));
    if (!fire) return;
  }
  getSlider(name: string): number {
    return Number(this.sliders[name]?.input.value ?? 0);
  }

  setWorlds(list: WorldIndexEntry[], current: string) {
    this.select.innerHTML = "";
    for (const w of list) {
      const o = document.createElement("option");
      o.value = w.id;
      o.textContent = w.name;
      this.select.append(o);
    }
    if (current && !list.some((w) => w.id === current)) {
      const o = document.createElement("option");
      o.value = current;
      o.textContent = current;
      this.select.append(o);
    }
    this.select.value = current;
  }

  setStatus(msg: string, kind: "" | "ok" | "bad" = "") {
    this.status.textContent = msg;
    this.status.className = `status ${kind}`;
  }
  setStat(k: string, v: string) {
    if (this.stats[k]) this.stats[k].textContent = v;
  }
  setText(t: string) {
    this.textarea.value = t;
  }

  /** Call once per rendered frame; updates fps / frame-time readouts every 500 ms. */
  tick(frameMs: number) {
    this.frames++;
    this.frameTimes.push(frameMs);
    const now = performance.now();
    const dt = now - this.lastFpsAt;
    if (dt >= 500) {
      const fps = (this.frames * 1000) / dt;
      const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
      this.setStat("fps", fps.toFixed(0));
      this.setStat("frame", `${avg.toFixed(1)} ms`);
      this.frames = 0;
      this.frameTimes.length = 0;
      this.lastFpsAt = now;
    }
  }
}
