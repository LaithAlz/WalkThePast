/**
 * First-person controller for Phase 1.
 *
 * Standard pointer-lock mouselook. Click the viewport to capture the cursor;
 * from then on the browser reports raw mouse deltas with no window to run out
 * of, so yaw is unbounded, pitch is clamped just short of vertical, and the
 * movement you make with your hand is the movement the view makes. Nothing is
 * smoothed, eased, accelerated or auto-turned.
 *
 *  - click the canvas: capture the cursor
 *  - mouse: look. Left/right yaws without limit, up/down pitches to ±89°
 *  - W / S: walk along the camera's horizontal heading; A / D strafe
 *  - Shift run; Q/C height in development fly mode
 *  - M: release the cursor and open the pause menu
 *  - touch: one-finger swipe looks, since a touchscreen cannot lock a pointer
 *  - gamepad: left stick walk, right stick look, LT/RT run
 *
 * Yaw/pitch are the source of truth; call syncFromCamera() after setting the
 * camera pose from elsewhere (reset-to-photographer, saved poses).
 *
 * Escape is not ours. The browser spends it leaving pointer lock and leaving
 * fullscreen, and a page cannot preventDefault its way out of either, so it is
 * never bound here — it simply releases the cursor, which pointerlockchange
 * reports like any other release. M is the deliberate way out.
 *
 * This replaced two controllers that steered with a visible cursor, one by
 * accumulating deltas with a turn rate in an edge margin and one by mapping
 * cursor position to a turn rate over the whole canvas. Both drifted, for the
 * same reason: the cursor is bounded by the window and yaw is not, so
 * something had to convert "the cursor ran out of screen" into "keep turning",
 * and whatever did that broke the correspondence between hand and view.
 * Pointer lock removes the bound instead of trading around it.
 */
import * as THREE from "three";
import type { WalkingMotor } from "./walking";

/** Just short of straight up or down, so the view can never flip over. */
const PITCH_LIMIT = (89 * Math.PI) / 180;
/** Starting look multiplier, for someone who has never touched the slider. */
export const DEFAULT_SENSITIVITY = 2.5;

