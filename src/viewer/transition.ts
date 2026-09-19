/**
 * Photo <-> world presentation layer.
 *  - "photo" mode: the original photograph fills the letterboxed stage (opacity 1)
 *  - enterWorld(): eased crossfade from the photograph into the 3D view
 *  - peek(): hold to see the photograph again (Tab / gamepad LB)
 *  - wipe: draggable divider revealing photo on the left, world on the right
 */
export type Mode = "photo" | "world";

const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

export class PhotoTransition {
  mode: Mode = "photo";
  private opacity = 1;
  private wipeX = 1; // 0..1 fraction of stage width showing the photo (1 = full photo)
  private wipeOn = false;
  private anim: number | null = null;
  private peeking = false;
  onMode?: (m: Mode) => void;
  private readonly overlay: HTMLImageElement;
  private readonly handle: HTMLElement;

  constructor(overlay: HTMLImageElement, handle: HTMLElement, stage: HTMLElement) {
    this.overlay = overlay;
    this.handle = handle;
    let dragging = false;
    const setFromEvent = (e: PointerEvent) => {
      const r = stage.getBoundingClientRect();
      this.setWipe((e.clientX - r.left) / r.width);
    };
    handle.addEventListener("pointerdown", (e) => {
      dragging = true;
      handle.setPointerCapture(e.pointerId);
      e.stopPropagation();
    });
    handle.addEventListener("pointermove", (e) => dragging && setFromEvent(e));
    handle.addEventListener("pointerup", () => (dragging = false));
    this.render();
  }

  hasPhoto(): boolean {
    return !!this.overlay.getAttribute("src");
  }

  showPhoto() {
    this.cancel();
    this.mode = "photo";
    this.opacity = 1;
    this.wipeOn = false;
    this.render();
    this.onMode?.(this.mode);
  }

  /** Crossfade photo -> world over `ms`. Resolves when done. */
  enterWorld(ms = 1400): Promise<void> {
    this.cancel();
    this.wipeOn = false;
    this.peeking = false;
    return new Promise((resolve) => {
      const t0 = performance.now();
      const step = () => {
        const t = Math.min(1, (performance.now() - t0) / ms);
        this.opacity = 1 - ease(t);
        if (t >= 1) this.mode = "world"; // before render(): photo mode forces opacity 1
        this.render();
        if (t < 1) this.anim = requestAnimationFrame(step);
        else {
          this.anim = null;
          this.onMode?.(this.mode);
          resolve();
        }
      };
      this.anim = requestAnimationFrame(step);
    });
  }

  /** Hold-to-compare: photograph on top while `on`. */
  peek(on: boolean) {
    if (this.mode !== "world" || this.peeking === on) return;
    this.peeking = on;
    this.render();
  }

  toggleWipe(on?: boolean) {
    this.wipeOn = on ?? !this.wipeOn;
    if (this.wipeOn && (this.wipeX <= 0.02 || this.wipeX >= 0.98)) this.wipeX = 0.5;
    this.render();
  }
  get wipeActive() {
    return this.wipeOn;
  }
  setWipe(x: number) {
    this.wipeX = Math.max(0, Math.min(1, x));
    this.render();
  }
  /** Direct opacity control for the dev HUD slider. */
  setOpacity(o: number) {
    this.opacity = o;
    this.render();
  }

  private cancel() {
    if (this.anim !== null) cancelAnimationFrame(this.anim);
    this.anim = null;
  }

  private render() {
    const o = this.mode === "photo" ? 1 : this.peeking ? 1 : this.wipeOn ? 1 : this.opacity;
    const show = this.hasPhoto() && o > 0.001;
    this.overlay.style.display = show ? "block" : "none";
    this.overlay.style.opacity = String(o);
    if (this.wipeOn && this.mode === "world" && !this.peeking) {
      this.overlay.style.clipPath = `inset(0 ${(1 - this.wipeX) * 100}% 0 0)`;
      this.handle.style.display = "block";
      this.handle.style.left = `${this.wipeX * 100}%`;
    } else {
      this.overlay.style.clipPath = "none";
      this.handle.style.display = "none";
    }
  }
}
