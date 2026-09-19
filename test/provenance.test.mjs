// Unit test for the classifier: synthetic scene, no GPU. Run: npm test
import assert from "node:assert/strict";
import * as THREE from "three";
import { computeProvenance, classifyPoint, makeSourceCamera, CLASS_VISIBLE, CLASS_OCCLUDED, CLASS_UNSUPPORTED } from "../src/viewer/provenance.ts";

// camera at origin looking down -z, 60° vertical fov, 4:3
const cam = makeSourceCamera([0, 0, 0], [0, 0, 0, 1], 60, 4 / 3);
const pts = [
  [0, 0, -2],      // 0: wall in front, centre of frame           -> VISIBLE
  [0, 0, -4],      // 1: directly behind that wall                -> OCCLUDED
  [0, 0, 2],       // 2: behind the camera                        -> UNSUPPORTED
  [10, 0, -2],     // 3: far to the right, outside the frame      -> UNSUPPORTED
  [0.4, 0.3, -2.05], // 4: slightly behind the wall plane but within tolerance -> VISIBLE
  [1.0, 0, -3],    // 5: in frame, nothing in front of it         -> VISIBLE
];
const positions = new Float32Array(pts.flat());
const maxScales = new Float32Array(pts.map(() => 0.05));
maxScales[0] = 0.5; // the wall gaussian is large so it covers pixels
const opacities = new Float32Array(pts.map(() => 0.9));
const res = computeProvenance(positions, maxScales, opacities, cam, { width: 200 });
assert.equal(res.classes[0], CLASS_VISIBLE, "wall visible");
assert.equal(res.classes[1], CLASS_OCCLUDED, "behind wall occluded");
assert.equal(res.classes[2], CLASS_UNSUPPORTED, "behind camera unsupported");
assert.equal(res.classes[3], CLASS_UNSUPPORTED, "outside frame unsupported");
assert.equal(res.classes[4], CLASS_VISIBLE, "within tolerance visible");
assert.equal(res.classes[5], CLASS_VISIBLE, "unoccluded visible");
assert.deepEqual(res.counts, [2, 1, 3]);

const v1 = classifyPoint(res, new THREE.Vector3(0, 0, -4));
assert.equal(v1.cls, CLASS_OCCLUDED);
assert.match(v1.reason, /behind the surface/);
const v2 = classifyPoint(res, new THREE.Vector3(-10, 0, -2));
assert.equal(v2.cls, CLASS_UNSUPPORTED);
assert.match(v2.reason, /left of/);
const v3 = classifyPoint(res, new THREE.Vector3(0, 0, -1.9));
assert.equal(v3.cls, CLASS_VISIBLE);
console.log("provenance tests passed", res.counts);
