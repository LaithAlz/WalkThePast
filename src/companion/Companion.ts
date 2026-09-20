/**
 * The guide: the historian, standing in the world with you.
 *
 * You are still the camera and still have no body — the avatar you make from a
 * selfie is not you, it is who you are being shown around by. It walks the same
 * collision mesh you do, through the same capsule controller, so it can never
 * reach anywhere you could not have walked to yourself and never stands inside
 * a wall you are looking at.
 *
 * What it does with its hands comes from what the voice historian is doing:
 * talking hands while it is speaking, a nod while it is listening, and the
 * occasional unprompted wave when it has been quiet a while.
 */
import { Quaternion, Vector3, type Object3D, type Scene } from "three";
import type { Octree } from "three/addons/math/Octree.js";
import { WalkingMotor } from "../viewer/walking.ts";
import { FollowController, isEngaged, type FollowOptions, type GuideMood } from "./follow.ts";
import { blend, GestureDirector, gaze, idlePose, speechEnvelope, standing, walkPose, type Pose } from "./pose.ts";
import { Mouth } from "./mouth.ts";
import { env } from "./env.ts";
import { loadGuideModel, type GuideModel, type LoadGuideOptions } from "./loader.ts";

export type { GuideMood } from "./follow.ts";

export interface CompanionOptions extends FollowOptions {
  /** Metres. Matched to the player's own 1.65 m eye height by default. */
  height?: number;
  walkSpeed?: number;
  runSpeed?: number;
  /** Soft walk limit the world puts on the player, so the guide shares it. */
  radiusLimit?: number;
  /** Metres of ground covered per full stride. Sets the walk cycle's rate. */
  stride?: number;
  /** How brisk the hands are. 1 is the written tempo; the default is brisker. */
  gestureTempo?: number;
}

/** Half a second of jog, roughly: how far ahead of a walk a run reads. */
const WALK_SPEED = 1.75;
const RUN_SPEED = 4.4;

export class Companion {
  readonly model: GuideModel;
  readonly name: string;

  private readonly motor: WalkingMotor;
  private readonly follow: FollowController;
  private readonly director: GestureDirector;
  private readonly mouth: Mouth;
  private readonly options: Required<Pick<CompanionOptions, "height" | "walkSpeed" | "runSpeed" | "stride">>;

  private mood: GuideMood = "idle";
  private greeted = false;
  private phase = 0;
  private clock = 0;
  /** Smoothed ground speed, which is what the animation reads rather than the
   * raw per-frame delta — a capsule resolving against a kerb is spiky. */
  private speed = 0;
  private placed = false;
  /** An externally supplied mouth level, and when it last arrived. Stale by a
   * quarter second and the written envelope takes back over. */
  private speech = 0;
  private speechFedAt = -Infinity;

  private readonly previous = new Vector3();
  private readonly facing = new Quaternion();
  private readonly unfacing = new Quaternion();
  private readonly steer = new Vector3();
  private readonly toPlayer = new Vector3();
  private readonly headAt = new Vector3();

  constructor(model: GuideModel, name: string, tree: Octree | null, options: CompanionOptions = {}) {
    this.model = model;
    this.name = name;
    const height = options.height ?? model.height;
    this.options = {
      height,
      walkSpeed: options.walkSpeed ?? WALK_SPEED,
      runSpeed: options.runSpeed ?? RUN_SPEED,
      stride: options.stride ?? 1.5,
    };
    this.motor = new WalkingMotor(tree, {
      // Eye height is what the motor positions by; for the guide it only has to
      // be a sane point inside the body, and the head is where we want it.
      eyeHeight: height * 0.94,
      height,
      radius: 0.24,
      stepHeight: 0.3,
      speed: this.options.walkSpeed,
      sprintMultiplier: Math.max(1, this.options.runSpeed / this.options.walkSpeed),
      // A guide pinned to the player's own walk limit cannot reach a player
      // standing on it, so it is allowed a little more room than you have.
      radiusLimit: options.radiusLimit ? options.radiusLimit + 1.5 : 0,
    });
    this.follow = new FollowController(options);
    this.director = new GestureDirector(Math.random, options.gestureTempo);
    this.mouth = new Mouth(model.avatar, model.rigs[0] ?? null);
    if (env.DEV) console.info(`[guide] mouth: ${this.mouth.found}`);
  }

