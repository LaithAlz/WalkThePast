/**
 * Where the guide stands, and how it gets there.
 *
 * The player has no body and sees out of their own eyes, so a companion that
 * trails behind them is a companion they never see. This keeps the guide a step
 * ahead and off to one side — inside a 60 degree frame at a conversational
 * distance — and turns it to face you whenever it is not walking.
 *
 * Plain numbers on the XZ plane, no three.js: the steering is the part worth
 * testing, and it tests far better without a scene graph around it.
 */

/** What the historian is doing. Drives both the stance and the gestures. */
export type GuideMood = "idle" | "listening" | "thinking" | "speaking";

/** Anything but "idle" means the player is in conversation with the guide. */
export const isEngaged = (mood: GuideMood) => mood !== "idle";

export interface FollowOptions {
  /** Metres in front of the player the guide aims for while walking. */
  ahead?: number;
  /** Metres to the side of that, so it never stands in the middle of the view. */
  beside?: number;
  /** The same two, while you are talking to it: closer, and more square on. */
  engagedAhead?: number;
  engagedBeside?: number;
  /** Stop when this close to the mark, start again once this far from it.
   * Two thresholds, not one, or the guide twitches on the spot. */
  arrive?: number;
  depart?: number;
  /** Jog rather than walk past this distance from the mark. */
  runBeyond?: number;
  /** Past this distance from the player, give up steering and ask to be moved. */
  leash?: number;
  /** Seconds of lag on the heading the mark is built from. Without it a flick
   * of the mouse throws the mark across the room and the guide chases it. */
  headingLag?: number;
  /** Seconds of no progress before trying the other side, then giving up. */
  stuckAfter?: number;
}

/**
 * The stand-off. `ahead` and `beside` together put the guide about 30 degrees
 * off the centre of the view: far enough that it never covers the crosshair
 * evidence mode reads through, close enough to stay in frame down to a 4:3
 * window. The camera's 60 degrees are vertical, so the horizontal field is
 * wider than that — 91 degrees at 16:9, 75 at 4:3.
 */
const DEFAULTS: Required<FollowOptions> = {
  ahead: 1.85, beside: 1.05, engagedAhead: 1.5, engagedBeside: 0.65,
  arrive: 0.28, depart: 0.62, runBeyond: 3.6, leash: 11,
  headingLag: 0.55, stuckAfter: 1.6,
};

export interface Point { x: number; z: number }

export interface FollowStep {
  /** The spot the guide is walking to, in world units. */
  mark: Point;
  /** Unit steering direction, or (0, 0) while it is holding position. */
  move: Point;
  /** Far enough from the mark to be worth jogging. */
  running: boolean;
  /** Standing still, either arrived or in conversation. */
  holding: boolean;
  /** Yaw for the mesh, in the atan2(x, z) convention glTF characters face. */
  facing: number;
  /** Steering has failed — put the guide back beside the player. */
  recover: boolean;
}

