import assert from 'node:assert/strict';
import test from 'node:test';
import { AnimationClip, Bone, BoxGeometry, Group, Mesh, MeshBasicMaterial, Object3D, Quaternion, QuaternionKeyframeTrack, Vector3, VectorKeyframeTrack } from 'three';
import { angleDelta, FollowController } from '../src/companion/follow.ts';
import { GestureDirector, aim, blend, idlePose, speechEnvelope, standing, walkPose } from '../src/companion/pose.ts';
import { canonicalBone, key, Rig } from '../src/companion/rig.ts';
import { Mouth } from '../src/companion/mouth.ts';
import { retarget } from '../src/companion/loader.ts';
import { Companion } from '../src/companion/Companion.ts';
import { CollisionTree } from '../src/viewer/collision-tree.ts';

const AIM_CHANNELS = ['leftArm', 'leftForeArm', 'rightArm', 'rightForeArm', 'leftUpLeg', 'leftLeg', 'leftFoot', 'rightUpLeg', 'rightLeg', 'rightFoot', 'spine', 'head'];

const at = (x, z) => ({ x, z });
/** Steer a guide towards its mark at a fixed speed, one frame at a time. */
function walk(follow, player, yaw, guide, { seconds = 6, dt = 1 / 60, speed = 1.75, mood = 'idle' } = {}) {
  let last;
  for (let t = 0; t < seconds; t += dt) {
    last = follow.step(dt, player, yaw, guide, mood);
    if (last.recover) return { ...last, guide };
    guide = { x: guide.x + last.move.x * speed * dt, z: guide.z + last.move.z * speed * dt };
  }
  return { ...last, guide };
}

test('angleDelta takes the short way round', () => {
  assert.equal(angleDelta(0, Math.PI / 2).toFixed(6), (Math.PI / 2).toFixed(6));
  assert.ok(angleDelta(3.0, -3.0) > 0, 'crossing pi goes forwards, not most of the way back');
  assert.ok(Math.abs(angleDelta(3.0, -3.0)) < Math.PI);
  assert.equal(angleDelta(1, 1), 0);
});

test('the guide stands in front of the player, not behind them', () => {
  const follow = new FollowController();
  follow.reset(0);
  // Yaw 0 looks down -z, so "in front" is a smaller z than the player's.
  const mark = follow.markFor(at(0, 0), 'idle');
  assert.ok(mark.z < -1, `expected the mark ahead of the player, got z=${mark.z}`);
  assert.ok(Math.abs(mark.x) > 0.5, 'and off to one side, not dead centre');
  // The camera's 60 degrees are vertical, so the horizontal half-field is 37
  // degrees even on a 4:3 window. Inside that, and clear of the crosshair.
  const offCentre = Math.abs(Math.atan2(mark.x, -mark.z));
  assert.ok(offCentre < 0.64, `the mark must stay in frame, sits ${(offCentre * 180 / Math.PI).toFixed(1)} deg off centre`);
  assert.ok(offCentre > 0.2, 'and clear of the crosshair, which evidence mode reads through');
});

test('the mark turns with the player, so the guide stays in shot', () => {
  const follow = new FollowController();
  follow.reset(Math.PI / 2); // looking down -x
  const mark = follow.markFor(at(0, 0), 'idle');
  assert.ok(mark.x < -1, `expected the mark to follow the heading, got x=${mark.x}`);
});

test('the guide accepts the options the viewer actually hands it', () => {
  // Regression: FollowController validated every value in the merged options
  // object, and the viewer passes the guide a radiusLimit and an AbortSignal
  // alongside the follow settings. Number.isFinite(anAbortSignal) is false, so
  // every guide in a real world failed to construct with "Invalid follow
  // configuration" while every test here, passing follow options alone, passed.
  const fromViewer = { radiusLimit: 0, signal: new AbortController().signal, height: 1.74, clipSlug: 'guide' };
  const follow = new FollowController(fromViewer);
  assert.equal(follow.options.ahead, 1.85, 'and the stray keys must not disturb the real ones');
  // The same shape, all the way through the guide.
  const companion = guide(floor(), fromViewer);
  assert.equal(companion.spawn(new Vector3(0, 1.65, 0), 0), true);
  companion.update(1 / 60, new Vector3(0, 1.65, 0), 0);
  // Genuine follow options still get through.
  assert.equal(new FollowController({ ...fromViewer, ahead: 3 }).options.ahead, 3);
  // And a genuinely bad one is still rejected.
  assert.throws(() => new FollowController({ ...fromViewer, arrive: -1 }), /Invalid follow configuration/);
});

