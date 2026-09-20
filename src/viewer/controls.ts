/**
 * First-person controller for Phase 1.
 *
 * Nothing here needs a button held or a pointer captured. The mouse steers by
 * POSITION, not by movement: where the cursor sits inside the canvas sets how
 * fast the view turns, and a rest band around the crosshair holds it still.
 * Point at what you want to look at and the view goes there.
 *
 *  - cursor inside the rest band: nothing turns
 *  - cursor outside it: turns toward the cursor, in both axes, faster the
 *    further out it sits, so a full circle and the ceiling are both reachable
 *  - scroll: turns as well, banked and eased out over a few frames
 *  - touch: one-finger swipe turns, since a touchscreen has no cursor
 *  - WASD grounded capsule movement, Shift run; Q/C height in development fly mode
 *  - M: pause menu. Not Escape, which the browser spends leaving fullscreen.
 *  - gamepad: left stick walk, right stick look, LT/RT run
 *
 * Yaw/pitch are the source of truth; call syncFromCamera() after setting the
 * camera pose from elsewhere (reset-to-photographer, saved poses).
 *
 * This replaced a controller that accumulated cursor deltas in the middle of
 * the canvas and switched to a rate at the edges. Two control laws in one
 * controller cost us both of the bugs that mattered. The pitch clamp threw
 * away the part of a delta it could not spend on the way up but charged the
 * whole of it on the way down, so grazing the ceiling silently re-zeroed the
 * horizon: cursor back where it started, view ten degrees lower. And the edge
 * rate advanced yaw while the cursor stood still, so cursor position stopped
 * predicting the heading at all. One law has neither failure, because nothing
 * accumulates: the cursor's position is the whole of the input, every frame.
 *
 * Turning still only happens while the cursor is over the canvas, so a cursor
 * that has reached an overlay control never spins the world.
 */
import * as THREE from "three";
import type { WalkingMotor } from "./walking";

/** Exponential rate at which banked scroll is spent, per second. */
const WHEEL_EASE = 18;
const PITCH_LIMIT = Math.PI / 2 - 0.02;
/** Half-extent of the rest band at the centre of the canvas, as a fraction of
 * each half-axis. Large enough to park the cursor in without the view creeping,
 * small enough that most of the canvas still steers. */
const LOOK_REST_BAND = 0.16;

const MOVE_KEYS: Record<string, [number, number, number]> = {
  KeyW: [0, 0, -1], KeyS: [0, 0, 1], KeyA: [-1, 0, 0], KeyD: [1, 0, 0],
  ArrowUp: [0, 0, -1], ArrowDown: [0, 0, 1], ArrowLeft: [-1, 0, 0], ArrowRight: [1, 0, 0],
};

export class FirstPersonControls {
  yaw = 0;
  pitch = 0;
  moveSpeed = 1.6; // world units (metres for metric worlds) per second
  runMultiplier = 2.5;
  /** rad per pixel of touch swipe. A mouse never uses this: a cursor has a
   * position to read, and reading it is what keeps the view and the cursor
   * from drifting apart. A finger has no position to come back to. */
  lookSpeed = 0.004;
  /** rad per normalised pixel of scroll, for scroll-to-turn. */
  wheelLookSpeed = 0.0022;
  /** rad/s with the cursor at the very edge of the canvas, in either axis. */
  lookRate = 2.2;
  /** User multiplier over every look rate below. See setSensitivity. */
  sensitivity = 1;
  padLookSpeed = 2.2; // rad/s at full deflection
  enabled = true;
  /** A finger is down. Touch only: a mouse turns by hovering, never by dragging. */
  dragging = false;
  paused = false;
  /** Fires for gamepad buttons on press (edge). */
  onPadButton?: (index: number) => void;
  onPauseRequest?: () => void;
  onResumeRequest?: () => void;
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
  /** Where the cursor sits. Read every frame; never differenced. */
  private cursorX = 0;
  private cursorY = 0;
  /** False until the cursor is known to be over the canvas. */
  private hasPointer = false;
  /** Previous touch point, for the swipe delta. Mouse input never uses these. */
  private swipeX = 0;
  private swipeY = 0;
  /** Scroll banked by the wheel handler, drained a fraction per frame by update(). */
  private wheelYaw = 0;
  private wheelPitch = 0;