  /**
   * How open the guide's mouth should be, 0 to 1, for this instant.
   *
   * Nothing calls this yet, so the mouth runs off a written speech envelope.
   * Hand it a real amplitude — an AnalyserNode on the historian's audio would
   * do it — and it takes over for as long as it keeps arriving.
   */
  setSpeechLevel(level: number) {
    if (!Number.isFinite(level)) return;
    this.speech = Math.max(0, Math.min(1, level));
    this.speechFedAt = this.clock;
  }

  /** Whether the guide found a floor and is being drawn. */
  get ready(): boolean { return this.placed && this.motor.ready; }
  get root(): Object3D { return this.model.root; }
  /** What it is doing with its hands this instant, for tests and debugging. */
  get gesture(): string | null { return this.director.playing; }

  /**
   * Put the guide beside the player. Returns false when there is no floor to
   * put it on, which leaves the world walkable and simply guideless.
   */
  spawn(playerEye: Vector3, playerYaw: number): boolean {
    this.follow.reset(playerYaw);
    const mark = this.follow.markFor({ x: playerEye.x, z: playerEye.z }, this.mood);
    // Beside the player first, on top of them second: a guide standing where
    // you are is odd for one step, and better than no guide at all.
    this.placed = this.motor.spawn(new Vector3(mark.x, playerEye.y, mark.z)) || this.motor.spawn(playerEye.clone());
    if (this.placed) {
      const here = this.ground();
      this.previous.set(here.x, 0, here.z);
      this.speed = 0;
      this.phase = 0;
      // Already looking at you on the first frame it is seen.
      this.place(Math.atan2(playerEye.x - here.x, playerEye.z - here.z));
    }
    return this.placed;
  }

  setMood(mood: GuideMood) {
    if (mood === this.mood) return;
    this.mood = mood;
    this.director.setMood(mood);
    // Say hello the first time you speak to it, and only then.
    if (!this.greeted && isEngaged(mood)) {
      this.greeted = true;
      this.director.play("wave");
    }
  }

  /** Wave, whatever else it was doing. */
  greet() { this.director.play("wave"); }

  update(dt: number, playerEye: Vector3, playerYaw: number) {
    if (!this.placed || !this.motor.ready || dt <= 0) return;
    this.clock += dt;

    const here = this.ground();
    const step = this.follow.step(dt, { x: playerEye.x, z: playerEye.z }, playerYaw, here, this.mood);
    if (step.recover) {
      // Steering has run out of ideas — a doorway it cannot solve, or you took
      // a lift it cannot follow. Put it back beside you rather than leave it
      // scraping a wall in a room you have left.
      this.spawn(playerEye, playerYaw);
      return;
    }

    // Ease off near the mark so it settles rather than overshooting and
    // shuffling back. WalkingMotor reads a sub-unit direction as part speed.
    const reach = Math.hypot(step.mark.x - here.x, step.mark.z - here.z);
    const throttle = Math.min(1, Math.max(0.25, reach / 0.9));
    this.motor.update(dt, this.steer.set(step.move.x * throttle, 0, step.move.z * throttle), step.running);

    const now = this.ground();
    const travelled = Math.hypot(now.x - this.previous.x, now.z - this.previous.z);
    this.previous.set(now.x, 0, now.z);
    // Smoothed over roughly a tenth of a second.
    this.speed += (travelled / dt - this.speed) * Math.min(1, dt / 0.1);

    const gesture = this.director.update(dt);
    const locomotion = this.pose(travelled);
    this.place(step.facing, this.model.clips ? 0 : locomotion.bob);

    if (this.model.clips) {
      const walking = this.speed > 0.35;
      this.model.clips.transition(!walking ? "idle" : this.speed > 3 ? "run" : "walk");
      this.model.clips.update(dt, walking ? Math.min(1.8, Math.max(0.6, this.speed / 1.4)) : 1);
      const look = this.lookPose(playerEye, step.holding);
      for (const rig of this.model.rigs) {
        if (look) rig.applyOverlay(look, 1, this.facing);
        if (gesture) rig.applyOverlay(gesture.pose, gesture.weight, this.facing);
      }
      this.moveMouth();
      return;
    }

    let pose = locomotion;
    const look = this.lookPose(playerEye, step.holding);
    if (look) pose = blend(pose, look, 1);
    if (gesture) pose = blend(pose, gesture.pose, gesture.weight);
    for (const rig of this.model.rigs) rig.apply(pose, this.facing);
    this.moveMouth();
  }

