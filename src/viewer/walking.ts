import { Ray, Triangle, Vector3 } from "three";
import { Capsule } from "three/addons/math/Capsule.js";
import { Octree } from "three/addons/math/Octree.js";

export interface WalkingOptions {
  eyeHeight?: number;
  radius?: number;
  height?: number;
  stepHeight?: number;
  maxSlopeDegrees?: number;
  speed?: number;
  sprintMultiplier?: number;
  gravity?: number;
  groundY?: number;
  radiusLimit?: number;
}

const UP = new Vector3(0, 1, 0);
const DOWN = new Vector3(0, -1, 0);
const FIXED_DT = 1 / 120;
const SKIN = 0.002;

/** CPU-only capsule controller. Positions and tuning are in the rendered world's units.
 * The collider is already transformed into that frame before constructing its octree.
 * No mesh means a deliberately limited flat-floor fallback, never guessed splat collision.
 */
export class WalkingMotor {
  readonly capsule = new Capsule();
  readonly velocity = new Vector3();
  readonly eye = new Vector3();
  readonly options: Required<WalkingOptions>;
  grounded = false;
  ready = false;
  private readonly tree: Octree | null;
  private readonly spawnFeet = new Vector3();
  private readonly boundaryCenter = new Vector3();
  private readonly previous = new Capsule();
  private readonly normal = new Vector3();
  private readonly delta = new Vector3();
  private accumulator = 0;
  private minY = -30;
  private readonly minGroundNormal: number;

  constructor(tree: Octree | null, options: WalkingOptions = {}) {
    this.tree = tree;
    this.options = {
      eyeHeight: 1.65, radius: 0.28, height: 1.8, stepHeight: 0.3,
      maxSlopeDegrees: 45, speed: 1.6, sprintMultiplier: 2.5,
      gravity: 20, groundY: 0, radiusLimit: 0, ...options,
    };
    const o = this.options;
    if (Object.values(o).some(v => !Number.isFinite(v)) || o.radius <= 0 ||
      o.height < 2 * o.radius || o.eyeHeight <= o.radius || o.eyeHeight > o.height ||
      o.stepHeight < 0 || o.stepHeight > o.height / 2 || o.speed <= 0 ||
      o.gravity <= 0 || o.sprintMultiplier < 1 || o.radiusLimit < 0 ||
      o.maxSlopeDegrees <= 0 || o.maxSlopeDegrees >= 85) {
      throw new Error("Invalid walking configuration");
    }
    this.minGroundNormal = Math.cos(o.maxSlopeDegrees * Math.PI / 180);
    this.capsule.radius = o.radius;
  }

  get hasCollider() { return this.tree !== null; }
  get feetY() { return this.capsule.start.y - this.options.radius; }

  /** Find a floor under the intended eye, then search nearby for capsule clearance.
   * A bad spawn is an explicit error, not a teleport through an arbitrary wall.
   */
  spawn(eye: Vector3): boolean {
    this.ready = false;
    if (![eye.x, eye.y, eye.z].every(Number.isFinite)) return false;
    this.boundaryCenter.copy(eye);
    const candidates: Vector3[] = [eye.clone()];
    if (this.tree) {
      for (const r of [0.5, 1, 1.5, 2]) {
        if (this.options.radiusLimit > 0 && r > this.options.radiusLimit) continue;
        for (let i = 0; i < 12; i++) {
          candidates.push(eye.clone().add(new Vector3(Math.cos(i * Math.PI / 6) * r, 0, Math.sin(i * Math.PI / 6) * r)));
        }
      }
    }
    for (const candidate of candidates) {
      const floor = this.floorAt(candidate.x, candidate.z, candidate.y + this.options.stepHeight, 12);
      if (floor === null) continue;
      this.setFeet(candidate.x, floor + SKIN, candidate.z);
      this.resolve(false);
      if (!this.clear() || this.feetY > floor + this.options.stepHeight + SKIN * 2) continue;
      this.spawnFeet.set(this.capsule.start.x, this.feetY, this.capsule.start.z);
      this.minY = floor - 20;
      this.ready = true;
      this.reset();
      return true;
    }
    return false;
  }