test('a guide that has arrived holds still and faces the player', () => {
  const follow = new FollowController();
  follow.reset(0);
  const player = at(0, 0);
  const result = walk(follow, player, 0, at(6, 6));
  assert.equal(result.holding, true, 'it should settle rather than orbit its mark');
  assert.ok(Math.hypot(result.move.x, result.move.z) === 0);
  // Facing is atan2(x, z) towards the player, and the guide is ahead of them.
  const towards = Math.atan2(player.x - result.guide.x, player.z - result.guide.z);
  assert.ok(Math.abs(angleDelta(result.facing, towards)) < 0.25, 'it should be looking at you');
});

test('the guide walks rather than standing in your face', () => {
  const follow = new FollowController();
  follow.reset(0);
  const settled = walk(follow, at(0, 0), 0, at(0, 0)).guide;
  const distance = Math.hypot(settled.x, settled.z);
  assert.ok(distance > 1.2 && distance < 3, `expected a conversational distance, got ${distance.toFixed(2)} m`);
});

test('a guide making no progress tries the other shoulder, then asks to be moved', () => {
  const follow = new FollowController({ stuckAfter: 0.5 });
  follow.reset(0);
  const pinned = at(4, 4);
  let side = null;
  let recovered = false;
  for (let t = 0; t < 4; t += 1 / 60) {
    const step = follow.step(1 / 60, at(0, 0), 0, pinned, 'idle');
    if (side === null) side = Math.sign(step.mark.x);
    if (Math.sign(step.mark.x) !== side) side = 'flipped';
    if (step.recover) { recovered = true; break; }
  }
  assert.equal(side, 'flipped', 'it should have tried the other side first');
  assert.equal(recovered, true, 'and given up rather than scraping the wall for ever');
});

test('a guide left far behind asks to be put back', () => {
  const follow = new FollowController();
  follow.reset(0);
  const step = follow.step(1 / 60, at(0, 0), 0, at(40, 40), 'idle');
  assert.equal(step.recover, true);
});

test('being spoken to brings the guide round to face you', () => {
  const idle = new FollowController();
  idle.reset(0);
  const engaged = new FollowController();
  engaged.reset(0);
  const apart = Math.hypot(...Object.values(idle.markFor(at(0, 0), 'idle')));
  const close = Math.hypot(...Object.values(engaged.markFor(at(0, 0), 'speaking')));
  assert.ok(close < apart, 'it should close the gap when it is talking to you');
});

test('every pose points its limbs somewhere real', () => {
  const poses = [standing(), idlePose(0), idlePose(3.7), walkPose(0), walkPose(0.25), walkPose(0.5, 1), walkPose(0.83, 0.4)];
  for (const pose of poses) {
    for (const channel of AIM_CHANNELS) {
      const v = pose[channel];
      assert.ok(v, `${channel} is missing`);
      assert.ok(Math.abs(Math.hypot(v.x, v.y, v.z) - 1) < 1e-9, `${channel} is not a direction`);
      assert.ok(Number.isFinite(v.x + v.y + v.z));
    }
    assert.ok(Math.abs(pose.bob) < 0.1, 'the body should not pogo');
  }
});

test('the walk cycle closes, and never plants a foot in the air', () => {
  const start = walkPose(0), end = walkPose(1);
  for (const channel of AIM_CHANNELS) {
    assert.ok(Math.abs(start[channel].y - end[channel].y) < 1e-9, `${channel} does not come back round`);
  }
  for (let phase = 0; phase < 1; phase += 1 / 32) {
    const pose = walkPose(phase);
    // The shins hang below the hips and the toes never point at the sky.
    assert.ok(pose.leftLeg.y < 0 && pose.rightLeg.y < 0, `a shin points upwards at phase ${phase.toFixed(2)}`);
    assert.ok(pose.leftFoot.y < 0.35 && pose.rightFoot.y < 0.35, `a toe points at the sky at phase ${phase.toFixed(2)}`);
    // Legs alternate: they are never both forward at once.
    assert.ok(pose.leftUpLeg.z * pose.rightUpLeg.z <= 1e-9, `both legs lead at phase ${phase.toFixed(2)}`);
  }
});

