/**
 * Turns a pose — a set of directions for the limbs to point in — into bone
 * rotations, on whatever humanoid skeleton the avatar happens to arrive with.
 *
 * Every exporter orients its bone axes differently, so nothing here assumes an
 * axis. A bone's own direction is read from where its child sits in the rest
 * pose, and aiming it is then the shortest rotation that carries that direction
 * onto the one the pose asks for. That works identically on an Avaturn selfie
 * avatar, a Mixamo download and a Ready Player Me export.
 *
 * The one thing a direction cannot express is twist about the limb's own
 * length, which is what turns a face towards you. That is passed separately and
 * applied in the bone's own frame, where it leaves the aim untouched.
 */
import { Object3D, Quaternion, Vector3 } from "three";
import type { Aim, PartialPose, Pose } from "./pose.ts";

export const BONE_NAMES = [
  "Hips", "Spine", "Spine1", "Spine2", "Neck", "Head", "HeadTop_End", "Jaw",
  "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand",
  "RightShoulder", "RightArm", "RightForeArm", "RightHand",
  "LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase",
  "RightUpLeg", "RightLeg", "RightFoot", "RightToeBase",
] as const;

export type BoneName = (typeof BONE_NAMES)[number];

/** Mixamo naming with the prefix and separators taken off, which is what
 * Avaturn, Ready Player Me and Mixamo itself all reduce to. */
const CANONICAL = new Map<string, BoneName>(BONE_NAMES.map((n) => [key(n), n]));

/** The handful of other names a humanoid export reaches for. */
const ALIASES: Record<string, BoneName> = {
  leftupperarm: "LeftArm", rightupperarm: "RightArm",
  leftlowerarm: "LeftForeArm", rightlowerarm: "RightForeArm",
  leftupperleg: "LeftUpLeg", rightupperleg: "RightUpLeg",
  leftlowerleg: "LeftLeg", rightlowerleg: "RightLeg",
  lefttoe: "LeftToeBase", righttoe: "RightToeBase",
  headend: "HeadTop_End", headtop: "HeadTop_End",
  lowerjaw: "Jaw", jawbone: "Jaw",
  pelvis: "Hips", chest: "Spine2", upperchest: "Spine2",
};

/** Lower-case, no "mixamorig" prefix, no separators. */
export function key(name: string): string {
  return name.toLowerCase().replace(/^mixamorig\d*/, "").replace(/[^a-z0-9]/g, "");
}

export function canonicalBone(name: string): BoneName | null {
  const k = key(name);
  return CANONICAL.get(k) ?? ALIASES[k] ?? null;
}

/**
 * Which bone each aimed channel drives, which child gives it a direction, and
 * the pose's own twist for it where there is one.
 *
 * The order is the hierarchy's, root first, and has to stay that way. Aiming a
 * bone reads its parent's world rotation, so a torso twisted after the arms
 * have been aimed would carry them off the directions they were just given.
 */
const CHANNELS: ReadonlyArray<readonly [keyof Pose, BoneName, BoneName, ("spineTwist" | "headTwist")?]> = [
  ["spine", "Spine", "Spine1", "spineTwist"],
  ["leftArm", "LeftArm", "LeftForeArm"],
  ["leftForeArm", "LeftForeArm", "LeftHand"],
  ["rightArm", "RightArm", "RightForeArm"],
  ["rightForeArm", "RightForeArm", "RightHand"],
  ["leftUpLeg", "LeftUpLeg", "LeftLeg"],
  ["leftLeg", "LeftLeg", "LeftFoot"],
  ["leftFoot", "LeftFoot", "LeftToeBase"],
  ["rightUpLeg", "RightUpLeg", "RightLeg"],
  ["rightLeg", "RightLeg", "RightFoot"],
  ["rightFoot", "RightFoot", "RightToeBase"],
  ["head", "Head", "HeadTop_End", "headTwist"],
];

