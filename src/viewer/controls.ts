/**
 * First-person controller for Phase 1.
 *
 * The body and the eyes are separate. A and D turn the BODY, without limit, so
 * a full circle costs nothing but time. The cursor moves the EYES, and only
 * within a cone around wherever the body is facing: centre of the canvas is
 * straight ahead, the edges are `lookRange` off it, and every position in
 * between maps to exactly one direction. W and S walk along the body's
 * heading, not along where you happen to be looking.
 *
 *  - W / S: walk forward and back along the body heading
 *  - A / D: turn the body, held, unbounded
 *  - cursor: bounded absolute look, ±lookRange in each axis, centre = ahead
 *  - scroll: turns the body as well, banked and eased out over a few frames
 *  - touch: one-finger swipe turns the body and tilts the look
 *  - Shift run; Q/C height in development fly mode
 *  - M: pause menu. Not Escape, which the browser spends leaving fullscreen.
 *  - gamepad: left stick walk and turn, right stick look, LT/RT run
 *
 * `heading` is the source of truth for the body and `lookYaw`/`lookPitch` for
 * the eyes; `yaw` and `pitch` are the composed camera orientation, derived from
 * those every frame and never written to directly. Call syncFromCamera() after
 * setting the camera pose from elsewhere (reset-to-photographer, saved poses).
 *
 * Two earlier controllers steered entirely with the cursor and both drifted,
 * for the same reason: the cursor is bounded and yaw is not, so something had
 * to convert "the cursor ran out of screen" into "keep turning", and whatever
 * did that broke the correspondence between where the cursor sat and where you
 * were looking. Splitting body from eyes dissolves it. Unbounded turning is A
 * and D's job, so the cursor never needs to do it, so the cursor can be a pure
 * function of position: the same place on the canvas is the same direction,
 * always, and centring it returns you to the body's forward direction exactly.
 */
import * as THREE from "three";
import type { WalkingMotor } from "./walking";

/** Exponential rate at which banked scroll is spent, per second. */
const WHEEL_EASE = 18;
/** Exponential rate at which the look settles onto the cursor, per second.
 * High enough to feel direct, low enough to take the jitter off a shaky hand
 * and to glide rather than jump when the cursor re-enters the canvas. */
const LOOK_EASE = 26;
/** Exponential rate at which A/D turning reaches full speed, per second.
 * Onset only — releasing the key stops the body on the same frame. */
const TURN_EASE = 12;
/** Below this, an easing term is finished: spend the remainder and stop, so it
 * settles on the target exactly instead of chasing an ever-smaller tail. */
const SETTLED = 1e-4;
/** Hard bound on camera pitch, whatever the look range is set to. */
const PITCH_LIMIT = Math.PI / 2 - 0.02;

/** Forward and back. A and D are not here: they turn the body instead of
 * strafing, so there is no lateral movement to compose. */