test('blending a partial pose leaves the untouched channels alone', () => {
  const base = standing();
  const mixed = blend(base, { rightArm: aim(1, 0, 0) }, 1);
  assert.deepEqual(mixed.leftArm, base.leftArm);
  assert.ok(Math.abs(mixed.rightArm.x - 1) < 1e-9);
  const half = blend(base, { rightArm: aim(1, 0, 0) }, 0.5);
  assert.ok(half.rightArm.x > base.rightArm.x && half.rightArm.x < 1, 'half way should be half way');
  assert.deepEqual(blend(base, { rightArm: aim(1, 0, 0) }, 0), base);
});

test('gestures fade in, fade out and do not repeat back to back', () => {
  let seed = 0.17;
  const director = new GestureDirector(() => (seed = (seed * 9301 + 49297) % 233280 / 233280));
  director.setMood('speaking');
  const played = [];
  let peak = 0;
  let sawZero = false;
  for (let t = 0; t < 40; t += 1 / 60) {
    const before = director.playing;
    const frame = director.update(1 / 60);
    if (director.playing && director.playing !== before) played.push(director.playing);
    if (frame) {
      assert.ok(frame.weight >= 0 && frame.weight <= 1, 'a gesture weight has to be a blend factor');
      peak = Math.max(peak, frame.weight);
    } else if (played.length) sawZero = true;
  }
  assert.ok(played.length >= 5, `expected talking hands, got ${played.length} gestures in 40 s`);
  assert.ok(peak > 0.95, 'gestures should reach full strength');
  assert.ok(sawZero, 'and let go again between them');
  for (let i = 1; i < played.length; i++) assert.notEqual(played[i], played[i - 1], 'two of the same in a row reads as a loop');
});

test('an idle guide waves now and then, but does not pester you', () => {
  const director = new GestureDirector(() => 0.5);
  let gestures = 0;
  let previous = null;
  for (let t = 0; t < 120; t += 1 / 30) {
    director.update(1 / 30);
    if (director.playing && director.playing !== previous) gestures++;
    previous = director.playing;
  }
  assert.ok(gestures >= 1, 'it should acknowledge you eventually');
  assert.ok(gestures <= 6, `once in a while, not ${gestures} times in two minutes`);
});

test('a brisker tempo means busier hands', () => {
  const count = (tempo) => {
    const director = new GestureDirector(() => 0.5, tempo);
    director.setMood('speaking');
    let gestures = 0, previous = null;
    for (let t = 0; t < 20; t += 1 / 60) {
      director.update(1 / 60);
      if (director.playing && director.playing !== previous) gestures++;
      previous = director.playing;
    }
    return gestures;
  };
  const written = count(1), brisk = count(2);
  assert.ok(brisk > written * 1.5, `a doubled tempo should roughly double the hands, got ${written} -> ${brisk}`);
});

test('a talking mouth opens, shuts, and does not visibly loop', () => {
  let low = 1, high = 0;
  for (let t = 0; t < 8; t += 1 / 120) {
    const v = speechEnvelope(t);
    assert.ok(v >= 0 && v <= 1, `the level has to be a blend factor, got ${v}`);
    low = Math.min(low, v);
    high = Math.max(high, v);
  }
  assert.ok(high > 0.85, `it should open properly, peaked at ${high.toFixed(2)}`);
  assert.ok(low < 0.05, `and shut between words, floor was ${low.toFixed(2)}`);
  // A second later should rarely look the same, or the jaw reads as a metronome.
  let drift = 0, n = 0;
  for (let t = 0; t < 8; t += 1 / 60) { drift += Math.abs(speechEnvelope(t) - speechEnvelope(t + 1)); n++; }
  assert.ok(drift / n > 0.15, `too close to a one-second loop (mean drift ${(drift / n).toFixed(3)})`);
});

function face(names) {
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  mesh.morphTargetDictionary = Object.fromEntries(names.map((n, i) => [n, i]));
  mesh.morphTargetInfluences = names.map(() => 0);
  return mesh;
}