  constructor(canvas: HTMLCanvasElement, camera: THREE.PerspectiveCamera) {
    this.canvas = canvas;
    this.camera = camera;

    // A touchscreen has no cursor to follow, so a finger down starts a swipe.
    // A mouse never needs this: it is already turning by moving.
    this.on(canvas, "pointerdown", (e) => {
      const pe = e as PointerEvent;
      if (!this.enabled || this.paused || pe.button !== 0 || pe.pointerType === "mouse") return;
      this.dragging = true;
      this.swipeX = pe.clientX;
      this.swipeY = pe.clientY;
      capturePointer(canvas, pe.pointerId);
      pe.preventDefault();
    });
    this.on(canvas, "pointerenter", (e) => {
      const pe = e as PointerEvent;
      if (!this.enabled || pe.pointerType !== "mouse") return;
      this.cursorX = pe.clientX;
      this.cursorY = pe.clientY;
      this.hasPointer = true;
    });
    this.on(canvas, "pointerleave", (e) => {
      if ((e as PointerEvent).pointerType === "mouse") this.hasPointer = false;
    });
    this.on(canvas, "pointermove", (e) => {
      const pe = e as PointerEvent;
      if (!this.enabled || this.paused) return;
      // A mouse only reports where it is; cursorTurn does the turning, once a
      // frame, from that position alone. Nothing is differenced, so nothing
      // can be lost at the pitch clamp or gained while the cursor stands still.
      if (pe.pointerType === "mouse") {
        this.cursorX = pe.clientX;
        this.cursorY = pe.clientY;
        this.hasPointer = true;
        return;
      }
      // Touch has no cursor to read, so a finger down turns by its own delta.
      if (!this.dragging) return;
      const scale = this.lookSpeed * this.sensitivity;
      this.yaw -= (pe.clientX - this.swipeX) * scale;
      this.pitch -= (pe.clientY - this.swipeY) * scale;
      this.swipeX = pe.clientX;
      this.swipeY = pe.clientY;
      this.clampPitch();
    });
    const endSwipe = (e: Event) => {
      const pe = e as PointerEvent;
      if (!this.dragging) return;
      this.dragging = false;
      releasePointer(canvas, pe.pointerId);
    };
    this.on(canvas, "pointerup", endSwipe);
    this.on(canvas, "pointercancel", endSwipe);
    // Scroll to turn, always on: no click, no capture, no held button. This is
    // the natural gesture on a trackpad, where a two-finger swipe gives both
    // axes. preventDefault matters twice over — it stops the page scrolling and
    // stops a horizontal swipe triggering the browser's back/forward gesture.
    this.on(canvas, "wheel", (e) => {
      const we = e as WheelEvent;
      if (!this.enabled || this.paused) return;
      if (we.ctrlKey) return; // ctrl/pinch wheel is the browser's zoom, not ours
      we.preventDefault();
      // deltaMode is pixels, lines or pages depending on the device.
      const unit = we.deltaMode === 1 ? 16 : we.deltaMode === 2 ? (canvas.clientHeight || 800) : 1;
      const rate = this.wheelLookSpeed * this.sensitivity * unit;
      // Banked rather than applied, so update() can ease it out over several frames.
      this.wheelYaw -= we.deltaX * rate;
      this.wheelPitch -= we.deltaY * rate;
    }, { passive: false });
    this.on(document, "keydown", (e) => {
      const ev = e as KeyboardEvent;
      if (!this.enabled || isTyping(ev)) return;
      if (ev.code === "KeyM") {
        // Not Escape: the browser spends that key leaving fullscreen, and a page
        // cannot preventDefault its way out of that. M is ours to keep.
        ev.preventDefault();
        if (this.paused) this.onResumeRequest?.();
        else { this.clearInput(); this.onPauseRequest?.(); }
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

  clearInput() {
    this.keys.clear();
    this.touchMove.set(0, 0);
    this.dragging = false;
    this.hasPointer = false;
    this.wheelYaw = 0;
    this.wheelPitch = 0;
    this.canvas.style.cursor = "";
    this.motor?.stop();
  }

  /** Hand input to, or take it from, the world. The photo landing and the entity
   * portal both put something else on screen and must not be steered through. */
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    // Drop the cursor reference in both directions. The pointer keeps moving
    // while input is taken away, so the next move has to measure from wherever
    // it is now rather than from where it was when we stopped watching.
    this.hasPointer = false;
    if (!enabled) this.clearInput();
  }

  setPaused(paused: boolean) {
    this.paused = paused;
    if (paused) this.clearInput();
  }

  setTouchMove(x: number, z: number) { this.touchMove.set(x, z).clampLength(0, 1); }

  /** Ease out banked scroll so a notched wheel glides instead of stepping, and
   * a trackpad flick keeps coasting after the fingers lift.
   * @returns true if the camera turned this frame */
  private drainWheel(dt: number): boolean {
    if (!this.wheelYaw && !this.wheelPitch) return false;
    const k = Math.min(1, 1 - Math.exp(-WHEEL_EASE * dt));
    // Settle the remainder outright once it is too small to see, so the ease
    // terminates instead of chasing an ever-smaller tail.
    const take = (pending: number) => (Math.abs(pending) < 1e-4 ? pending : pending * k);
    const yaw = take(this.wheelYaw), pitch = take(this.wheelPitch);
    this.wheelYaw -= yaw;
    this.wheelPitch -= pitch;
    this.yaw += yaw;
    this.pitch += pitch;
    this.clampPitch();
    // Do not bank rotation the clamp will not let us spend, or it unwinds later.
    if ((this.pitch >= PITCH_LIMIT && this.wheelPitch > 0) ||
      (this.pitch <= -PITCH_LIMIT && this.wheelPitch < 0)) this.wheelPitch = 0;
    return true;
  }

  /** Turn toward wherever the cursor is sitting, in both axes.
   *
   * The whole of the input is the cursor's position this frame, so the view
   * cannot drift away from it: there is no running total to lose a clamped
   * degree from, and none to gain a degree the cursor never asked for. Park
   * the cursor in the rest band and the view is still, every time, whatever
   * happened before.
   *
   * Both axes, equally. Pitch used to be excluded because its clamp is only a
   * quarter turn away and the delta law could cross that in one sweep; a rate
   * cannot overshoot a clamp, and excluding it was what made looking up feel
   * unlike looking sideways.
   *
   * @returns true if the camera turned this frame
   */
  private cursorTurn(dt: number): boolean {
    // hasPointer is mouse-only and false once the cursor leaves the canvas, so
    // this never runs while the cursor is parked on a control or off-window.
    if (!this.hasPointer) return false;
    const bounds = this.canvas.getBoundingClientRect?.();
    if (!bounds || !(bounds.width > 0) || !(bounds.height > 0)) return false;
    if (!Number.isFinite(this.cursorX) || !Number.isFinite(this.cursorY)) return false;
    const x = deflection((this.cursorX - bounds.left) / bounds.width);
    const y = deflection((this.cursorY - bounds.top) / bounds.height);
    if (!x && !y) return false;
    const rate = this.lookRate * this.sensitivity * dt;
    this.yaw -= x * rate;
    this.pitch -= y * rate;
    this.clampPitch();
    return true;
  }

  /** Correct look speed depends on the mouse's own DPI, so it is the user's to set. */
  setSensitivity(value: number) {
    if (Number.isFinite(value)) this.sensitivity = Math.min(3, Math.max(0.25, value));
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
  }

  /** Adopt the camera's current orientation (drops roll). */
  syncFromCamera() {
    this.euler.setFromQuaternion(this.camera.quaternion, "YXZ");
    this.yaw = this.euler.y;
    this.pitch = this.euler.x;
    this.clampPitch();
    this.applyRotation();
  }

  private clampPitch() {
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch));
  }

  private applyRotation() {
    this.euler.set(this.pitch, this.yaw, 0, "YXZ");
    this.camera.quaternion.setFromEuler(this.euler);
  }

  /** @returns true if the camera moved or turned this frame */
  update(dt: number): boolean {
    if (!this.enabled || this.paused) return false;
    let mx = this.touchMove.x, mz = this.touchMove.y, run = false, moved = false;
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
      if (lx || ly) {
        this.yaw -= lx * this.padLookSpeed * this.sensitivity * dt;
        this.pitch -= ly * this.padLookSpeed * this.sensitivity * dt;
        this.clampPitch();
        moved = true;
      }
      if ((pad.buttons[6]?.value ?? 0) > 0.5 || (pad.buttons[7]?.value ?? 0) > 0.5) run = true;
      pad.buttons.forEach((b, i) => {
        const now = b.pressed;
        if (now && !this.padPrev[i]) this.onPadButton?.(i);
        this.padPrev[i] = now;
      });
    } else this.padPrev = [];

    if (this.drainWheel(dt)) moved = true;
    if (this.cursorTurn(dt)) moved = true;

    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    this.v.set(mx * cos + mz * sin, 0, mz * cos - mx * sin);
    if (this.flyMode) {
      this.v.y = Number(this.keys.has("KeyQ")) - Number(this.keys.has("KeyC"));
      if (this.v.lengthSq() > 1) this.v.normalize();
      this.camera.position.addScaledVector(this.v, this.moveSpeed * (run ? this.runMultiplier : 1) * dt);
    } else if (this.motor) {
      this.motor.update(dt, this.v, run);
      moved = this.camera.position.distanceToSquared(this.motor.eye) > 1e-10;
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

/** Where the cursor sits along one axis of the canvas, as a signed pull away
 * from the rest band: 0 inside it, ±1 at the edge.
 *
 * Squared, so the first pixels outside the band barely move the view and the
 * edge is quickest. That curve is what makes a single control law usable for
 * both a careful look and a full spin.
 *
 * @param fraction 0 at the left/top of the canvas, 1 at the right/bottom
 */
function deflection(fraction: number): number {
  // A cursor past the edge counts as full deflection rather than overshooting.
  const offset = Math.max(-1, Math.min(1, fraction * 2 - 1));
  const past = (Math.abs(offset) - LOOK_REST_BAND) / (1 - LOOK_REST_BAND);
  return past <= 0 ? 0 : Math.sign(offset) * past * past;
}

export function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
}