  dispose() {
    this.model.dispose();
  }

  /** Add to a scene. The guide lives in rendered world space beside the camera,
   * not under the splat's convention transform. */
  attach(scene: Scene) { scene.add(this.model.root); }

  /** After the body is posed, because the jaw hangs off a head that just moved. */
  private moveMouth() {
    if (this.mood !== "speaking") { this.mouth.close(this.facing); return; }
    const fed = this.clock - this.speechFedAt < 0.25;
    this.mouth.update(fed ? this.speech : speechEnvelope(this.clock), this.clock, this.facing);
  }

  private ground() {
    return { x: this.motor.capsule.start.x, z: this.motor.capsule.start.z };
  }

  private place(facing: number, bob = 0) {
    const root = this.model.root;
    root.position.set(this.motor.capsule.start.x, this.motor.feetY + bob, this.motor.capsule.start.z);
    root.rotation.set(0, facing, 0);
    root.updateMatrixWorld(true);
    root.getWorldQuaternion(this.facing);
  }

  /** Walk cycle over idle, crossfaded on how fast it is actually moving. */
  private pose(travelled: number): Pose {
    const { walkSpeed, runSpeed, stride } = this.options;
    const effort = Math.min(1, Math.max(0, (this.speed - walkSpeed) / Math.max(0.1, runSpeed - walkSpeed)));
    // Advanced by ground covered, not by time, so the feet never skate: a
    // longer stride at a jog, and no cycle at all while it is standing still.
    this.phase = (this.phase + travelled / (stride * (1 + effort * 0.4))) % 1;
    const moving = Math.min(1, Math.max(0, (this.speed - 0.12) / 0.4));
    if (moving <= 0) return idlePose(this.clock);
    return blend(idlePose(this.clock), walkPose(this.phase, effort), moving);
  }

  /**
   * Turn the head towards the player. Fully while it is standing with you, and
   * only partly while it is walking, where a head locked on over one shoulder
   * looks less like attention and more like a fault.
   */
  private lookPose(playerEye: Vector3, holding: boolean): Partial<Pose> | null {
    const head = this.model.rigs[0]?.get("Head");
    if (!head) return null;
    head.getWorldPosition(this.headAt);
    this.toPlayer.subVectors(playerEye, this.headAt);
    if (this.toPlayer.lengthSq() < 1e-6) return null;
    this.toPlayer.applyQuaternion(this.unfacing.copy(this.facing).invert());
    const flat = Math.hypot(this.toPlayer.x, this.toPlayer.z);
    const yaw = clamp(Math.atan2(this.toPlayer.x, this.toPlayer.z), -0.85, 0.85);
    const pitch = clamp(-Math.atan2(this.toPlayer.y, Math.max(0.2, flat)), -0.38, 0.34);
    const weight = holding || isEngaged(this.mood) ? 1 : 0.4;
    return { head: gaze(yaw * weight, pitch * weight + 0.02), headTwist: yaw * 0.75 * weight };
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export interface CreateCompanionOptions extends CompanionOptions, LoadGuideOptions {}

/** Load a stored avatar and make a guide out of it. */
export async function createCompanion(
  glb: ArrayBuffer,
  name: string,
  tree: Octree | null,
  options: CreateCompanionOptions = {},
): Promise<Companion | null> {
  const model = await loadGuideModel(glb, options);
  if (!model.rigs.length) {
    // Nothing recognisable to pose. Drawing a T-posed statue that slides around
    // the world is worse than showing no guide.
    model.dispose();
    console.warn("[guide] the avatar has no humanoid skeleton this app recognises");
    return null;
  }
  // Out of the T-pose before its first frame, so it is never seen in one.
  model.root.updateMatrixWorld(true);
  const rest = new Quaternion();
  for (const rig of model.rigs) rig.apply(standing(), rest);
  return new Companion(model, name, tree, options);
}
