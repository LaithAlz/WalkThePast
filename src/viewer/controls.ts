/**
 * First-person controller for Phase 1.
 *
 * Nothing here needs a button held or a pointer captured. There is no
 * click-to-capture and no drag-to-look: you turn by moving, which on a
 * trackpad means a one-finger swipe for looking and a two-finger swipe for
 * turning further.
 *
 *  - move the cursor over the canvas: turns (yaw from x, pitch from y)
 *  - hold the cursor against a left or right edge: keeps yawing, which is what
 *    makes a full turn reachable when the cursor runs out of screen
 *  - scroll: turns as well, banked and eased out over a few frames
 *  - touch: one-finger swipe turns, since a touchscreen has no cursor
 *  - WASD grounded capsule movement, Shift run; Q/C height in development fly mode
 *  - gamepad: left stick walk, right stick look, LT/RT run
 *
 * Yaw/pitch are the source of truth; call syncFromCamera() after setting the
 * camera pose from elsewhere (reset-to-photographer, saved poses).
 *
 * The cost of cursor-steering is that the view turns on the way to an overlay
 * button. That is bounded rather than eliminated: turning only happens while
 * the cursor is over the canvas, so it stops the moment the cursor reaches a
 * control, and re-entering the canvas reseeds instead of jumping.
 */
import * as THREE from "three";
import type { WalkingMotor } from "./walking";

/** Exponential rate at which banked scroll is spent, per second. */
const WHEEL_EASE = 18;
const PITCH_LIMIT = Math.PI / 2 - 0.02;

const MOVE_KEYS: Record<string, [number, number, number]> = {
  KeyW: [0, 0, -1], KeyS: [0, 0, 1], KeyA: [-1, 0, 0], KeyD: [1, 0, 0],
  ArrowUp: [0, 0, -1], ArrowDown: [0, 0, 1], ArrowLeft: [-1, 0, 0], ArrowRight: [1, 0, 0],
};

export class FirstPersonControls {
  yaw = 0;
  pitch = 0;
  moveSpeed = 1.6; // world units (metres for metric worlds) per second
  runMultiplier = 2.5;
  /** rad per pixel of cursor travel. Cursor travel is bounded by the window, so
   * this is set for roughly a half turn per comfortable trackpad swipe. */
  lookSpeed = 0.004;
  /** rad per normalised pixel of scroll, for scroll-to-turn. */
  wheelLookSpeed = 0.0022;
  /** rad/s of extra yaw with the cursor hard against a left or right edge. */
  edgeTurnSpeed = 2.2;
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
  private lastX = 0;
  private lastY = 0;
  /** False until we have a cursor position to measure the next move against. */
  private hasPointer = false;
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
      this.lastX = pe.clientX;
      this.lastY = pe.clientY;
      capturePointer(canvas, pe.pointerId);
      pe.preventDefault();
    });
    // Seed on entry so the first move measures from where the cursor came in
    // rather than from wherever it was last seen, which would snap the view.
    this.on(canvas, "pointerenter", (e) => {
      const pe = e as PointerEvent;
      if (pe.pointerType !== "mouse") return;
      this.lastX = pe.clientX;
      this.lastY = pe.clientY;
      this.hasPointer = true;
    });
    this.on(canvas, "pointerleave", (e) => {
      if ((e as PointerEvent).pointerType === "mouse") this.hasPointer = false;
    });
    this.on(canvas, "pointermove", (e) => {
      const pe = e as PointerEvent;
      if (!this.enabled || this.paused) return;
      const mouse = pe.pointerType === "mouse";
      // A mouse turns simply by moving over the canvas. Touch needs a finger down.
      if (!(mouse || this.dragging)) return;
      if (mouse && !this.hasPointer) {
        this.lastX = pe.clientX;
        this.lastY = pe.clientY;
        this.hasPointer = true;
        return;
      }
      const scale = this.lookSpeed * this.sensitivity;
      this.yaw -= (pe.clientX - this.lastX) * scale;
      this.pitch -= (pe.clientY - this.lastY) * scale;
      this.lastX = pe.clientX;
      this.lastY = pe.clientY;
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
      if (ev.code === "Escape") {
        // Nothing captures the pointer, so this key is never swallowed.
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

  /** Keep yawing while the cursor rests against a left or right edge.
   *
   * Cursor travel is bounded by the window, so on its own it only buys you the
   * turn that fits across one screen — push to the edge and you stop, with no
   * way round. This is the part that makes a full 360 reachable.
   *
   * Yaw only. Pitch is clamped to just under a quarter turn, which is ~390px of
   * cursor travel and fits on any screen, so a vertical equivalent would buy
   * nothing and would creep the view whenever the cursor neared the toolbar.
   *
   * @returns true if the camera turned this frame
   */
  private edgeTurn(dt: number): boolean {
    // hasPointer is mouse-only and false once the cursor leaves the canvas, so
    // this never runs while the cursor is parked on a control or off-window.
    if (!this.hasPointer) return false;
    const bounds = this.canvas.getBoundingClientRect?.();
    if (!bounds || !(bounds.width > 0) || !Number.isFinite(this.lastX)) return false;
    const margin = Math.min(120, Math.max(48, bounds.width * 0.12));
    const fromLeft = this.lastX - bounds.left;
    const fromRight = bounds.left + bounds.width - this.lastX;
    // Past the edge entirely counts as full deflection rather than overshooting.
    const depth = fromLeft < margin ? -(1 - Math.max(0, fromLeft) / margin)
      : fromRight < margin ? 1 - Math.max(0, fromRight) / margin
        : 0;
    if (!depth) return false;
    // Squared ramp: barely moves entering the margin, quickest against the edge.
    this.yaw -= Math.sign(depth) * depth * depth * this.edgeTurnSpeed * this.sensitivity * dt;
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
    if (this.edgeTurn(dt)) moved = true;

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

export function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
}