const MOVE_KEYS: Record<string, number> = { KeyW: -1, KeyS: 1, ArrowUp: -1, ArrowDown: 1 };
const TURN_KEYS: Record<string, number> = { KeyA: -1, KeyD: 1, ArrowLeft: -1, ArrowRight: 1 };

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export class FirstPersonControls {
  /** Composed camera orientation. Derived from heading and the look offsets
   * every frame — read these, do not assign them. */
  yaw = 0;
  pitch = 0;
  /** Where the body faces. Unbounded: A and D turn through as many full
   * circles as you hold them for, and walking follows this, not the eyes. */
  heading = 0;
  moveSpeed = 1.6; // world units (metres for metric worlds) per second
  runMultiplier = 2.5;
  /** rad/s of body rotation with A or D held. */
  turnSpeed = 2;
  /** How far the cursor can pull the eyes off the body's forward direction, in
   * each axis. The canvas edge is exactly this far off; the centre is zero. */
  lookRange = (70 * Math.PI) / 180;
  /** rad per pixel of touch swipe. A mouse never uses this: a cursor has a
   * position to read, and reading it is what keeps the view and the cursor
   * from drifting apart. A finger has no position to come back to. */
  lookSpeed = 0.004;
  /** rad per normalised pixel of scroll, for scroll-to-turn. */
  wheelLookSpeed = 0.0022;
  /** User multiplier. Cursor look is bounded, so this cannot scale a rate the
   * way it once did: it bends the response curve instead, reaching a given
   * angle for less cursor travel while ±lookRange stays put. See
   * setSensitivity. */
  sensitivity = 1;
  enabled = true;
  /** A finger is down. Touch only: a mouse looks by hovering, never by dragging. */
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
  /** Where the eyes sit relative to the body's forward direction. */
  private lookYaw = 0;
  private lookPitch = 0;
  /** Eased A/D input, so the body does not snap to full turn speed on a tap. */
  private turning = 0;
  /** Where the cursor sits. Read every frame; never differenced. */
  private cursorX = 0;
  private cursorY = 0;
  /** False until the cursor is known to be over the canvas. */
  private hasPointer = false;
  /** Previous touch point, for the swipe delta. Mouse input never uses these. */
  private swipeX = 0;
  private swipeY = 0;
  /** Scroll banked by the wheel handler, drained a fraction per frame by update(). */
  private wheelTurn = 0;

  constructor(canvas: HTMLCanvasElement, camera: THREE.PerspectiveCamera) {
    this.canvas = canvas;
    this.camera = camera;

    // A touchscreen has no cursor to follow, so a finger down starts a swipe.
    // A mouse never needs this: it is already looking by hovering.
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
    // Leaving freezes the look where it is rather than springing it forward:
    // reaching for a control should not also swing the view.
    this.on(canvas, "pointerleave", (e) => {
      if ((e as PointerEvent).pointerType === "mouse") this.hasPointer = false;
    });
    this.on(canvas, "pointermove", (e) => {
      const pe = e as PointerEvent;
      if (!this.enabled || this.paused) return;
      // A mouse only reports where it is. The look is read off that position
      // once a frame, so nothing accumulates and nothing can drift.
      if (pe.pointerType === "mouse") {
        this.cursorX = pe.clientX;
        this.cursorY = pe.clientY;
        this.hasPointer = true;
        return;
      }
      // A finger has no resting position to read, so it turns the body by its
      // own delta and tilts the eyes, which is the nearest thing to the mouse.
      if (!this.dragging) return;
      const scale = this.lookSpeed * this.sensitivity;
      this.heading -= (pe.clientX - this.swipeX) * scale;
      this.lookPitch = clamp(this.lookPitch - (pe.clientY - this.swipeY) * scale, -this.lookRange, this.lookRange);
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
    // Scroll turns the body, always on: no click, no capture, no held button.
    // Only the horizontal axis does anything — pitch belongs to the cursor now,
    // and a second owner accumulating into it would fight the cursor's absolute
    // position every frame. preventDefault still covers both axes, which stops
    // the page scrolling and stops a horizontal swipe triggering the browser's
    // back/forward gesture.
    this.on(canvas, "wheel", (e) => {
      const we = e as WheelEvent;
      if (!this.enabled || this.paused) return;
      if (we.ctrlKey) return; // ctrl/pinch wheel is the browser's zoom, not ours
      we.preventDefault();
      // deltaMode is pixels, lines or pages depending on the device.
      const unit = we.deltaMode === 1 ? 16 : we.deltaMode === 2 ? (canvas.clientHeight || 800) : 1;
      // Banked rather than applied, so update() can ease it out over several frames.
      this.wheelTurn -= we.deltaX * this.wheelLookSpeed * this.sensitivity * unit;
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
      if (ev.code in MOVE_KEYS || ev.code in TURN_KEYS || ev.code === "ShiftLeft" || ev.code === "ShiftRight" ||
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
    this.turning = 0;
    this.wheelTurn = 0;
    this.canvas.style.cursor = "";
    this.motor?.stop();
  }

  /** Hand input to, or take it from, the world. The photo landing and the entity
   * portal both put something else on screen and must not be steered through. */
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    // Drop the cursor reference in both directions. The pointer keeps moving
    // while input is taken away, so the look must not follow it back in until
    // an event says where it actually is.
    this.hasPointer = false;
    if (!enabled) this.clearInput();
  }

  setPaused(paused: boolean) {
    this.paused = paused;
    if (paused) this.clearInput();
  }

  /** @param x turn the body left/right  @param z walk forward/back */
  setTouchMove(x: number, z: number) { this.touchMove.set(clamp(x, -1, 1), clamp(z, -1, 1)); }

  /** Ease out banked scroll so a notched wheel glides instead of stepping, and
   * a trackpad flick keeps coasting after the fingers lift.
   * @returns true if the body turned this frame */
  private drainWheel(dt: number): boolean {
    if (!this.wheelTurn) return false;
    const k = Math.min(1, 1 - Math.exp(-WHEEL_EASE * dt));
    const spend = Math.abs(this.wheelTurn) < SETTLED ? this.wheelTurn : this.wheelTurn * k;
    this.wheelTurn -= spend;
    this.heading += spend;
    return true;
  }

  /** Where the cursor says the eyes should be, or null if it is not on the canvas.
   *
   * A pure function of the cursor's position: the same place on the canvas is
   * the same direction, every time, and the centre is the body's forward
   * direction exactly. Nothing accumulates, so there is no running total to
   * lose a clamped degree from and none to gain a degree the cursor never
   * asked for. Bounded, because turning past the bound is the body's job.
   */
  private lookTarget(): [number, number] | null {
    if (!this.hasPointer) return null;
    const bounds = this.canvas.getBoundingClientRect?.();
    if (!bounds || !(bounds.width > 0) || !(bounds.height > 0)) return null;
    if (!Number.isFinite(this.cursorX) || !Number.isFinite(this.cursorY)) return null;
    // −1 at the left/top edge, 0 at the centre, +1 at the right/bottom.
    const nx = clamp(((this.cursorX - bounds.left) / bounds.width) * 2 - 1, -1, 1);
    const ny = clamp(((this.cursorY - bounds.top) / bounds.height) * 2 - 1, -1, 1);
    return [-this.shape(nx) * this.lookRange, -this.shape(ny) * this.lookRange];
  }

  /** Bend cursor travel against look angle. Linear at 1×; above it the same
   * angle arrives sooner, below it the centre of the canvas gets finer. The
   * bound is untouched either way, so ±lookRange means what it says. */
  private shape(n: number): number {
    if (this.sensitivity === 1 || n === 0) return n;
    return Math.sign(n) * Math.abs(n) ** (1 / this.sensitivity);
  }

  /** Ease the eyes onto where the cursor is pointing.
   * @returns true if they moved this frame */
  private settleLook(dt: number): boolean {
    const target = this.lookTarget();
    // Off the canvas: hold the last look rather than springing to centre.
    if (!target) return false;
    const [wantYaw, wantPitch] = target;
    const dYaw = wantYaw - this.lookYaw, dPitch = wantPitch - this.lookPitch;
    if (!dYaw && !dPitch) return false;
    if (Math.abs(dYaw) < SETTLED && Math.abs(dPitch) < SETTLED) {
      this.lookYaw = wantYaw;
      this.lookPitch = wantPitch;
      return true;
    }
    const k = Math.min(1, 1 - Math.exp(-LOOK_EASE * dt));
    this.lookYaw += dYaw * k;
    this.lookPitch += dPitch * k;
    return true;
  }

  /** Correct look response depends on the pointing device, so it is the user's to set. */
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
  }

  /** Point the body where a camera pose points (drops roll).
   *
   * Only the heading is adopted. A walking body's forward direction is level,
   * and the eyes belong to the cursor — a pose's own pitch has nowhere to live
   * that would not make the centre of the canvas mean something other than
   * straight ahead.
   */
  syncFromCamera() {
    this.euler.setFromQuaternion(this.camera.quaternion, "YXZ");
    this.heading = this.euler.y;
    this.compose();
  }

  /** Body heading plus where the eyes are looking, onto the camera. */
  private compose() {
    this.yaw = this.heading + this.lookYaw;
    this.pitch = clamp(this.lookPitch, -PITCH_LIMIT, PITCH_LIMIT);
    this.euler.set(this.pitch, this.yaw, 0, "YXZ");
    this.camera.quaternion.setFromEuler(this.euler);
  }

  /** @returns true if the camera moved or turned this frame */
  update(dt: number): boolean {
    if (!this.enabled || this.paused) return false;
    let mz = this.touchMove.y, turn = this.touchMove.x, run = false, moved = false;
    for (const k of this.keys) {
      mz += MOVE_KEYS[k] ?? 0;
      turn += TURN_KEYS[k] ?? 0;
    }
    if (this.keys.has("ShiftLeft") || this.keys.has("ShiftRight")) run = true;

    // gamepad
    const pads = navigator.getGamepads?.() ?? [];
    const pad = pads.find((p) => p && p.connected);
    let padLook: [number, number] | null = null;
    if (pad) {
      const dz = (v: number) => (Math.abs(v) < 0.15 ? 0 : v);
      turn += dz(pad.axes[0] ?? 0);
      mz += dz(pad.axes[1] ?? 0);
      // The right stick is bounded and self-centring, so it maps into the look
      // cone the same way the cursor does rather than driving a rate.
      const lx = dz(pad.axes[2] ?? 0), ly = dz(pad.axes[3] ?? 0);
      if (lx || ly) padLook = [-lx * this.lookRange, -ly * this.lookRange];
      if ((pad.buttons[6]?.value ?? 0) > 0.5 || (pad.buttons[7]?.value ?? 0) > 0.5) run = true;
      pad.buttons.forEach((b, i) => {
        const now = b.pressed;
        if (now && !this.padPrev[i]) this.onPadButton?.(i);
        this.padPrev[i] = now;
      });
    } else this.padPrev = [];

    // Turn the body, unbounded, so holding A or D winds through as many circles
    // as you like. Eased on the way up so a tap nudges instead of snapping to
    // full speed, but stopped outright on release: coasting on past where you
    // let go is exactly the drift this controller exists to be rid of.
    const wanted = clamp(turn, -1, 1);
    this.turning = Math.abs(wanted) > Math.abs(this.turning)
      ? this.turning + (wanted - this.turning) * Math.min(1, 1 - Math.exp(-TURN_EASE * dt))
      : wanted;
    if (this.turning) {
      this.heading -= this.turning * this.turnSpeed * dt;
      moved = true;
    }
    if (this.drainWheel(dt)) moved = true;

    if (padLook) {
      moved = moved || padLook[0] !== this.lookYaw || padLook[1] !== this.lookPitch;
      this.lookYaw = padLook[0];
      this.lookPitch = padLook[1];
    } else if (this.settleLook(dt)) moved = true;

    // Walk along the body's heading, never along where the eyes are pointed.
    const forward = clamp(mz, -1, 1);
    const sin = Math.sin(this.heading), cos = Math.cos(this.heading);
    this.v.set(forward * sin, 0, forward * cos);
    if (this.flyMode) {
      this.v.y = Number(this.keys.has("KeyQ")) - Number(this.keys.has("KeyC"));
      if (this.v.lengthSq() > 1) this.v.normalize();
      this.camera.position.addScaledVector(this.v, this.moveSpeed * (run ? this.runMultiplier : 1) * dt);
    } else if (this.motor) {
      this.motor.update(dt, this.v, run);
      moved = moved || this.camera.position.distanceToSquared(this.motor.eye) > 1e-10;
      this.camera.position.copy(this.motor.eye);
    }
    this.compose();
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
