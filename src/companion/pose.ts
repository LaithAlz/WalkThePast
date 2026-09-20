/**
 * The guide's animation, written rather than exported.
 *
 * An Avaturn selfie avatar arrives rigged but with no clips at all, and there is
 * no wave or talk clip in any of the usual Mixamo locomotion packs either. So
 * the poses here are generated: a pose is a set of directions for the limbs to
 * point in, in the character's own frame (+x right, +y up, +z forward), and the
 * rig turns each direction into a bone rotation. Directions rather than euler
 * angles because every humanoid export orients its bone axes differently, and a
 * direction means the same thing on all of them.
 *
 * Drop a Mixamo GLB at public/characters/<slug>/character.glb and its idle,
 * walk and run clips take over locomotion; the gestures below still run on top,
 * since that is the part no clip pack ships.
 *
 * No three.js here on purpose — this is arithmetic, and it tests as arithmetic.
 */

import type { GuideMood } from "./follow.ts";

export interface Aim { x: number; y: number; z: number }

export interface Pose {
  leftArm: Aim; leftForeArm: Aim;
  rightArm: Aim; rightForeArm: Aim;
  leftUpLeg: Aim; leftLeg: Aim; leftFoot: Aim;
  rightUpLeg: Aim; rightLeg: Aim; rightFoot: Aim;
  /** Torso, and how far it rotates about its own length. */
  spine: Aim; spineTwist: number;
  /** The skull's crown; twist turns the face left and right. */
  head: Aim; headTwist: number;
  /** Radians of lateral tilt and turn at the pelvis. */
  hipsRoll: number; hipsTurn: number;
  /** Metres the whole body rises and falls. The capsule does not move with it. */
  bob: number;
}

/** A gesture only claims the channels it needs; the rest keep walking. */
export type PartialPose = Partial<Pose>;

const TAU = Math.PI * 2;

export function aim(x: number, y: number, z: number): Aim {
  const length = Math.hypot(x, y, z) || 1;
  return { x: x / length, y: y / length, z: z / length };
}

/**
 * The toes, `pitch` radians above the horizontal. The foot's shaft runs forward
 * out of the ankle, so this is the one limb that does not hang.
 */
export function sole(pitch: number, splay = 0): Aim {
  return aim(Math.sin(splay), Math.sin(pitch), Math.cos(pitch) * Math.cos(splay));
}

/** A limb hanging down, swung `pitch` radians forward and `splay` out to +x. */
export function swing(pitch: number, splay = 0): Aim {
  const lateral = Math.sin(splay), plane = Math.cos(splay);
  return { x: lateral, y: -Math.cos(pitch) * plane, z: Math.sin(pitch) * plane };
}

/** The crown of the head, tipped `pitch` forward (chin down) and turned `yaw`. */
export function gaze(yaw: number, pitch: number): Aim {
  const crown = Math.cos(pitch), tip = Math.sin(pitch);
  return aim(tip * Math.sin(yaw), crown, tip * Math.cos(yaw));
}