  reset() {
    this.setFeet(this.spawnFeet.x, this.spawnFeet.y, this.spawnFeet.z);
    this.velocity.set(0, 0, 0);
    this.accumulator = 0;
    this.grounded = true;
    this.updateEye();
  }

  stop() { this.velocity.set(0, 0, 0); this.accumulator = 0; }

  /** direction is horizontal world-space input; diagonal and analog input are clamped. */
  update(dt: number, direction: Vector3, sprint = false) {
    if (!this.ready || !Number.isFinite(dt) || dt <= 0) return;
    this.accumulator += Math.min(dt, 0.1);
    const speed = this.options.speed * (sprint ? this.options.sprintMultiplier : 1);
    const length = Math.hypot(direction.x, direction.z);
    const factor = speed / Math.max(1, length);
    while (this.accumulator >= FIXED_DT) {
      this.step(FIXED_DT, direction.x * factor, direction.z * factor);
      this.accumulator -= FIXED_DT;
    }
    this.updateEye();
  }

  private step(dt: number, targetX: number, targetZ: number) {
    const smoothing = 1 - Math.exp(-14 * dt);
    this.velocity.x += (targetX - this.velocity.x) * smoothing;
    this.velocity.z += (targetZ - this.velocity.z) * smoothing;
    const wasGrounded = this.grounded;
    this.previous.copy(this.capsule);
    this.delta.set(this.velocity.x * dt, 0, this.velocity.z * dt);
    // Bounds affect horizontal movement before collision, never push through geometry afterwards.
    const limit = this.options.radiusLimit;
    if (limit > 0) {
      const x = this.capsule.start.x + this.delta.x - this.boundaryCenter.x;
      const z = this.capsule.start.z + this.delta.z - this.boundaryCenter.z;
      const d = Math.hypot(x, z);
      if (d > limit) {
        this.delta.x += x * (limit / d - 1);
        this.delta.z += z * (limit / d - 1);
      }
    }
    const dx = this.delta.x, dz = this.delta.z;
    // Small fixed steps prevent thin walls from being crossed even at sprint speed.
    this.capsule.translate(this.delta);
    this.resolve(true);
    const actualX = this.capsule.start.x - this.previous.start.x;
    const actualZ = this.capsule.start.z - this.previous.start.z;
    if (wasGrounded && Math.hypot(dx, dz) > 0.0001 &&
      Math.hypot(actualX - dx, actualZ - dz) > 0.0005) this.tryStep(dx, dz);

    this.grounded = false;
    this.velocity.y = Math.max(this.velocity.y - this.options.gravity * dt, -12);
    this.capsule.translate(this.delta.set(0, this.velocity.y * dt, 0));
    this.resolve(false);
    // Follow small downward changes; larger drops fall naturally under gravity.
    if (wasGrounded && !this.grounded && this.velocity.y <= 0) {
      const floor = this.floorAt(this.capsule.start.x, this.capsule.start.z, this.feetY + 0.05, 0.13);
      if (floor !== null && this.feetY - floor <= 0.08) {
        const before = this.capsule.clone();
        this.capsule.translate(this.delta.set(0, floor + SKIN - this.feetY, 0));
        this.resolve(false);
        if (this.clear()) { this.grounded = true; this.velocity.y = 0; }
        else this.capsule.copy(before);
      }
    }
    if (!this.clear() || !Number.isFinite(this.feetY) || this.feetY < this.minY) this.reset();
  }

