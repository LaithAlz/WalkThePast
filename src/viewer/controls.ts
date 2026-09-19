/**
 * First-person controller for Phase 1.
 *  - drag-to-look: hold the left button on the canvas and move to turn
 *  - WASD walk on the ground plane relative to yaw, Q/E height, Shift run
 *  - gamepad: left stick walk, right stick look, LT/RT run
 * Yaw/pitch are the source of truth; call syncFromCamera() after setting the
 * camera pose from elsewhere (reset-to-photographer, saved poses).
 *
 * Deliberately drag rather than pointer lock: lock needs a click to engage and
 * Esc to escape, which traps anyone trying the demo, and it is refused outright
 * in some embedded/preview contexts. Dragging behaves the same on a trackpad.
 */
import * as THREE from "three";

const MOVE_KEYS: Record<string, [number, number, number]> = {
  KeyW: [0, 0, -1], KeyS: [0, 0, 1], KeyA: [-1, 0, 0], KeyD: [1, 0, 0],
  ArrowUp: [0, 0, -1], ArrowDown: [0, 0, 1], ArrowLeft: [-1, 0, 0], ArrowRight: [1, 0, 0],
  KeyE: [0, 1, 0], KeyQ: [0, -1, 0],
};

export class FirstPersonControls {
  yaw = 0;
  pitch = 0;
  moveSpeed = 1.6; // world units (metres for metric worlds) per second
  runMultiplier = 2.5;
  lookSpeed = 0.0022;
  padLookSpeed = 2.2; // rad/s at full deflection
  enabled = true;
  dragging = false;
  /** Fires for gamepad buttons on press (edge). */
  onPadButton?: (index: number) => void;

  private readonly canvas: HTMLCanvasElement;
  private readonly camera: THREE.PerspectiveCamera;
  private keys = new Set<string>();
  private padPrev: boolean[] = [];
  private euler = new THREE.Euler(0, 0, 0, "YXZ");
  private v = new THREE.Vector3();
  private teardown: Array<() => void> = [];
  private lastX = 0;
  private lastY = 0;

  constructor(canvas: HTMLCanvasElement, camera: THREE.PerspectiveCamera) {
    this.canvas = canvas;
    this.camera = camera;

    this.on(canvas, "pointerdown", (e) => {
      const pe = e as PointerEvent;
      if (!this.enabled || pe.button !== 0) return;
      this.dragging = true;
      // Track deltas by hand: PointerEvent.movementX is unreliable outside pointer lock.
      this.lastX = pe.clientX;
      this.lastY = pe.clientY;
      canvas.setPointerCapture(pe.pointerId);
      canvas.style.cursor = "grabbing";
      pe.preventDefault();
    });
    this.on(canvas, "pointermove", (e) => {
      const pe = e as PointerEvent;
      if (!this.dragging || !this.enabled) return;
      this.yaw -= (pe.clientX - this.lastX) * this.lookSpeed;
      this.pitch -= (pe.clientY - this.lastY) * this.lookSpeed;
      this.lastX = pe.clientX;
      this.lastY = pe.clientY;
      this.clampPitch();
    });
    const endDrag = (e: Event) => {
      const pe = e as PointerEvent;
      if (!this.dragging) return;
      this.dragging = false;
      canvas.releasePointerCapture?.(pe.pointerId);
      canvas.style.cursor = "";
    };
    this.on(canvas, "pointerup", endDrag);
    this.on(canvas, "pointercancel", endDrag);
    this.on(document, "keydown", (e) => {
      const ev = e as KeyboardEvent;
      if (!this.enabled || isTyping(ev)) return;
      if (ev.code in MOVE_KEYS) {
        this.keys.add(ev.code);
        ev.preventDefault();
      }
    });
    this.on(document, "keyup", (e) => this.keys.delete((e as KeyboardEvent).code));
    this.on(window, "blur", () => this.keys.clear());
  }

  private on(target: EventTarget, type: string, handler: (e: Event) => void) {
    target.addEventListener(type, handler);
    this.teardown.push(() => target.removeEventListener(type, handler));
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

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (enabled) return;
    this.keys.clear();
    this.dragging = false;
    this.canvas.style.cursor = "";
  }

  private clampPitch() {
    const lim = Math.PI / 2 - 0.02;
    this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
  }

  private applyRotation() {
    this.euler.set(this.pitch, this.yaw, 0, "YXZ");
    this.camera.quaternion.setFromEuler(this.euler);
  }

  /** @returns true if the camera moved or turned this frame */
  update(dt: number): boolean {
    if (!this.enabled) return false;
    let mx = 0, my = 0, mz = 0, run = false, moved = false;
    for (const k of this.keys) {
      const d = MOVE_KEYS[k];
      mx += d[0]; my += d[1]; mz += d[2];
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
        this.yaw -= lx * this.padLookSpeed * dt;
        this.pitch -= ly * this.padLookSpeed * dt;
        this.clampPitch();
        moved = true;
      }
      if ((pad.buttons[6]?.value ?? 0) > 0.5 || (pad.buttons[7]?.value ?? 0) > 0.5) run = true;
      pad.buttons.forEach((b, i) => {
        const now = b.pressed;
        if (now && !this.padPrev[i]) this.onPadButton?.(i);
        this.padPrev[i] = now;
      });
    }

    if (mx || my || mz) {
      const speed = this.moveSpeed * (run ? this.runMultiplier : 1) * dt;
      // walk on the horizontal plane relative to yaw; Q/E move vertically
      const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
      this.v.set(mx * cos + mz * sin, my, mz * cos - mx * sin);
      if (this.v.lengthSq() > 1) this.v.normalize();
      this.camera.position.addScaledVector(this.v, speed);
      moved = true;
    }
    this.applyRotation();
    return moved;
  }
}

export function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
}
