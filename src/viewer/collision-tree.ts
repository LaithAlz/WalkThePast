import { Octree } from "three/addons/math/Octree.js";

/** Pad both bounds. Octree's default min-only padding can round a child maximum
 * just below a coplanar floor/ceiling, dropping that surface during subdivision. */
export class CollisionTree extends Octree {
  override calcBox() {
    this.box = this.bounds.clone().expandByScalar(0.01);
    return this;
  }
}
