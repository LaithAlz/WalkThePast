/**
 * Loading the guide: an avatar GLB in, something posable out.
 *
 * Two things have to be true of whatever arrives. Its materials have to survive
 * the trip — selfie avatars routinely export hair and eyelashes as blended
 * transparency with a zero base alpha, which renders as either nothing at all
 * or a halo of sorting artefacts. And it has to be the right size for a metric
 * world, which means measuring it rather than trusting the exporter.
 *
 * Locomotion clips are optional. Drop a Mixamo GLB at
 * public/characters/<slug>/character.glb and its idle/walk/run take over the
 * body; with nothing there, everything is posed from src/companion/pose.ts.
 */
import {
  AnimationClip, AnimationMixer, Box3, DoubleSide, Group, KeyframeTrack,
  Mesh, MeshStandardMaterial, Object3D, Vector3, type AnimationAction,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { canonicalBone, Rig, type BoneName } from "./rig.ts";
import { env } from "./env.ts";

/** Folder under public/characters that locomotion clips are read from. */
export const CLIP_SLUG: string = env.VITE_GUIDE_CLIPS || "guide";

/** Eye-to-eye with the player, whose own eye height is 1.65 m. */
export const DEFAULT_HEIGHT = 1.74;

export type ClipState = "idle" | "walk" | "run";

export interface GuideModel {
  /** Scene-space: position is the guide's feet, rotation.y is where it faces. */
  root: Group;
  avatar: Object3D;
  /** One per armature. Selfie avatars split the body across several. */
  rigs: Rig[];
  /** Metres, after fitting. */
  height: number;
  clips: ClipPlayer | null;
  dispose(): void;
}

const loader = new GLTFLoader();

/**
 * Bring a selfie avatar's materials back to something renderable.
 *
 * Both branches convert blended transparency into an alpha cutout. Hair and
 * eyelash cards overlap each other constantly, and blended transparency has to
 * be depth-sorted to look right, which a card-based haircut never is.
 */
function repairMaterials(avatar: Object3D) {
  avatar.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    // A skinned mesh's bounds are its bind pose, so a raised arm culls the body.
    child.frustumCulled = false;
    for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
      if (!(material instanceof MeshStandardMaterial)) continue;
      if (material.transparent && material.opacity === 0) {
        material.opacity = 1;
        material.alphaTest = 0.5;
      } else if (material.transparent && material.map) {
        material.alphaTest = 0.4;
      } else continue;
      material.transparent = false;
      material.depthWrite = true;
      material.side = DoubleSide;
      material.needsUpdate = true;
    }
  });
}

/** Every armature in the avatar, as its own rig. */
function rigsOf(avatar: Object3D): Rig[] {
  const armatures: Object3D[] = [];
  avatar.traverse((object) => {
    if (canonicalBone(object.name) !== "Hips") return;
    const armature = object.parent ?? avatar;
    if (!armatures.includes(armature)) armatures.push(armature);
  });
  const rigs = (armatures.length ? armatures : [avatar]).map((root) => new Rig(root));
  return rigs.filter((rig) => rig.usable);
}

/**
 * Retarget clips onto this avatar's own bone names.
 *
 * Done through the canonical names rather than by rewriting a prefix, so a
 * "mixamorig:Hips" clip binds to "Hips", "mixamorig9:Hips" or "pelvis" alike.
 * A track with nowhere to go is dropped: the mixer would skip it in silence,
 * and a silent skip is how a clip ends up half playing.
 *
 * Rotation only. Translation carries the donor's proportions, and this avatar
 * is a different height, so its hips would drift and its feet would skate.
 */
export function retarget(clips: AnimationClip[], rig: Rig): AnimationClip[] {
  const names = new Map<BoneName, string>();
  for (const bone of rig.found.bones) names.set(bone, rig.get(bone)!.name);
  return clips.map((clip) => {
    const tracks: KeyframeTrack[] = [];
    for (const track of clip.tracks) {
      const dot = track.name.lastIndexOf(".");
      if (dot < 0 || !track.name.endsWith(".quaternion")) continue;
      const bone = canonicalBone(track.name.slice(0, dot));
      const target = bone && names.get(bone);
      if (!target) continue;
      const Track = track.constructor as new (n: string, t: ArrayLike<number>, v: ArrayLike<number>) => KeyframeTrack;
      tracks.push(new Track(`${target}.quaternion`, track.times.slice(), track.values.slice()));
    }
    return new AnimationClip(clip.name, clip.duration, tracks, clip.blendMode);
  });
}