function mixAim(a: Aim, b: Aim, t: number): Aim {
  return aim(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** Ease a 0..1 ramp so gestures arrive and leave without a visible corner. */
export const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/**
 * How open a talking mouth is at time `t`, 0 to 1.
 *
 * Syllables at about four a second, riding a slower phrase contour that carries
 * it closed between clauses the way breathing does. The two rates are
 * deliberately incommensurate, so it never settles into a visible loop.
 *
 * Replaced wholesale the moment something hands the guide a real amplitude —
 * see `Companion.setSpeechLevel`.
 */
export function speechEnvelope(t: number): number {
  const syllable = 0.5 + 0.5 * Math.sin(t * TAU * 4.1);
  const phrase = 0.5 + 0.5 * Math.sin(t * TAU * 0.83 + 2.1);
  // A third, faster beat stands in for consonants clipping the vowel short.
  const clip = 0.82 + 0.18 * Math.sin(t * TAU * 7.3 + 0.4);
  return Math.max(0, Math.min(1, syllable * phrase * clip * 1.35));
}

const ARM_SPLAY = 0.27;
const ELBOW = 0.26;

/** Relaxed stand. Also the pose an avatar is pulled into out of its T-pose. */
export function standing(): Pose {
  return {
    leftArm: swing(0.04, -ARM_SPLAY), leftForeArm: swing(0.04 + ELBOW, -ARM_SPLAY * 0.7),
    rightArm: swing(0.04, ARM_SPLAY), rightForeArm: swing(0.04 + ELBOW, ARM_SPLAY * 0.7),
    leftUpLeg: swing(0, -0.045), leftLeg: swing(0.02, -0.02), leftFoot: sole(-0.26, -0.045),
    rightUpLeg: swing(0, 0.045), rightLeg: swing(0.02, 0.02), rightFoot: sole(-0.26, 0.045),
    spine: aim(0, 1, 0.012), spineTwist: 0,
    head: gaze(0, 0.02), headTwist: 0,
    hipsRoll: 0, hipsTurn: 0, bob: 0,
  };
}

/** Breathing, a slow shift of weight, and a head that is never quite still. */
export function idlePose(t: number): Pose {
  const breath = Math.sin(t * TAU * 0.23);
  const shift = Math.sin(t * TAU * 0.11);
  const drift = Math.sin(t * TAU * 0.07 + 1.3);
  const base = standing();
  return {
    ...base,
    leftArm: swing(0.04 + breath * 0.022, -ARM_SPLAY - shift * 0.02),
    rightArm: swing(0.04 - breath * 0.022, ARM_SPLAY - shift * 0.02),
    leftForeArm: swing(0.04 + ELBOW + breath * 0.03, -ARM_SPLAY * 0.7),
    rightForeArm: swing(0.04 + ELBOW - breath * 0.03, ARM_SPLAY * 0.7),
    spine: aim(shift * 0.02, 1, 0.012 + breath * 0.016),
    spineTwist: shift * 0.03,
    head: gaze(drift * 0.16, 0.02 + breath * 0.02),
    headTwist: drift * 0.2,
    hipsRoll: shift * 0.026,
    hipsTurn: shift * -0.02,
    bob: breath * 0.005,
  };
}

/**
 * One stride. `phase` wraps at 1 and is advanced by distance covered, not by
 * time, so the feet stay on the ground whatever the speed. `effort` is 0 at a
 * walk and 1 at a jog, and widens every amplitude in the cycle.
 */
export function walkPose(phase: number, effort = 0): Pose {
  // Heel down at the front of the stride, toes pointed through push-off, level
  // again on the way through. One curve, read at two opposite points.
  const step = (angle: number) => -0.30 - 0.34 * Math.sin(angle - 1.0);
  const a = phase * TAU;
  const forward = Math.cos(a);
  const gait = 1 + effort * 0.55;
  const thigh = 0.44 * gait, armSwing = 0.36 * gait;
  // The knee folds on the swing through, which is the half of the cycle where
  // the thigh is travelling forward — that is where sin(a) turns negative.
  const leftKnee = 0.92 * gait * Math.max(0, -Math.sin(a));
  const rightKnee = 0.92 * gait * Math.max(0, Math.sin(a));
  const leftThigh = thigh * forward, rightThigh = -thigh * forward;
  return {
    leftUpLeg: swing(leftThigh, -0.045),
    leftLeg: swing(leftThigh - leftKnee, -0.02),
    leftFoot: sole(step(a), -0.045),
    rightUpLeg: swing(rightThigh, 0.045),
    rightLeg: swing(rightThigh - rightKnee, 0.02),
    rightFoot: sole(step(a + Math.PI), 0.045),
    // Arms answer the legs, or the whole body reads as a shop dummy on a track.
    leftArm: swing(-armSwing * forward, -ARM_SPLAY + 0.06),
    leftForeArm: swing(-armSwing * forward + ELBOW + 0.22 * gait, -ARM_SPLAY * 0.6),
    rightArm: swing(armSwing * forward, ARM_SPLAY - 0.06),
    rightForeArm: swing(armSwing * forward + ELBOW + 0.22 * gait, ARM_SPLAY * 0.6),
    spine: aim(0, 1, 0.06 + effort * 0.12),
    spineTwist: -0.07 * gait * forward,
    head: gaze(0, 0.02),
    headTwist: 0.05 * gait * forward,
    hipsRoll: 0.04 * gait * Math.sin(a),
    hipsTurn: 0.08 * gait * forward,
    // Two dips a stride, one per footfall.
    bob: -0.022 * gait * Math.cos(a * 2),
  };
}

export function blend(base: Pose, over: PartialPose, weight: number): Pose {
  if (weight <= 0) return base;
  const w = Math.min(1, weight);
  const out = { ...base };
  for (const key of Object.keys(over) as (keyof Pose)[]) {
    const value = over[key];
    if (value === undefined) continue;
    if (typeof value === "number") (out[key] as number) = mix(base[key] as number, value, w);
    else (out[key] as Aim) = mixAim(base[key] as Aim, value, w);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Gestures
// ---------------------------------------------------------------------------

export type GestureKind = "wave" | "present" | "offer" | "count" | "point" | "nod" | "consider";

export interface Gesture {
  kind: GestureKind;
  /** Seconds the gesture runs for, before its tail fades out. */
  duration: number;
  pose: (u: number) => PartialPose;
}

/** `u` is seconds since the gesture began. */
export const GESTURES: Record<GestureKind, Gesture> = {
  wave: {
    kind: "wave", duration: 2.3,
    pose: (u) => ({
      rightArm: aim(0.58, 0.74, 0.28),
      rightForeArm: aim(0.42 + 0.34 * Math.sin(u * TAU * 2.2), 0.86, 0.16),
      headTwist: 0.12, head: gaze(0.1, -0.02),
      spineTwist: -0.06,
    }),
  },
  present: {
    kind: "present", duration: 2.0,
    pose: (u) => ({
      rightArm: aim(0.34, -0.74, 0.58),
      rightForeArm: aim(0.30, -0.12 + 0.12 * Math.sin(u * TAU * 1.1), 0.94),
      spineTwist: -0.05,
    }),
  },
  offer: {
    kind: "offer", duration: 2.4,
    pose: (u) => {
      const sway = Math.sin(u * TAU * 0.85) * 0.1;
      return {
        leftArm: aim(-0.38, -0.78, 0.5), rightArm: aim(0.38, -0.78, 0.5),
        leftForeArm: aim(-0.34, -0.2 + sway, 0.92), rightForeArm: aim(0.34, -0.2 - sway, 0.92),
        spine: aim(0, 1, 0.05),
      };
    },
  },
  count: {
    kind: "count", duration: 1.9,
    pose: (u) => ({
      rightArm: aim(0.3, -0.82, 0.48),
      rightForeArm: aim(0.26, 0.04 + 0.2 * Math.sin(u * TAU * 1.6), 0.96),
      headTwist: -0.08,
    }),
  },
  point: {
    kind: "point", duration: 1.7,
    pose: (u) => ({
      rightArm: aim(0.26, 0.72 + 0.06 * Math.sin(u * TAU * 1.3), 0.62),
      rightForeArm: aim(0.14, 0.94, 0.3),
      head: gaze(0.12, -0.12), headTwist: 0.14,
    }),
  },
  nod: {
    kind: "nod", duration: 1.4,
    pose: (u) => ({ head: gaze(0, 0.02 + 0.14 * Math.sin(u * TAU * 1.5)) }),
  },
  consider: {
    kind: "consider", duration: 2.6,
    pose: (u) => ({
      head: gaze(0.22, 0.06), headTwist: 0.26 + 0.05 * Math.sin(u * TAU * 0.4),
      rightArm: aim(0.28, -0.86, 0.42), rightForeArm: aim(0.18, -0.34, 0.92),
      spineTwist: -0.08,
    }),
  },
};

/** Gestures a mood draws from, and the seconds of quiet between them. */
const REPERTOIRE: Record<GuideMood, { kinds: GestureKind[]; gap: [number, number] }> = {
  // Talking hands. Something is nearly always moving.
  speaking: { kinds: ["present", "offer", "count", "point", "nod", "wave"], gap: [0.12, 0.7] },
  thinking: { kinds: ["consider", "nod"], gap: [0.5, 1.8] },
  listening: { kinds: ["nod", "consider"], gap: [1.8, 5.0] },
  // Unprompted, and rare enough to feel like it was meant for you.
  idle: { kinds: ["wave", "nod"], gap: [16, 38] },
};

const FADE_IN = 0.22;
const FADE_OUT = 0.34;

/** How brisk the hands are. Scales every gesture's length, its internal
 * oscillation and the pause after it, so one number moves the whole feel. */
export const DEFAULT_TEMPO = 1.6;

/**
 * Chooses what the guide does with its hands and when. One gesture at a time,
 * faded in and out, with a pause between that depends on the mood.
 */
export class GestureDirector {
  private current: Gesture | null = null;
  private elapsed = 0;
  private wait = 0;
  private mood: GuideMood = "idle";
  private last: GestureKind | null = null;
  private tempo: number;
  private readonly random: () => number;

  constructor(random: () => number = Math.random, tempo = DEFAULT_TEMPO) {
    this.random = random;
    this.tempo = tempo > 0 ? tempo : DEFAULT_TEMPO;
    this.wait = this.nextGap("idle");
  }

  /** 1 is the written tempo; higher is brisker. */
  setTempo(tempo: number) {
    if (tempo > 0) this.tempo = tempo;
  }

  /** The gesture on screen right now, for tests and for the HUD. */
  get playing(): GestureKind | null { return this.current?.kind ?? null; }

  setMood(mood: GuideMood) {
    if (mood === this.mood) return;
    this.mood = mood;
    // A change of mood should show immediately, not after the old pause runs out.
    this.wait = Math.min(this.wait, mood === "speaking" ? 0.08 : 0.4);
  }

  /** Ask for a specific gesture next — a greeting when you first say hello. */
  play(kind: GestureKind) {
    this.current = GESTURES[kind];
    this.elapsed = 0;
    this.last = kind;
  }

  update(dt: number): { pose: PartialPose; weight: number } | null {
    if (!this.current) {
      this.wait -= dt;
      if (this.wait > 0) return null;
      this.play(this.pick());
    }
    const gesture = this.current!;
    // Gesture time, not wall time: a brisker tempo runs the whole gesture —
    // its length, its fades and the waving inside it — faster together.
    this.elapsed += dt * this.tempo;
    const total = gesture.duration + FADE_OUT;
    if (this.elapsed >= total) {
      this.current = null;
      this.elapsed = 0;
      this.wait = this.nextGap(this.mood);
      return null;
    }
    const weight = Math.min(
      smooth(this.elapsed / FADE_IN),
      smooth((total - this.elapsed) / FADE_OUT),
    );
    return { pose: gesture.pose(this.elapsed), weight };
  }

  private pick(): GestureKind {
    const kinds = REPERTOIRE[this.mood].kinds;
    // Two of the same in a row reads as a loop rather than a person.
    const choices = kinds.length > 1 ? kinds.filter((k) => k !== this.last) : kinds;
    return choices[Math.min(choices.length - 1, Math.floor(this.random() * choices.length))];
  }

  private nextGap(mood: GuideMood): number {
    const [low, high] = REPERTOIRE[mood].gap;
    return (low + this.random() * (high - low)) / this.tempo;
  }
}