test('the mouth drives whatever blend shapes the avatar shipped with', () => {
  const avatar = new Group();
  // ARKit and Oculus names mixed, plus one that is nothing to do with talking.
  const mesh = face(['jawOpen', 'viseme_I', 'viseme_O', 'browInnerUp']);
  avatar.add(mesh);
  const mouth = new Mouth(avatar, null);
  assert.equal(mouth.usable, true);

  mouth.update(1, 0);
  const [open, , , brow] = mesh.morphTargetInfluences;
  assert.ok(open > 0.5 && open < 1, `the jaw should open, but never all the way: ${open}`);
  assert.equal(brow, 0, 'and nothing outside the mouth should be touched');

  // Wide and rounded trade places as it speaks, or it reads as chewing.
  mouth.update(1, 0.147); // vowel peak
  const wideThen = mesh.morphTargetInfluences[1], roundThen = mesh.morphTargetInfluences[2];
  mouth.update(1, 0.441); // vowel trough
  assert.ok(mesh.morphTargetInfluences[1] < wideThen, 'the wide shape should ease off');
  assert.ok(mesh.morphTargetInfluences[2] > roundThen, 'as the rounded one comes in');

  mouth.close();
  assert.deepEqual(mesh.morphTargetInfluences, [0, 0, 0, 0]);
});

test('a rig with a jaw bone and no blend shapes hinges the jaw instead', () => {
  const root = skeleton();
  const rig = new Rig(root);
  const mouth = new Mouth(root, rig);
  assert.equal(mouth.usable, true);
  const jaw = root.getObjectByName('mixamorig:Jaw');
  const shut = jaw.quaternion.clone();
  mouth.update(1, 0, new Quaternion());
  assert.ok(jaw.quaternion.angleTo(shut) > 0.1, 'the jaw should have opened');
  mouth.close(new Quaternion());
  assert.ok(jaw.quaternion.angleTo(shut) < 1e-9, 'and shut again exactly');
});

test('an avatar with no mouth keeps it shut rather than failing', () => {
  const mouth = new Mouth(new Group(), null);
  assert.equal(mouth.usable, false);
  assert.match(mouth.found, /no mouth/);
  mouth.update(1, 0, new Quaternion());
});

test('bone names are recognised whatever the exporter called them', () => {
  assert.equal(canonicalBone('mixamorig:Hips'), 'Hips');
  assert.equal(canonicalBone('mixamorig9:LeftForeArm'), 'LeftForeArm');
  assert.equal(canonicalBone('mixamorigLeftArm'), 'LeftArm');
  assert.equal(canonicalBone('Hips'), 'Hips');
  assert.equal(canonicalBone('LeftUpperArm'), 'LeftArm');
  assert.equal(canonicalBone('HeadTop_End'), 'HeadTop_End');
  assert.equal(canonicalBone('Wing_L'), null);
  // GLTFLoader strips the colon out of node names before clips ever see them.
  assert.equal(key('mixamorigHips'), key('mixamorig:Hips'));
});

/** A humanoid in a T-pose, named the way a Mixamo export names things. */
function skeleton() {
  const root = new Object3D();
  root.name = 'Armature';
  const add = (name, position, parent) => {
    const bone = new Bone();
    bone.name = name;
    bone.position.set(...position);
    parent.add(bone);
    return bone;
  };
  const hips = add('mixamorig:Hips', [0, 1, 0], root);
  const spine = add('mixamorig:Spine', [0, 0.14, 0], hips);
  const spine1 = add('mixamorig:Spine1', [0, 0.16, 0], spine);
  const spine2 = add('mixamorig:Spine2', [0, 0.16, 0], spine1);
  const neck = add('mixamorig:Neck', [0, 0.16, 0], spine2);
  const head = add('mixamorig:Head', [0, 0.1, 0], neck);
  add('mixamorig:HeadTop_End', [0, 0.18, 0], head);
  add('mixamorig:Jaw', [0, 0.02, 0.03], head);
  for (const [side, sign] of [['Left', 1], ['Right', -1]]) {
    const shoulder = add(`mixamorig:${side}Shoulder`, [sign * 0.05, 0.1, 0], spine2);
    const arm = add(`mixamorig:${side}Arm`, [sign * 0.12, 0, 0], shoulder);
    const fore = add(`mixamorig:${side}ForeArm`, [sign * 0.28, 0, 0], arm);
    add(`mixamorig:${side}Hand`, [sign * 0.26, 0, 0], fore);
    const upLeg = add(`mixamorig:${side}UpLeg`, [sign * 0.09, -0.06, 0], hips);
    const leg = add(`mixamorig:${side}Leg`, [0, -0.42, 0], upLeg);
    const foot = add(`mixamorig:${side}Foot`, [0, -0.41, 0], leg);
    add(`mixamorig:${side}ToeBase`, [0, -0.07, 0.14], foot);
  }
  root.updateMatrixWorld(true);
  return root;
}