const MOVE_KEYS: Record<string, [number, number, number]> = {
  KeyW: [0, 0, -1], KeyS: [0, 0, 1], KeyA: [-1, 0, 0], KeyD: [1, 0, 0],
  ArrowUp: [0, 0, -1], ArrowDown: [0, 0, 1], ArrowLeft: [-1, 0, 0], ArrowRight: [1, 0, 0],
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export class FirstPersonControls {
  yaw = 0;
  pitch = 0;
  moveSpeed = 1.6; // world units (metres for metric worlds) per second
  runMultiplier = 2.5;
  /** rad per pixel of raw mouse movement, before sensitivity. Pointer lock
   * reports hardware deltas, so this is applied exactly as it arrives: no
   * smoothing and no acceleration, because a hand that moves twice as far
   * should turn the view twice as far and nothing else. */
  lookSpeed = 0.0025;
  /** rad per pixel of touch swipe. */
  swipeSpeed = 0.004;
  /** User multiplier over every look rate. See setSensitivity. */
  sensitivity = DEFAULT_SENSITIVITY;
  padLookSpeed = 2.2; // rad/s at full deflection
  enabled = true;
  /** True while the browser is holding the cursor for us. */
  locked = false;
  /** A finger is down. Touch only: a mouse looks through the lock. */
  dragging = false;
  paused = false;
  /** Fires for gamepad buttons on press (edge). */
  onPadButton?: (index: number) => void;
  onPauseRequest?: () => void;
  onResumeRequest?: () => void;
  /** Fires whenever the browser takes or gives back the cursor, including the
   * releases we did not ask for: Escape, tab switches, window blur. */
  onLockChange?: (locked: boolean) => void;
  motor: WalkingMotor | null = null;
  flyMode = false;
  private touchMove = new THREE.Vector2();

  private readonly canvas: HTMLCanvasElement;
  private readonly camera: THREE.PerspectiveCamera;
  private keys = new Set<string>();
  private padPrev: boolean[] = [];
  private euler = new THREE.Euler(0, 0, 0, "YXZ");
  private v = new THREE.Vector3();
  private teardown: Array<() => void> = [];
  /** Previous touch point, for the swipe delta. */
  private swipeX = 0;
  private swipeY = 0;
  /** Set by look input, consumed by update() to report that a frame is needed. */
  private looked = false;

  constructor(canvas: HTMLCanvasElement, camera: THREE.PerspectiveCamera) {
    this.canvas = canvas;
    this.camera = camera;

    this.on(canvas, "pointerdown", (e) => {
      const pe = e as PointerEvent;
      if (!this.enabled || this.paused || pe.button !== 0) return;
      // Clicking the viewport is how you get in, every time: first entry and
      // every re-entry after the cursor has been given back.
      if (pe.pointerType === "mouse") {
        this.requestLock();
        return;
      }
      // A touchscreen cannot lock a pointer, so a finger down starts a swipe.
      this.dragging = true;
      this.swipeX = pe.clientX;
      this.swipeY = pe.clientY;
      capturePointer(canvas, pe.pointerId);
      pe.preventDefault();
    });
    this.on(canvas, "pointermove", (e) => {
      const pe = e as PointerEvent;
      if (!this.enabled || this.paused || pe.pointerType === "mouse" || !this.dragging) return;
      const scale = this.swipeSpeed * this.sensitivity;
      this.look((pe.clientX - this.swipeX) * scale, (pe.clientY - this.swipeY) * scale);
      this.swipeX = pe.clientX;
      this.swipeY = pe.clientY;
    });
    const endSwipe = (e: Event) => {
      const pe = e as PointerEvent;
      if (!this.dragging) return;
      this.dragging = false;
      releasePointer(canvas, pe.pointerId);
    };
    this.on(canvas, "pointerup", endSwipe);
    this.on(canvas, "pointercancel", endSwipe);
    // Raw hardware deltas, applied exactly as they arrive. movementX/Y is only
    // meaningful while the lock is ours, so the guard is the whole gate.
    this.on(document, "mousemove", (e) => {
      if (!this.locked || !this.enabled || this.paused) return;
      const me = e as MouseEvent;
      const scale = this.lookSpeed * this.sensitivity;
      this.look((me.movementX || 0) * scale, (me.movementY || 0) * scale);
    });
    this.on(document, "pointerlockchange", () => this.readLock());
    // A refused request leaves us unlocked, which is already the state the UI
    // shows, so there is nothing to do but not throw.
    this.on(document, "pointerlockerror", () => this.readLock());
    // The wheel does not steer any more, but it must still not scroll the page
    // or trigger the browser's back/forward swipe gesture.
    this.on(canvas, "wheel", (e) => {
      if (!this.enabled || (e as WheelEvent).ctrlKey) return; // ctrl/pinch is the browser's zoom
      e.preventDefault();
    }, { passive: false });
    this.on(document, "keydown", (e) => {
      const ev = e as KeyboardEvent;
      if (!this.enabled || isTyping(ev)) return;
      if (ev.code === "KeyM") {
        ev.preventDefault();
        if (this.paused) this.onResumeRequest?.();
        else { this.releaseLock(); this.clearInput(); this.onPauseRequest?.(); }
        return;
      }
      if (this.paused) return;
      if (ev.code in MOVE_KEYS || ev.code === "ShiftLeft" || ev.code === "ShiftRight" ||
        (this.flyMode && (ev.code === "KeyQ" || ev.code === "KeyC"))) {
        this.keys.add(ev.code);
        ev.preventDefault();
      }
    });
    this.on(document, "keyup", (e) => this.keys.delete((e as KeyboardEvent).code));
    this.on(window, "blur", () => this.clearInput());
    this.on(document, "visibilitychange", () => { if (document.hidden) this.clearInput(); });
  }

  /** Apply a look delta in radians. The only path to yaw and pitch. */
  private look(dYaw: number, dPitch: number) {
    if (!dYaw && !dPitch) return;
    this.yaw -= dYaw;
    this.pitch = clamp(this.pitch - dPitch, -PITCH_LIMIT, PITCH_LIMIT);
    this.looked = true;
  }

  /** Ask the browser for the cursor. Safe to call when already locked, when
   * the API is missing, and when the browser is refusing — a refusal simply
   * leaves the click-to-look prompt up. */
  requestLock() {
    if (this.locked || this.paused || !this.enabled) return;
    try {
      // Chrome rejects a request made too soon after the user pressed Escape,
      // and returns a promise to say so rather than throwing.
      const pending = this.canvas.requestPointerLock?.() as unknown as Promise<void> | undefined;
      if (pending && typeof pending.catch === "function") pending.catch(() => { /* prompt stays up */ });
    } catch { /* unsupported, or refused synchronously */ }
  }

  /** Give the cursor back. */
  releaseLock() {
    try { document.exitPointerLock?.(); } catch { /* already released */ }
  }

  private readLock() {
    const locked = typeof document !== "undefined" && document.pointerLockElement === this.canvas;
    if (locked === this.locked) return;
    this.locked = locked;
    // Losing the lock must not leave a key stuck down: whatever took it away
    // (Escape, a tab switch, our own menu) means the player has stopped.
    if (!locked) this.clearInput();
    this.onLockChange?.(locked);
  }

  clearInput() {
    this.keys.clear();
    this.touchMove.set(0, 0);
    this.dragging = false;
    this.canvas.style.cursor = "";
    this.motor?.stop();
  }

  /** Hand input to, or take it from, the world. The photo landing and the entity
   * portal both put something else on screen and must not be steered through. */
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled) {
      this.releaseLock();
      this.clearInput();
    }
  }

  setPaused(paused: boolean) {
    this.paused = paused;
    if (paused) {
      this.releaseLock();
      this.clearInput();
    }
  }

  setTouchMove(x: number, z: number) { this.touchMove.set(x, z).clampLength(0, 1); }

  /** Correct look speed depends on the mouse's own DPI, so it is the user's to
   * set. It scales the delta and nothing else: no curve, no acceleration. */
  setSensitivity(value: number) {
    if (Number.isFinite(value)) this.sensitivity = clamp(value, 0.25, 3);
  }

  setMotor(motor: WalkingMotor | null) {
    this.clearInput();
    this.motor = motor;
    this.paused = false;
    this.flyMode = false;
    if (motor?.ready) this.camera.position.copy(motor.eye);
  }

  private on(target: EventTarget, type: string, handler: (e: Event) => void, options?: AddEventListenerOptions) {
    target.addEventListener(type, handler, options);
    this.teardown.push(() => target.removeEventListener(type, handler, options));
  }

  /** Release every listener. React mounts this twice under StrictMode, so it must be undoable. */
  dispose() {
    for (const off of this.teardown) off();
    this.teardown = [];
    this.keys.clear();
    this.dragging = false;
    this.canvas.style.cursor = "";
    this.enabled = false;
    if (this.locked) this.releaseLock();
  }

  /** Adopt the camera's current orientation (drops roll). */
  syncFromCamera() {
    this.euler.setFromQuaternion(this.camera.quaternion, "YXZ");
    this.yaw = this.euler.y;
    this.pitch = clamp(this.euler.x, -PITCH_LIMIT, PITCH_LIMIT);
    this.applyRotation();
  }

  private applyRotation() {
    this.euler.set(this.pitch, this.yaw, 0, "YXZ");
    this.camera.quaternion.setFromEuler(this.euler);
  }

  /** @returns true if the camera moved or turned this frame */
  update(dt: number): boolean {
    if (!this.enabled || this.paused) return false;
    let mx = this.touchMove.x, mz = this.touchMove.y, run = false;
    let moved = this.looked;
    this.looked = false;
    for (const k of this.keys) {
      const d = MOVE_KEYS[k];
      if (d) { mx += d[0]; mz += d[2]; }
    }
    if (this.keys.has("ShiftLeft") || this.keys.has("ShiftRight")) run = true;

    // gamepad
    const pads = navigator.getGamepads?.() ?? [];
    const pad = pads.find((p) => p && p.connected);
    if (pad) {
      const dz = (v: number) => (Math.abs(v) < 0.15 ? 0 : v);
      mx += dz(pad.axes[0] ?? 0);
      mz += dz(pad.axes[1] ?? 0);
      const lx = dz(pad.axes[2] ?? 0), ly = dz(pad.axes[3] ?? 0);
      // A stick is a rate device: it rests at centre and cannot report a delta.
      if (lx || ly) {
        this.look(lx * this.padLookSpeed * this.sensitivity * dt, ly * this.padLookSpeed * this.sensitivity * dt);
        moved = true;
      }
      if ((pad.buttons[6]?.value ?? 0) > 0.5 || (pad.buttons[7]?.value ?? 0) > 0.5) run = true;
      pad.buttons.forEach((b, i) => {
        const now = b.pressed;
        if (now && !this.padPrev[i]) this.onPadButton?.(i);
        this.padPrev[i] = now;
      });
    } else this.padPrev = [];

    // Walk along the camera's horizontal heading; pitch never tilts the floor.
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    this.v.set(mx * cos + mz * sin, 0, mz * cos - mx * sin);
    if (this.flyMode) {
      this.v.y = Number(this.keys.has("KeyQ")) - Number(this.keys.has("KeyC"));
      if (this.v.lengthSq() > 1) this.v.normalize();
      this.camera.position.addScaledVector(this.v, this.moveSpeed * (run ? this.runMultiplier : 1) * dt);
    } else if (this.motor) {
      this.motor.update(dt, this.v, run);
      moved = moved || this.camera.position.distanceToSquared(this.motor.eye) > 1e-10;
      this.camera.position.copy(this.motor.eye);
    }
    this.applyRotation();
    return moved;
  }
}

/** Capture keeps a drag alive outside the canvas. Both calls throw on a pointer
 * the browser no longer considers active, which must not abort the handler. */
function capturePointer(canvas: HTMLCanvasElement, id: number) {
  try { canvas.setPointerCapture?.(id); } catch { /* drag still works, just not past the edge */ }
}

function releasePointer(canvas: HTMLCanvasElement, id: number) {
  try { canvas.releasePointerCapture?.(id); } catch { /* already released with the pointer */ }
}

export function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
}
