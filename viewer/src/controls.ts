/**
 * First-person controller for Phase 1.
 *  - pointer-lock mouse look (click the canvas), Esc releases
 *  - WASD walk on the ground plane relative to yaw, Q/E height, Shift run
 *  - gamepad: left stick walk, right stick look, LT/RT run
 * Yaw/pitch are the source of truth; call syncFromCamera() after setting the
 * camera pose from elsewhere (reset-to-photographer, saved poses).
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
  locked = false;
  onLockChange?: (locked: boolean) => void;
  /** Fires for gamepad buttons on press (edge). */
  onPadButton?: (index: number) => void;

  private keys = new Set<string>();
  private padPrev: boolean[] = [];
  private euler = new THREE.Euler(0, 0, 0, "YXZ");
  private v = new THREE.Vector3();

  constructor(private canvas: HTMLCanvasElement, private camera: THREE.PerspectiveCamera) {
    canvas.addEventListener("click", () => {
      if (this.enabled && !this.locked) this.lock();
    });
    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === canvas;
      this.onLockChange?.(this.locked);
    });
    document.addEventListener("mousemove", (e) => {
      if (!this.locked || !this.enabled) return;
      this.yaw -= e.movementX * this.lookSpeed;
      this.pitch -= e.movementY * this.lookSpeed;
      this.clampPitch();
    });
    document.addEventListener("keydown", (e) => {
      if (isTyping(e)) return;
      if (e.code in MOVE_KEYS) {
        this.keys.add(e.code);
        e.preventDefault();
      }
    });
    document.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => this.keys.clear());
  }

  lock() {
    this.canvas.requestPointerLock?.();
  }
  unlock() {
    if (document.pointerLockElement) document.exitPointerLock();
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