/**
 * Rotation about each limb's own length. A direction leaves this free, and the
 * free choice points elbows and knees whichever way the T-pose happened to hold
 * them. These are the corrections; if an avatar's elbows bow outwards, this is
 * the one place to tune.
 */
const TWIST: Partial<Record<BoneName, number>> = {
  LeftArm: 0.12, RightArm: -0.12,
  LeftForeArm: 0.1, RightForeArm: -0.1,
};

const UP = new Vector3(0, 1, 0);
const FORWARD = new Vector3(0, 0, 1);

const parentQ = new Quaternion();
const target = new Vector3();
const aimQ = new Quaternion();
const twistQ = new Quaternion();
const deltaQ = new Quaternion();
const axis = new Vector3();
const facingInverse = new Quaternion();

export class Rig {
  private readonly bones = new Map<BoneName, Object3D>();
  private readonly restQuaternion = new Map<BoneName, Quaternion>();
  /** Each aimed bone's own direction, in its own space, from the rest pose. */
  private readonly shafts = new Map<BoneName, Vector3>();

  /** Read the skeleton out of a loaded avatar, and remember its rest pose. */
  constructor(root: Object3D) {
    root.traverse((object) => {
      const name = canonicalBone(object.name);
      // First match wins: an avatar split into several armatures repeats the
      // bone names across them, and they all hold the same rest pose.
      if (name && !this.bones.has(name)) this.bones.set(name, object);
    });
    for (const [name, bone] of this.bones) this.restQuaternion.set(name, bone.quaternion.clone());
    // A bone's direction is exactly where the child we intend to aim it by
    // sits — not wherever its longest child happens to be, which on some
    // avatars is an eye or a hair root.
    for (const [, name, childName] of CHANNELS) {
      const child = this.bones.get(childName);
      if (!this.bones.has(name) || !child || child.position.lengthSq() < 1e-12) continue;
      this.shafts.set(name, child.position.clone().normalize());
    }
  }

  /** Enough of a skeleton to be worth posing. */
  get usable(): boolean {
    return this.shafts.has("LeftArm") && this.shafts.has("RightArm") && this.bones.has("Hips");
  }

  get(name: BoneName): Object3D | null { return this.bones.get(name) ?? null; }

  /** The rotation the exporter left this bone in. */
  rest(name: BoneName): Quaternion | null { return this.restQuaternion.get(name) ?? null; }

  /** Which bones were found, and which of them can be aimed. For diagnostics. */
  get found(): { bones: BoneName[]; aimable: BoneName[] } {
    return { bones: [...this.bones.keys()], aimable: [...this.shafts.keys()] };
  }

  /** Put every bone back where the exporter left it. */
  restore() {
    for (const [name, quaternion] of this.restQuaternion) this.bones.get(name)!.quaternion.copy(quaternion);
  }

  /**
   * Pose the skeleton. `facing` is the avatar's world orientation, which is what
   * the pose's directions are given relative to.
   *
   * Root first, always: aiming a bone reads its parent's world rotation, so the
   * parent has to have been posed before its children are.
   */
  apply(pose: Pose, facing: Quaternion) {
    const hips = this.bones.get("Hips");
    const hipsRest = this.restQuaternion.get("Hips");
    if (hips && hipsRest && (pose.hipsRoll || pose.hipsTurn)) {
      // A tilt described in world terms, carried into the parent's frame rather
      // than the pelvis's own — a pelvis is rarely axis-aligned with anything.
      axis.copy(FORWARD).applyQuaternion(facing);
      deltaQ.setFromAxisAngle(axis, pose.hipsRoll);
      twistQ.setFromAxisAngle(UP, pose.hipsTurn);
      deltaQ.premultiply(twistQ);
      worldQuaternionOfParent(hips);
      hips.quaternion.copy(parentQ).invert().multiply(deltaQ).multiply(parentQ).multiply(hipsRest);
    } else if (hips && hipsRest) {
      hips.quaternion.copy(hipsRest);
    }
    for (const [channel, bone, , twist] of CHANNELS) {
      this.aim(bone, pose[channel] as Aim, facing, (TWIST[bone] ?? 0) + (twist ? pose[twist] : 0));
    }
  }