/** Shortest signed angle from `a` to `b`, in (-pi, pi]. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

export class FollowController {
  readonly options: Required<FollowOptions>;
  /** Which shoulder the guide walks off: +1 is the player's right. */
  private side: 1 | -1 = 1;
  /** Lagged copy of the player's heading, so the mark does not flick about. */
  private heading = 0;
  private headingSeeded = false;
  private moving = false;
  private facing = 0;
  private facingSeeded = false;
  private stuckFor = 0;
  private bestDistance = Infinity;
  /** One side swap is a retry; a second failure is a recovery. */
  private swapped = false;

  constructor(options: FollowOptions = {}) {
    // Only the keys this controller owns. It is handed the guide's whole
    // options object, which also carries a height, speeds and an AbortSignal,
    // and a spread would drop those into a check that every setting is a
    // finite number — where an AbortSignal is not.
    this.options = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS) as (keyof Required<FollowOptions>)[]) {
      const value = options[key];
      if (value !== undefined) this.options[key] = value;
    }
    const o = this.options;
    if (Object.values(o).some((v) => !Number.isFinite(v)) ||
      o.arrive <= 0 || o.depart <= o.arrive || o.leash <= o.runBeyond ||
      o.headingLag <= 0 || o.stuckAfter <= 0 || o.ahead < 0 || o.beside < 0) {
      throw new Error("Invalid follow configuration");
    }
  }

  /** Forget the lag and the stuck timer — after a teleport, or a fresh world. */
  reset(playerYaw: number) {
    this.heading = playerYaw;
    this.headingSeeded = true;
    this.moving = false;
    this.stuckFor = 0;
    this.bestDistance = Infinity;
    this.swapped = false;
    this.facingSeeded = false;
  }

  /**
   * The spot the guide is aiming for, without advancing anything. Used to place
   * it on arrival, before there is a first frame to step.
   */
  markFor(player: Point, mood: GuideMood): Point {
    const o = this.options;
    const engaged = isEngaged(mood);
    // The camera looks down -z at yaw 0, so forward is (-sin, -cos) and the
    // player's right hand is (cos, -sin). See FirstPersonControls.update.
    const sin = Math.sin(this.heading), cos = Math.cos(this.heading);
    const ahead = engaged ? o.engagedAhead : o.ahead;
    const beside = (engaged ? o.engagedBeside : o.beside) * this.side;
    return {
      x: player.x - sin * ahead + cos * beside,
      z: player.z - cos * ahead - sin * beside,
    };
  }

  step(dt: number, player: Point, playerYaw: number, guide: Point, mood: GuideMood): FollowStep {
    if (!this.headingSeeded) this.reset(playerYaw);
    const o = this.options;
    const engaged = isEngaged(mood);

    // Follow the heading, not the mouse. Turning your head should not send the
    // guide running; turning your body should.
    const k = dt > 0 ? 1 - Math.exp(-dt / o.headingLag) : 0;
    this.heading += angleDelta(this.heading, playerYaw) * k;

    const mark = this.markFor(player, mood);

    const dx = mark.x - guide.x, dz = mark.z - guide.z;
    const distance = Math.hypot(dx, dz);
    // Hysteresis: leave once the mark has walked away, arrive once it is met.
    if (this.moving ? distance <= o.arrive : distance >= o.depart) this.moving = !this.moving;
    const moving = this.moving;

    const toPlayer = Math.atan2(player.x - guide.x, player.z - guide.z);
    let facing = toPlayer;
    if (moving && distance > 1e-4 && !engaged) facing = Math.atan2(dx, dz);
    // Turn, don't snap. A guide that pivots instantly reads as a cardboard cutout.
    if (!this.facingSeeded) { this.facing = facing; this.facingSeeded = true; }
    else this.facing += angleDelta(this.facing, facing) * (dt > 0 ? 1 - Math.exp(-dt / 0.16) : 1);

    // Progress, not position: a guide pressed into a doorway keeps its distance
    // to the mark while walking hard, and that is exactly what has to be caught.
    let recover = Math.hypot(player.x - guide.x, player.z - guide.z) > o.leash;
    if (moving) {
      if (distance < this.bestDistance - 0.05) { this.bestDistance = distance; this.stuckFor = 0; }
      else this.stuckFor += dt;
      if (this.stuckFor >= o.stuckAfter) {
        this.stuckFor = 0;
        this.bestDistance = Infinity;
        if (this.swapped) recover = true;
        else { this.side = this.side === 1 ? -1 : 1; this.swapped = true; }
      }
    } else {
      this.stuckFor = 0;
      this.bestDistance = Infinity;
      this.swapped = false;
    }

    return {
      mark,
      move: moving && distance > 1e-4 ? { x: dx / distance, z: dz / distance } : { x: 0, z: 0 },
      running: moving && distance > o.runBeyond,
      holding: !moving,
      facing: this.facing,
      recover,
    };
  }
}
