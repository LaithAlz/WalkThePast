/**
 * Making the guide's mouth move while it talks.
 *
 * Which lever exists depends entirely on where the avatar came from. Selfie and
 * avatar services export ARKit or Oculus blend shapes and no facial bones at
 * all; a Mixamo download has neither; the odd rig has a jaw bone instead. So
 * this finds whatever is there, in that order of preference, and drives it from
 * a single 0-to-1 level. An avatar with none of them simply keeps its mouth
 * shut, which is the right answer and not a failure.
 *
 * Blend shapes are preferred over a jaw hinge for a reason: speech is not a
 * mouth opening and closing, it is the shape changing. Where the vowel shapes
 * exist this drifts between a wide one and a rounded one as it goes, which
 * reads as talking rather than as chewing.
 */
import { Mesh, Vector3, type Object3D, type Quaternion } from "three";
import { hinge, type Rig } from "./rig.ts";

/** Lower-case, no separators, so `viseme_aa`, `visemeAA` and `Viseme AA` agree. */
const key = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Shapes that drop the jaw. ARKit's jawOpen, Ready Player Me's mouthOpen,
 * and the open vowels from both viseme sets. */
const OPEN = ["jawopen", "mouthopen", "visemeaa", "visemeah", "vrc.vaa", "aa", "mouthlowerdown"];
/** Wide, as in "ee". */
const WIDE = ["visemei", "visemee", "visemeih", "mouthsmile", "mouthsmileleft", "mouthsmileright", "mouthstretchleft", "mouthstretchright"];
/** Rounded, as in "oo". */
const ROUND = ["visemeo", "visemeu", "visemeou", "mouthpucker", "mouthfunnel"];

interface Driven {
  influences: number[];
  index: number;
  /** How far this shape goes at a level of 1. */
  gain: number;
}

const RIGHT = new Vector3(1, 0, 0);
const axis = new Vector3();

export class Mouth {
  private readonly open: Driven[] = [];
  private readonly wide: Driven[] = [];
  private readonly round: Driven[] = [];
  private readonly rig: Rig | null;
  private readonly hasJaw: boolean;
  private vowel = 0;

  constructor(avatar: Object3D, rig: Rig | null) {
    this.rig = rig;
    this.hasJaw = !!rig?.get("Jaw");
    avatar.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      const dictionary = object.morphTargetDictionary;
      const influences = object.morphTargetInfluences;
      if (!dictionary || !influences) return;
      for (const [name, index] of Object.entries(dictionary)) {
        const k = key(name);
        // Wide open reads as a scream, so nothing is driven to its full extent.
        if (OPEN.includes(k)) this.open.push({ influences, index, gain: 0.72 });
        else if (WIDE.includes(k)) this.wide.push({ influences, index, gain: 0.4 });
        else if (ROUND.includes(k)) this.round.push({ influences, index, gain: 0.45 });
      }
    });
  }

  /** Whether this avatar can move its mouth at all. */
  get usable(): boolean { return this.open.length > 0 || this.hasJaw; }

  /** What was found, for the one dev log that saves an hour of wondering. */
  get found(): string {
    if (this.open.length) return `${this.open.length} open, ${this.wide.length} wide, ${this.round.length} round blend shapes`;
    return this.hasJaw ? "a jaw bone" : "nothing; this avatar has no mouth to move";
  }

  /**
   * `level` is how open the mouth is, 0 to 1. `t` only drifts the vowel shape,
   * so the same level does not always mean the same face.
   */
  update(level: number, t: number, facing?: Quaternion) {
    const amount = Math.max(0, Math.min(1, level));
    // Slow enough that a shape lasts a syllable or two, as a vowel does.
    this.vowel = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 1.7);
    for (const shape of this.open) shape.influences[shape.index] = amount * shape.gain;
    for (const shape of this.wide) shape.influences[shape.index] = amount * shape.gain * this.vowel;
    for (const shape of this.round) shape.influences[shape.index] = amount * shape.gain * (1 - this.vowel);
    // Only as a fallback: an avatar with both would open its mouth twice.
    if (this.hasJaw && !this.open.length && this.rig && facing) {
      axis.copy(RIGHT).applyQuaternion(facing);
      hinge(this.rig, "Jaw", axis, amount * 0.28);
    }
  }

  /** Shut, and put the jaw back where the exporter left it. */
  close(facing?: Quaternion) {
    this.update(0, 0, facing);
  }
}