  private tryStep(dx: number, dz: number) {
    if (!this.tree || this.options.stepHeight === 0) return;
    const blocked = this.capsule.clone();
    const h = this.options.stepHeight;
    this.capsule.copy(this.previous);
    // Sweep upward as well as forward: don't step through a low ceiling.
    for (let y = 0; y < h; y += 0.05) {
      this.capsule.translate(this.delta.set(0, Math.min(0.05, h - y), 0));
      if (!this.clear()) { this.capsule.copy(blocked); return; }
    }
    this.capsule.translate(this.delta.set(dx, 0, dz));
    if (!this.clear()) { this.capsule.copy(blocked); return; }
    // The capsule meets a stair riser before its centre is over the tread. Probe at
    // its leading foot as well, then check the entire body at the candidate height.
    const length = Math.hypot(dx, dz);
    const reach = this.options.radius + SKIN;
    const centerFloor = this.floorAt(this.capsule.start.x, this.capsule.start.z, this.feetY + SKIN, h + 0.08);
    const frontFloor = this.floorAt(this.capsule.start.x + dx / length * reach, this.capsule.start.z + dz / length * reach, this.feetY + SKIN, h + 0.08);
    const floor = frontFloor === null ? centerFloor : centerFloor === null ? frontFloor : Math.max(centerFloor, frontFloor);
    if (floor === null || floor < this.previous.start.y - this.options.radius - 0.08) {
      this.capsule.copy(blocked); return;
    }
    this.capsule.translate(this.delta.set(0, floor + SKIN - this.feetY, 0));
    this.resolve(false);
    if (!this.clear() || this.feetY > this.previous.start.y - this.options.radius + h + SKIN * 2 ||
      Math.hypot(this.capsule.start.x - this.previous.start.x, this.capsule.start.z - this.previous.start.z) <=
      Math.hypot(blocked.start.x - this.previous.start.x, blocked.start.z - this.previous.start.z) + 0.0001) {
      this.capsule.copy(blocked);
    }
  }

  private setFeet(x: number, y: number, z: number) {
    const { radius, height } = this.options;
    this.capsule.start.set(x, y + radius, z);
    this.capsule.end.set(x, y + height - radius, z);
  }

  private updateEye() { this.eye.set(this.capsule.start.x, this.feetY + this.options.eyeHeight, this.capsule.start.z); }

  private floorAt(x: number, z: number, fromY: number, distance: number): number | null {
    if (!this.tree) return this.options.groundY <= fromY ? this.options.groundY : null;
    const ray = new Ray(new Vector3(x, fromY, z), DOWN);
    const triangles: Triangle[] = [];
    this.tree.getRayTriangles(ray, triangles);
    let nearest: Triangle | null = null;
    let floor: number | null = null;
    const point = new Vector3();
    for (const triangle of triangles) {
      // Include backfaces so a spawn inside a solid object cannot "see" a floor
      // through its underside. An upward-facing nearest surface must support us.
      if (!ray.intersectTriangle(triangle.a, triangle.b, triangle.c, false, point)) continue;
      const d = fromY - point.y;
      const backface = triangle.getNormal(this.normal).y < this.minGroundNormal;
      if (d < distance - 1e-6 || (d <= distance + 1e-6 && (!nearest || backface))) {
        distance = d; floor = point.y; nearest = triangle;
      }
    }
    return nearest && nearest.getNormal(this.normal).y >= this.minGroundNormal ? floor : null;
  }

  private clear(): boolean {
    const hit = this.tree?.capsuleIntersect(this.capsule);
    return !hit || hit.depth < SKIN * 2;
  }

  private resolve(horizontal: boolean) {
    if (!this.tree) {
      if (this.feetY <= this.options.groundY + SKIN) {
        this.capsule.translate(this.delta.copy(UP).multiplyScalar(this.options.groundY + SKIN - this.feetY));
        this.grounded = true;
        this.velocity.y = Math.max(0, this.velocity.y);
      }
      return;
    }
    for (let i = 0; i < 5; i++) {
      const hit = this.tree.capsuleIntersect(this.capsule);
      if (!hit || hit.depth < 1e-7) break;
      this.normal.copy(hit.normal);
      const walkable = this.normal.y >= this.minGroundNormal;
      if (horizontal && this.normal.y > 0 && !walkable) {
        // Prevent the round capsule foot climbing walls or slopes over the limit.
        const lateral = Math.hypot(this.normal.x, this.normal.z);
        this.normal.y = 0;
        this.normal.normalize();
        this.capsule.translate(this.delta.copy(this.normal).multiplyScalar((hit.depth + SKIN) / Math.max(lateral, 0.01)));
      } else {
        this.capsule.translate(this.delta.copy(this.normal).multiplyScalar(hit.depth + SKIN));
      }
      if (!horizontal) {
        if (walkable) { this.grounded = true; this.velocity.y = Math.max(0, this.velocity.y); }
        else if (this.normal.y < -0.1) this.velocity.y = Math.min(0, this.velocity.y);
      }
    }
  }
}