/** Crossfaded idle/walk/run, one mixer per armature so each binds its own bones. */
export class ClipPlayer {
  private readonly mixers: AnimationMixer[];
  private readonly actions: Partial<Record<ClipState, AnimationAction[]>> = {};
  private current: ClipState = "idle";

  constructor(rigs: Rig[], roots: Object3D[], clips: AnimationClip[]) {
    this.mixers = roots.map((root) => new AnimationMixer(root));
    for (const state of ["idle", "walk", "run"] as ClipState[]) {
      const clip = clips.find((c) => c.name.toLowerCase() === state)
        ?? clips.find((c) => c.name.toLowerCase().includes(state));
      if (!clip || !clip.tracks.length) continue;
      this.actions[state] = this.mixers.map((mixer, index) =>
        mixer.clipAction(retarget([clip], rigs[index])[0]));
    }
    for (const action of this.actions.idle ?? []) action.play();
  }

  /** Whether there is anything to play at all. */
  get ready(): boolean { return !!this.actions.idle?.length; }
  get state(): ClipState { return this.current; }

  transition(next: ClipState, fade = 0.22) {
    if (next === this.current || !this.actions[next]?.length) return;
    const previous = this.actions[this.current] ?? [];
    this.actions[next]!.forEach((action, index) => {
      previous[index]?.fadeOut(fade);
      action.reset().setEffectiveWeight(1).fadeIn(fade).play();
    });
    this.current = next;
  }

  /** `rate` scales the clip so a walk cycle matches the distance covered. */
  update(dt: number, rate = 1) {
    for (const action of this.actions[this.current] ?? []) action.setEffectiveTimeScale(rate);
    for (const mixer of this.mixers) mixer.update(dt);
  }

  dispose() {
    for (const mixer of this.mixers) mixer.stopAllAction();
  }
}

/** Locomotion clips for the guide, or null when none are installed. */
async function loadClips(slug: string, signal?: AbortSignal): Promise<AnimationClip[] | null> {
  const base = `${(env.BASE_URL ?? "/").replace(/\/$/, "")}/characters/${slug}/character.glb`;
  try {
    const response = await fetch(base, { signal });
    if (!response.ok) return null;
    const gltf = await loader.parseAsync(await response.arrayBuffer(), "");
    return gltf.animations.length ? gltf.animations : null;
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

export interface LoadGuideOptions {
  height?: number;
  clipSlug?: string;
  signal?: AbortSignal;
}

export async function loadGuideModel(glb: ArrayBuffer, options: LoadGuideOptions = {}): Promise<GuideModel> {
  const gltf = await loader.parseAsync(glb, "");
  options.signal?.throwIfAborted();
  const avatar = gltf.scene;
  repairMaterials(avatar);

  // Measure, then fit. Avatar services export at their own idea of human size,
  // and a world in metres will not forgive a guess.
  avatar.updateMatrixWorld(true);
  const bounds = new Box3().setFromObject(avatar);
  const size = bounds.getSize(new Vector3());
  const target = options.height ?? DEFAULT_HEIGHT;
  const scale = size.y > 1e-3 ? target / size.y : 1;

  const root = new Group();
  root.name = "guide";
  avatar.scale.multiplyScalar(scale);
  // Stand the avatar on the root's origin, wherever its exporter put the floor.
  avatar.position.y = -bounds.min.y * scale;
  root.add(avatar);
  root.updateMatrixWorld(true);

  const rigs = rigsOf(avatar);
  const armatures = rigs.length ? rigs.map((rig) => rig.get("Hips")!.parent ?? avatar) : [avatar];

  let clips: ClipPlayer | null = null;
  if (rigs.length) {
    const donated = await loadClips(options.clipSlug ?? CLIP_SLUG, options.signal);
    if (donated) {
      const player = new ClipPlayer(rigs, armatures, donated);
      clips = player.ready ? player : null;
      if (!clips) player.dispose();
    }
  }

  return {
    root, avatar, rigs, clips,
    height: size.y * scale,
    dispose() {
      clips?.dispose();
      root.removeFromParent();
      avatar.traverse((child) => {
        if (!(child instanceof Mesh)) return;
        child.geometry.dispose();
        for (const material of Array.isArray(child.material) ? child.material : [child.material]) material.dispose();
      });
    },
  };
}