  /**
   * Lay a partial pose over whatever the bones are already doing, at `weight`.
   *
   * This is the path used when a Mixamo clip is driving the body: the clip has
   * already written the bones for this frame, so each aimed channel is read
   * back out of them and eased towards the gesture rather than replaced. The
   * legs keep walking while the arms do something else.
   */
  applyOverlay(pose: PartialPose, weight: number, facing: Quaternion) {
    const w = Math.max(0, Math.min(1, weight));
    if (w === 0) return;
    for (const [channel, bone, , twist] of CHANNELS) {
      const wanted = pose[channel] as Aim | undefined;
      const turn = twist ? pose[twist] : undefined;
      if (!wanted && turn === undefined) continue;
      const current = this.currentAim(bone, facing);
      // Without a current direction to read there is nothing to ease from, so
      // the aim is taken whole and only the twist is scaled.
      const blended = wanted && current
        ? { x: current.x + (wanted.x - current.x) * w, y: current.y + (wanted.y - current.y) * w, z: current.z + (wanted.z - current.z) * w }
        : wanted ?? current;
      if (!blended) continue;
      this.aim(bone, blended, facing, ((TWIST[bone] ?? 0) + (turn ?? 0)) * w);
    }
  }

  /** Where a bone is pointing right now, in the avatar's own frame. */
  private currentAim(name: BoneName, facing: Quaternion): Aim | null {
    const bone = this.bones.get(name);
    const shaft = this.shafts.get(name);
    if (!bone || !shaft) return null;
    bone.getWorldQuaternion(parentQ);
    target.copy(shaft).applyQuaternion(parentQ);
    facingInverse.copy(facing).invert();
    target.applyQuaternion(facingInverse).normalize();
    return { x: target.x, y: target.y, z: target.z };
  }

  /** Point `bone` along a direction given in the avatar's own frame. */
  private aim(name: BoneName, direction: Aim, facing: Quaternion, twist: number) {
    const bone = this.bones.get(name);
    const shaft = this.shafts.get(name);
    // No child to take a direction from means nothing sensible to aim; the
    // bone keeps whatever the exporter gave it.
    if (!bone || !shaft) return;
    target.set(direction.x, direction.y, direction.z);
    if (target.lengthSq() < 1e-8) return;
    target.applyQuaternion(facing).normalize();
    worldQuaternionOfParent(bone);
    target.applyQuaternion(parentQ.invert()).normalize();
    aimQ.setFromUnitVectors(shaft, target);
    bone.quaternion.copy(aimQ);
    if (twist) {
      twistQ.setFromAxisAngle(shaft, twist);
      bone.quaternion.multiply(twistQ);
    }
  }
}

/**
 * Turn a bone about a world axis, on top of its rest pose.
 *
 * For the jaw, which has no direction worth aiming — it hinges, and which way
 * its own axes point is anybody's guess. The rotation is described in world
 * terms and carried into the parent's frame, the same way the pelvis tilt is.
 */
export function hinge(rig: Rig, name: BoneName, worldAxis: Vector3, radians: number) {
  const bone = rig.get(name);
  const rest = rig.rest(name);
  if (!bone || !rest) return;
  deltaQ.setFromAxisAngle(worldAxis, radians);
  worldQuaternionOfParent(bone);
  bone.quaternion.copy(parentQ).invert().multiply(deltaQ).multiply(parentQ).multiply(rest);
}

/** The parent's world rotation, into the shared scratch quaternion. A bone with
 * no parent is not in a scene, so identity is the honest answer. */
function worldQuaternionOfParent(bone: Object3D) {
  if (bone.parent) bone.parent.getWorldQuaternion(parentQ);
  else parentQ.identity();
}
