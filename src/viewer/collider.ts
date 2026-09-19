import { Group, Matrix4, Mesh, Texture, type Object3D } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Octree } from "three/addons/math/Octree.js";
import { CollisionTree } from "./collision-tree.ts";
import type { WorldManifest } from "./world";

/** Keep collider transforms explicit: a glTF may already have its axes/scale baked in. */
export function colliderRoot(mesh: Object3D, config: NonNullable<WorldManifest["collider"]>, splatMatrix: Matrix4): Group {
  if (config.space !== "splat" && config.space !== "world") throw new Error("Collider space must be splat or world");
  if ((config.scale !== undefined && (!Number.isFinite(config.scale) || config.scale <= 0)) ||
    [config.position, config.rotation].some(value => value !== undefined &&
      (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)))) {
    throw new Error("Invalid collider transform");
  }
  const root = new Group();
  const frame = new Group();
  frame.matrixAutoUpdate = false;
  frame.matrix.copy(config.space === "splat" ? splatMatrix : new Matrix4());
  if (config.position) root.position.fromArray(config.position);
  if (config.rotation) root.rotation.set(...config.rotation);
  root.scale.setScalar(config.scale ?? 1);
  root.add(frame);
  frame.add(mesh);
  root.updateWorldMatrix(true, true);
  return root;
}

export async function loadCollider(config: NonNullable<WorldManifest["collider"]>, splatMatrix: Matrix4, signal: AbortSignal): Promise<Octree> {
  const response = await fetch(config.url, { signal });
  if (!response.ok) throw new Error(`Collision mesh unavailable (${response.status})`);
  const data = await response.arrayBuffer();
  signal.throwIfAborted();
  const url = new URL(config.url, window.location.href);
  const gltf = await new GLTFLoader().parseAsync(data, new URL(".", url).href);
  const root = colliderRoot(gltf.scene, config, splatMatrix);
  try {
    signal.throwIfAborted();
    const tree = new CollisionTree().fromGraphNode(root);
    if (tree.bounds.isEmpty()) throw new Error("Collision mesh has no triangles");
    return tree;
  } finally {
    // The octree retains triangle copies, so no render geometry/materials need survive.
    root.traverse(object => {
      if (!(object instanceof Mesh)) return;
      object.geometry.dispose();
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        for (const value of Object.values(material)) if (value instanceof Texture) value.dispose();
        material.dispose();
      }
    });
  }
}