/** Where a bone actually points, in world space, after posing. */
function direction(root, boneName, childName) {
  root.updateMatrixWorld(true);
  const from = new Vector3(), to = new Vector3();
  root.getObjectByName(boneName).getWorldPosition(from);
  root.getObjectByName(childName).getWorldPosition(to);
  return to.sub(from).normalize();
}

test('the rig points a limb where the pose asks, whatever its rest axis was', () => {
  const root = skeleton();
  const rig = new Rig(root);
  assert.equal(rig.usable, true);
  assert.ok(rig.found.aimable.includes('LeftArm') && rig.found.aimable.includes('LeftFoot'));

  const pose = standing();
  rig.apply(pose, new Quaternion());
  // The arms start out along x in the T-pose and have to end up hanging.
  const arm = direction(root, 'mixamorig:LeftArm', 'mixamorig:LeftForeArm');
  assert.ok(Math.abs(arm.x - pose.leftArm.x) < 1e-6 && Math.abs(arm.y - pose.leftArm.y) < 1e-6 && Math.abs(arm.z - pose.leftArm.z) < 1e-6,
    `left arm points (${arm.x.toFixed(3)}, ${arm.y.toFixed(3)}, ${arm.z.toFixed(3)})`);
  // The legs start out along -y, so their aim is nearly a no-op: a different
  // rest axis, the same answer.
  const shin = direction(root, 'mixamorig:LeftLeg', 'mixamorig:LeftFoot');
  assert.ok(Math.abs(shin.y - pose.leftLeg.y) < 1e-6);
  // The foot's rest axis is forward and down, a third starting point again.
  const foot = direction(root, 'mixamorig:LeftFoot', 'mixamorig:LeftToeBase');
  assert.ok(Math.abs(foot.z - pose.leftFoot.z) < 1e-6);
});

test('the rig aims in the avatar\'s own frame, so a turned guide still hangs its arms down', () => {
  const root = skeleton();
  const rig = new Rig(root);
  const facing = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
  root.quaternion.copy(facing);
  rig.apply(standing(), facing);
  const arm = direction(root, 'mixamorig:LeftArm', 'mixamorig:LeftForeArm');
  assert.ok(arm.y < -0.9, `a turned guide should still hang its arms down, got y=${arm.y.toFixed(3)}`);
  // A quarter turn to the left puts the avatar's own -x — the side its left
  // arm splays towards — along the world's +z.
  assert.ok(arm.z > 0.1 && Math.abs(arm.x) < 0.1,
    `expected the splay to turn with the avatar, got (${arm.x.toFixed(3)}, ${arm.y.toFixed(3)}, ${arm.z.toFixed(3)})`);
});

test('an overlay eases towards the gesture instead of snapping to it', () => {
  const root = skeleton();
  const rig = new Rig(root);
  const rest = new Quaternion();
  rig.apply(standing(), rest);
  const hanging = direction(root, 'mixamorig:RightArm', 'mixamorig:RightForeArm');
  const raised = aim(0.58, 0.74, 0.28);

  rig.apply(standing(), rest);
  rig.applyOverlay({ rightArm: raised }, 0, rest);
  const none = direction(root, 'mixamorig:RightArm', 'mixamorig:RightForeArm');
  assert.ok(Math.abs(none.y - hanging.y) < 1e-6, 'weight 0 must change nothing');

  rig.apply(standing(), rest);
  rig.applyOverlay({ rightArm: raised }, 0.5, rest);
  const half = direction(root, 'mixamorig:RightArm', 'mixamorig:RightForeArm');
  assert.ok(half.y > hanging.y + 0.2 && half.y < raised.y - 0.1, `half way up, got y=${half.y.toFixed(3)}`);

  rig.apply(standing(), rest);
  rig.applyOverlay({ rightArm: raised }, 1, rest);
  const full = direction(root, 'mixamorig:RightArm', 'mixamorig:RightForeArm');
  assert.ok(Math.abs(full.y - raised.y) < 1e-6, 'weight 1 must arrive');
});

test('a twisted torso does not drag the arms off the pose', () => {
  // Regression: the spine twist used to be applied after the arms had been
  // aimed, so it silently rotated them off the directions they were given.
  const root = skeleton();
  const rig = new Rig(root);
  const rest = new Quaternion();
  const pose = standing();
  pose.spineTwist = 0.5;
  rig.apply(pose, rest);
  const arm = direction(root, 'mixamorig:LeftArm', 'mixamorig:LeftForeArm');
  assert.ok(Math.abs(arm.x - pose.leftArm.x) < 1e-6 && Math.abs(arm.z - pose.leftArm.z) < 1e-6,
    `the arm should still point where it was aimed, got (${arm.x.toFixed(3)}, ${arm.y.toFixed(3)}, ${arm.z.toFixed(3)})`);
  // And the twist still has to reach the chest, which the arms hang off.
  root.updateMatrixWorld(true);
  const chest = new Vector3(), neck = new Vector3(), shoulder = new Vector3();
  root.getObjectByName('mixamorig:Spine2').getWorldPosition(chest);
  root.getObjectByName('mixamorig:Neck').getWorldPosition(neck);
  root.getObjectByName('mixamorig:LeftShoulder').getWorldPosition(shoulder);
  assert.ok(Math.abs(shoulder.z - chest.z) > 0.005 || Math.abs(shoulder.x - chest.x) < 0.049,
    'the shoulders should have turned with the torso');
  assert.ok(neck.y > chest.y, 'and the spine should still be the right way up');
});

test('restore puts a posed skeleton back in its T-pose', () => {
  const root = skeleton();
  const rig = new Rig(root);
  const before = direction(root, 'mixamorig:LeftArm', 'mixamorig:LeftForeArm').clone();
  rig.apply(walkPose(0.3), new Quaternion());
  rig.restore();
  const after = direction(root, 'mixamorig:LeftArm', 'mixamorig:LeftForeArm');
  assert.ok(after.distanceTo(before) < 1e-9);
});

test('donor clips are rebound onto the avatar\'s own bone names', () => {
  const root = skeleton();
  const rig = new Rig(root);
  const clip = new AnimationClip('walk', 1, [
    // A Mixamo export, sanitised by GLTFLoader: no colon, bare prefix.
    new QuaternionKeyframeTrack('mixamorigLeftArm.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
    new QuaternionKeyframeTrack('mixamorigTail.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
    new VectorKeyframeTrack('mixamorigHips.position', [0, 1], [0, 0, 0, 0, 1, 0]),
  ]);
  const [rebound] = retarget([clip], rig);
  assert.deepEqual(rebound.tracks.map((t) => t.name), ['mixamorig:LeftArm.quaternion'],
    'rotation only, onto this skeleton\'s names, and nothing that has nowhere to go');
});

// ---------------------------------------------------------------------------
// The guide on its feet: the same capsule controller the player walks with,
// driven by the follow steering rather than by keys.
// ---------------------------------------------------------------------------

function floor({ wall = false } = {}) {
  const root = new Group();
  const add = (size, position) => {
    const mesh = new Mesh(new BoxGeometry(...size), new MeshBasicMaterial());
    mesh.position.set(...position);
    root.add(mesh);
  };
  add([60, 1, 60], [0, -0.5, 0]);
  if (wall) add([0.4, 4, 24], [3, 2, 0]);
  return new CollisionTree().fromGraphNode(root);
}

function guide(tree, options = {}) {
  const avatar = skeleton();
  const root = new Group();
  root.add(avatar);
  const model = { root, avatar, rigs: [new Rig(avatar)], height: 1.74, clips: null, dispose() { root.removeFromParent(); } };
  return new Companion(model, 'Test guide', tree, options);
}

test('the guide spawns on the floor, beside the player, facing them', () => {
  const companion = guide(floor());
  assert.equal(companion.spawn(new Vector3(0, 1.65, 0), 0), true);
  assert.equal(companion.ready, true);
  assert.ok(Math.abs(companion.root.position.y) < 0.02, `feet should be on the floor, got y=${companion.root.position.y}`);
  const apart = Math.hypot(companion.root.position.x, companion.root.position.z);
  assert.ok(apart > 1 && apart < 3, `expected arm's length away, got ${apart.toFixed(2)} m`);
  // atan2(x, z) towards the player at the origin.
  const towards = Math.atan2(-companion.root.position.x, -companion.root.position.z);
  assert.ok(Math.abs(angleDelta(companion.root.rotation.y, towards)) < 0.2, 'it should already be looking at you');
});

test('the guide keeps up with a player walking away, and stays on the floor', () => {
  const companion = guide(floor());
  const eye = new Vector3(0, 1.65, 0);
  companion.spawn(eye, 0);
  let worst = 0;
  // Walk forward for eight seconds at the player's own 1.6 m/s.
  for (let t = 0; t < 8; t += 1 / 60) {
    eye.z -= 1.6 / 60;
    companion.update(1 / 60, eye, 0);
    assert.ok(Math.abs(companion.root.position.y) < 0.06, `the guide left the floor at t=${t.toFixed(2)} (y=${companion.root.position.y.toFixed(3)})`);
    worst = Math.max(worst, Math.hypot(companion.root.position.x - eye.x, companion.root.position.z - eye.z));
  }
  assert.ok(worst < 4, `the guide fell ${worst.toFixed(2)} m behind`);
  const gap = Math.hypot(companion.root.position.x - eye.x, companion.root.position.z - eye.z);
  assert.ok(gap > 0.8, 'and did not end up standing inside you');
});

test('the guide walks: a moving guide moves its legs', () => {
  const companion = guide(floor());
  const eye = new Vector3(0, 1.65, 0);
  companion.spawn(eye, 0);
  const knee = companion.model.avatar.getObjectByName('mixamorig:LeftLeg');
  const seen = new Set();
  for (let t = 0; t < 4; t += 1 / 60) {
    eye.z -= 2.2 / 60;
    companion.update(1 / 60, eye, 0);
    seen.add(knee.quaternion.x.toFixed(3));
  }
  assert.ok(seen.size > 12, `the walk cycle should be running, saw ${seen.size} distinct knee angles`);
});

test('a guide that cannot reach its mark is put back beside the player', () => {
  const companion = guide(floor({ wall: true }), { stuckAfter: 0.4 });
  // Player on one side of the wall, guide dropped on the other.
  const eye = new Vector3(-2, 1.65, 0);
  companion.spawn(eye, 0);
  companion.root.position.set(8, 0, 0);
  for (let t = 0; t < 12; t += 1 / 60) companion.update(1 / 60, eye, 0);
  const gap = Math.hypot(companion.root.position.x - eye.x, companion.root.position.z - eye.z);
  assert.ok(gap < 4, `expected the guide back beside the player, it is ${gap.toFixed(2)} m away`);
  assert.ok(companion.root.position.x < 3, 'and on the player\'s side of the wall');
});

test('speaking to the guide for the first time gets a wave', () => {
  const companion = guide(floor());
  companion.spawn(new Vector3(0, 1.65, 0), 0);
  assert.equal(companion.gesture, null);
  companion.setMood('speaking');
  assert.equal(companion.gesture, 'wave', 'it should say hello the first time you speak to it');

  // Only the first time. Asserted on the mechanism rather than on what the
  // director happens to be playing: waving is in the speaking repertoire, so a
  // later wave is a perfectly ordinary draw and proves nothing either way.
  // Setting a mood never starts a gesture by itself; only the greeting does.
  const eye = new Vector3(0, 1.65, 0);
  companion.setMood('idle');
  for (let frame = 0; companion.gesture && frame < 6000; frame++) companion.update(1 / 60, eye, 0);
  assert.equal(companion.gesture, null, 'the greeting should have run its course');
  companion.setMood('speaking');
  assert.equal(companion.gesture, null, 'and a later mood change must not open with another one');
});

test('a guide with nowhere to stand reports it rather than floating', () => {
  const companion = guide(floorless());
  assert.equal(companion.spawn(new Vector3(0, 40, 0), 0), false);
  assert.equal(companion.ready, false);
  // Updating a guide that never landed must be a no-op, not a crash.
  companion.update(1 / 60, new Vector3(0, 40, 0), 0);
});

/** A collision mesh with a floor far below the player, and nothing under them. */
function floorless() {
  const root = new Group();
  const mesh = new Mesh(new BoxGeometry(4, 1, 4), new MeshBasicMaterial());
  mesh.position.set(400, -0.5, 400);
  root.add(mesh);
  return new CollisionTree().fromGraphNode(root);
}
