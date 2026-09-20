import assert from 'node:assert/strict';
import { BoxGeometry, Group, Matrix4, Mesh, MeshBasicMaterial, Vector3 } from 'three';
import { Octree } from 'three/addons/math/Octree.js';
import { WalkingMotor } from '../src/viewer/walking.ts';
import { colliderRoot } from '../src/viewer/collider.ts';
import { CollisionTree } from '../src/viewer/collision-tree.ts';
import { FirstPersonControls } from '../src/viewer/controls.ts';
import { PerspectiveCamera } from 'three';

const forward = new Vector3(0, 0, -1);
const still = new Vector3();
function box(root, size, position, rotation = [0, 0, 0]) {
  const mesh = new Mesh(new BoxGeometry(...size), new MeshBasicMaterial());
  mesh.position.set(...position);
  mesh.rotation.set(...rotation);
  root.add(mesh);
  return mesh;
}
function scene({ floor = true } = {}) {
  const root = new Group();
  if (floor) box(root, [60, 1, 60], [0, -0.5, 0]);
  return root;
}
function motor(root, eye = [0, 1.65, 0], options = {}) {
  const result = new WalkingMotor(root ? new CollisionTree().fromGraphNode(root) : null, options);
  assert.ok(result.spawn(new Vector3(...eye)), 'safe spawn exists');
  return result;
}
function advance(m, direction, seconds, sprint = false, hz = 60) {
  for (let i = 0; i < Math.round(seconds * hz); i++) m.update(1 / hz, direction, sprint);
}
function near(value, expected, tolerance, message) {
  assert.ok(Math.abs(value - expected) < tolerance, `${message}: ${value} vs ${expected}`);
}
function test(name, run) { run(); console.log(`✓ ${name}`); }

test('flat fallback holds eye height; no flight from vertical input', () => {
  const m = motor(null);
  advance(m, new Vector3(0, 10, -1), 3);
  near(m.eye.y, 1.652, 0.005, 'eye height');
  assert.ok(m.eye.z < -4 && m.grounded);
});
test('grounded movement, sprint, diagonal normalization, frame-rate independence', () => {
  const walk = motor(scene()), sprint = motor(scene()), diagonal = motor(scene());
  advance(walk, forward, 2);
  advance(sprint, forward, 2, true);
  advance(diagonal, new Vector3(1, 0, -1), 2);
  near(walk.eye.y, 1.65, 0.02, 'grounded eye');
  assert.ok(sprint.eye.z < walk.eye.z * 2.3, 'sprint is faster');
  near(Math.hypot(diagonal.eye.x, diagonal.eye.z), -walk.eye.z, 0.03, 'diagonal speed');
  const low = motor(scene()), high = motor(scene());
  advance(low, forward, 3, false, 30); advance(high, forward, 3, false, 144);
  near(low.eye.distanceTo(high.eye), 0, 0.02, 'fixed timestep');
  advance(walk, still, 1);
  assert.ok(Math.abs(walk.velocity.z) < 0.001, 'release brakes the player');
});
test('walls stop sprinting; diagonal input slides along the wall', () => {
  const root = scene(); box(root, [10, 5, 0.1], [0, 2.5, -2]);
  const m = motor(root);
  advance(m, forward, 3, true);
  assert.ok(m.eye.z > -1.7 && m.eye.z < -1.5, `wall stopped at ${m.eye.z}`);
  advance(m, new Vector3(1, 0, -1), 1);
  assert.ok(m.eye.x > 0.8 && m.eye.z > -1.7, 'wall slide');
});
test('corners prevent penetration at low frame rates', () => {
  const root = scene();
  box(root, [10, 4, 0.05], [0, 2, -2]);
  box(root, [0.05, 4, 10], [2, 2, 0]);
  const m = motor(root);
  advance(m, new Vector3(1, 0, -1), 3, true, 10);
  assert.ok(m.eye.x < 1.72 && m.eye.z > -1.72);
});
test('low stairs can be climbed and descended', () => {
  const root = scene();
  for (let i = 0; i < 5; i++) box(root, [3, 0.2 * (i + 1), 0.7], [0, 0.1 * (i + 1), -1.35 - i * 0.7]);
  const m = motor(root);
  advance(m, forward, 2.3);
  assert.ok(m.feetY > 0.78, `climbed stairs: feet=${m.feetY}, z=${m.eye.z}`);
  advance(m, new Vector3(0, 0, 1), 2.5);
  near(m.feetY, 0, 0.02, 'returned to ground');
});
test('high steps cannot be climbed', () => {
  const root = scene(); box(root, [4, 1, 4], [0, 0.5, -3]);
  const m = motor(root);
  advance(m, forward, 3);
  assert.ok(m.eye.z > -0.75 && m.feetY < 0.1, `blocked high step: ${m.eye.toArray()}`);
});
test('walkable ramp ascends; steep ramp blocks ascent', () => {
  const makeRamp = angle => {
    const root = scene();
    box(root, [4, 0.15, 8], [0, Math.sin(angle) * 4, -5], [angle, 0, 0]);
    return motor(root);
  };
  const gentle = makeRamp(Math.PI / 8);
  advance(gentle, forward, 3);
  assert.ok(gentle.feetY > 0.7, `ramp climbed: ${gentle.eye.toArray()}`);
  const steep = makeRamp(Math.PI / 3);
  advance(steep, forward, 6);
  assert.ok(steep.feetY < 0.35, `steep blocked: ${steep.eye.toArray()}`);
});
test('walking off a ledge falls and lands on the lower floor', () => {
  const root = scene(); box(root, [3, 2, 3], [0, 1, 0]);
  const m = motor(root, [0, 3.65, 0]);
  advance(m, forward, 1.2);
  assert.ok(m.feetY < 1.99 && m.feetY > 0.1, `falling: ${m.feetY}`);
  advance(m, forward, 1);
  near(m.feetY, 0, 0.02, 'landed');
  assert.ok(m.grounded);
});
test('ceiling prevents entering a passage shorter than the player', () => {
  const root = scene(); box(root, [4, 1, 4], [0, 1.95, -3]);
  const m = motor(root);
  advance(m, forward, 3);
  assert.ok(m.eye.z > -0.8, `ceiling blocked: ${m.eye.toArray()}`);
});
test('falling out of a world resets safely; explicit reset stops all motion', () => {
  const root = scene({ floor: false }); box(root, [3, 1, 3], [0, -0.5, 0]);
  const m = motor(root);
  advance(m, forward, 2);
  advance(m, still, 4);
  near(m.eye.distanceTo(new Vector3(0, 1.652, 0)), 0, 0.02, 'recovered to spawn');
  advance(m, forward, 0.5);
  m.reset();
  assert.equal(m.velocity.length(), 0);
  near(m.eye.z, 0, 0.001, 'reset position');
});
test('safe spawn searches around an obstruction and rejects absent floors', () => {
  const root = scene(); box(root, [0.6, 4, 0.6], [0, 2, 0]);
  const m = motor(root);
  assert.ok(Math.hypot(m.eye.x, m.eye.z) > 0.5, 'spawn moved clear of obstruction');
  const empty = new WalkingMotor(new Octree());
  assert.equal(empty.spawn(new Vector3(0, 1.65, 0)), false);
});
test('walk radius bounds horizontal travel without changing height', () => {
  const m = motor(scene(), [0, 1.65, 0], { radiusLimit: 2 });
  advance(m, forward, 5, true);
  near(m.eye.z, -2, 0.01, 'radius');
  near(m.eye.y, 1.65, 0.02, 'height');
});
test('collider receives the declared splat transform exactly once', () => {
  const mesh = new Group();
  const matrix = new Matrix4().makeRotationX(Math.PI).multiply(new Matrix4().makeTranslation(0, -1, 0)).multiply(new Matrix4().makeScale(2, 2, 2));
  colliderRoot(mesh, { url: 'test.glb', space: 'splat' }, matrix);
  near(mesh.localToWorld(new Vector3(0, 2, 1)).distanceTo(new Vector3(0, -3, -2)), 0, 1e-8, 'raw transform');
  const world = new Group();
  colliderRoot(world, { url: 'test.glb', space: 'world' }, matrix);
  near(world.localToWorld(new Vector3(0, 2, 1)).distanceTo(new Vector3(0, 2, 1)), 0, 1e-8, 'world transform');
});

test('real keyboard input: Shift sprints, E never flies, blur releases movement, listeners dispose', () => {
  const oldDocument = globalThis.document, oldWindow = globalThis.window;
  const oldGetGamepads = globalThis.navigator.getGamepads;
  const document = new EventTarget(), window = new EventTarget(), canvas = new EventTarget();
  canvas.style = {};
  canvas.getBoundingClientRect = () => ({ left: 0, right: 1000, width: 1000, top: 0, bottom: 800, height: 800 });
  globalThis.document = document; globalThis.window = window;
  globalThis.navigator.getGamepads = () => [];
  const camera = new PerspectiveCamera();
  const c = new FirstPersonControls(canvas, camera);
  const m = motor(null);
  c.setMotor(m);
  let pauseRequests = 0, resumeRequests = 0, quietUnlocks = 0;
  // Mirror WorldCanvas: a pause request pauses the controller.
  c.onPauseRequest = () => { pauseRequests++; c.setPaused(true); };
  c.onResumeRequest = () => { resumeRequests++; c.setPaused(false); };
  c.onQuietUnlock = () => { quietUnlocks++; };
  const pointer = (type, values = {}) => {
    const event = new Event(type);
    for (const [key, value] of Object.entries(values)) Object.defineProperty(event, key, { value });
    canvas.dispatchEvent(event);
  };
  const key = (code, type = 'keydown') => { const event = new Event(type); Object.defineProperty(event, 'code', { value: code }); document.dispatchEvent(event); };
  try {
    // Pointer lock, stubbed the way the browser drives it: the request and the
    // release both report back through pointerlockchange rather than returning.
    const LIMIT = (89 * Math.PI) / 180;
    let lockRequests = 0;
    canvas.requestPointerLock = () => {
      lockRequests += 1;
      document.pointerLockElement = canvas;
      document.dispatchEvent(new Event('pointerlockchange'));
    };
    document.exitPointerLock = () => {
      document.pointerLockElement = null;
      document.dispatchEvent(new Event('pointerlockchange'));
    };
    const mouse = (movementX, movementY) => {
      const event = new Event('mousemove');
      Object.defineProperty(event, 'movementX', { value: movementX });
      Object.defineProperty(event, 'movementY', { value: movementY });
      document.dispatchEvent(event);
    };
    const frames = (n) => { for (let i = 0; i < n; i++) c.update(1 / 60); };

    // Nothing looks until the viewport has been clicked.
    const before = c.yaw;
    mouse(200, 0);
    assert.equal(c.yaw, before, 'an unlocked mouse does not move the camera');
    assert.equal(c.locked, false);

    // Clicking the viewport captures the cursor.
    pointer('pointerdown', { button: 0, pointerType: 'mouse', clientX: 500, clientY: 400, pointerId: 1 });
    assert.equal(lockRequests, 1, 'clicking the viewport asks for pointer lock');
    assert.equal(c.locked, true, 'and the browser granting it is what makes us locked');

    // Raw deltas, applied exactly: no smoothing, no acceleration, no curve.
    near(c.sensitivity, 2.5, 1e-12, 'a fresh controller starts at the default sensitivity');
    c.setSensitivity(1);
    c.yaw = 0; c.pitch = 0;
    mouse(100, 0);
    near(c.yaw, -100 * 0.0025, 1e-12, 'yaw is the delta times lookSpeed, to the pixel');
    mouse(100, 0);
    near(c.yaw, -200 * 0.0025, 1e-12, 'and the second hundred pixels turn exactly as far as the first');
    mouse(0, 100);
    near(c.pitch, -100 * 0.0025, 1e-12, 'pitch likewise');
    // Movement arrives on the event, not spread over frames afterwards.
    const applied = c.yaw;
    frames(120);
    near(c.yaw, applied, 1e-12, 'nothing is left over to ease out after the event');

    // No auto-turn of any kind: a still mouse is a still camera, forever.
    c.yaw = 0; c.pitch = 0;
    frames(600);
    assert.equal(c.yaw, 0, 'ten seconds of frames with no input do not turn the view');
    assert.equal(c.pitch, 0, 'in either axis');

    // Yaw is unbounded — pointer lock has no window to run out of.
    c.yaw = 0;
    for (let i = 0; i < 40; i++) mouse(-100, 0);
    assert.ok(c.yaw > Math.PI * 2, 'yaw passes a full circle and keeps going');
    for (let i = 0; i < 80; i++) mouse(-100, 0);
    assert.ok(c.yaw > Math.PI * 6, 'and a third circle, with nothing to stop it');

    // Pitch clamps just short of vertical, and leaves the clamp immediately.
    c.pitch = 0;
    mouse(0, -100000);
    near(c.pitch, LIMIT, 1e-12, 'pitch pins just short of straight up');
    mouse(0, 40);
    near(c.pitch, LIMIT - 40 * 0.0025, 1e-12, 'and comes straight back down, with nothing banked past the clamp');
    c.pitch = 0;
    mouse(0, 100000);
    near(c.pitch, -LIMIT, 1e-12, 'and the same looking down');
    c.pitch = 0;

    // Sensitivity is a plain multiplier on the delta.
    const turn = (sensitivity) => {
      c.setSensitivity(sensitivity);
      c.yaw = 0;
      mouse(100, 0);
      return Math.abs(c.yaw);
    };
    const at1 = turn(1), at2 = turn(2);
    near(at1, 100 * 0.0025, 1e-12, 'one times is lookSpeed exactly');
    near(at2, at1 * 2, 1e-12, 'two times is twice as far, with no curve in between');
    c.setSensitivity(99);
    assert.equal(c.sensitivity, 3, 'sensitivity is clamped');
    c.setSensitivity(Number.NaN);
    assert.equal(c.sensitivity, 3, 'a non-finite sensitivity is ignored');
    c.setSensitivity(1);
    c.yaw = 0; c.pitch = 0;

    // Escape remains native browser behavior; X reliably gives the mouse back.
    key('Escape');
    assert.equal(pauseRequests, 0, 'Escape is left to the browser');
    assert.equal(c.locked, true, 'and our handler does not release the lock behind it');
    key('KeyX');
    assert.equal(pauseRequests, 0, 'X does not open the pause menu');
    assert.equal(quietUnlocks, 1, 'X marks the unlock as quiet so no re-entry card appears');
    assert.equal(c.locked, false, 'X gives the captured mouse back');
    pointer('pointerdown', { button: 0, pointerType: 'mouse', clientX: 500, clientY: 400, pointerId: 2 });
    assert.equal(c.locked, true, 'clicking after X captures the mouse and clears the prompt state');
    key('KeyP');
    assert.equal(pauseRequests, 1, 'P asks for the pause menu');
    assert.equal(c.locked, false, 'and hands the cursor back so the menu can be clicked');
    const pausedYaw = c.yaw;
    mouse(300, 300);
    assert.equal(c.yaw, pausedYaw, 'a paused viewer ignores the mouse');
    pointer('pointerdown', { button: 0, pointerType: 'mouse', clientX: 500, clientY: 400, pointerId: 4 });
    assert.equal(c.locked, false, 'and clicking through the menu does not re-capture the cursor');
    key('KeyP');
    assert.equal(resumeRequests, 1, 'P closes the pause menu');
    assert.equal(pauseRequests, 1, 'closing the menu does not re-open it');

    // The browser taking the lock away — Escape, a tab switch — must not leave
    // a key stuck down, or the player walks on with no way to steer.
    pointer('pointerdown', { button: 0, pointerType: 'mouse', clientX: 500, clientY: 400, pointerId: 5 });
    assert.equal(c.locked, true, 'clicking the viewport captures it again');
    key('KeyW');
    document.exitPointerLock();
    assert.equal(c.locked, false, 'the browser released it');
    m.reset();
    const parked = camera.position.clone();
    frames(60);
    near(camera.position.distanceTo(parked), 0, 1e-6, 'losing the lock releases the movement keys');

    // Chrome refuses a request made too soon after Escape, and says so with a
    // rejected promise rather than by throwing. Neither may reach the caller.
    canvas.requestPointerLock = () => Promise.reject(new Error('too soon after an exit'));
    pointer('pointerdown', { button: 0, pointerType: 'mouse', clientX: 500, clientY: 400, pointerId: 4 });
    assert.equal(c.locked, false, 'a refused request leaves the click-to-look prompt up');
    canvas.requestPointerLock = () => {
      lockRequests += 1;
      document.pointerLockElement = canvas;
      document.dispatchEvent(new Event('pointerlockchange'));
    };

    // Touch cannot lock a pointer, so a finger down still looks by swiping.
    c.yaw = 0;
    pointer('pointermove', { pointerType: 'touch', clientX: 999, clientY: 400 });
    assert.equal(c.yaw, 0, 'touch without a finger down does not look');
    pointer('pointerdown', { button: 0, pointerType: 'touch', clientX: 500, clientY: 400, pointerId: 5 });
    assert.equal(lockRequests, 3, 'and a finger never asks for pointer lock');
    pointer('pointermove', { pointerType: 'touch', clientX: 562, clientY: 400 });
    near(c.yaw, -62 * 0.004 * c.sensitivity, 1e-12, 'a touch swipe looks by its own delta');
    pointer('pointerup', { pointerType: 'touch', clientX: 562, clientY: 400, pointerId: 5 });
    const released = c.yaw;
    pointer('pointermove', { pointerType: 'touch', clientX: 900, clientY: 400 });
    assert.equal(c.yaw, released, 'a released swipe stops looking');
    c.yaw = 0; c.pitch = 0; c.clearInput();

    // W and S walk along the heading; A and D strafe across it.
    pointer('pointerdown', { button: 0, pointerType: 'mouse', clientX: 500, clientY: 400, pointerId: 6 });
    m.reset(); c.yaw = 0; c.pitch = 0;
    key('KeyD');
    frames(90);
    key('KeyD', 'keyup');
    assert.ok(m.eye.x > 0.5 && Math.abs(m.eye.z) < 0.05, 'D strafes right without walking forward');
    m.reset(); c.yaw = 0;
    key('KeyA');
    frames(90);
    key('KeyA', 'keyup');
    assert.ok(m.eye.x < -0.5 && Math.abs(m.eye.z) < 0.05, 'A strafes left');
    // Pitch must never tilt the floor: looking up and walking still goes flat.
    m.reset(); c.yaw = 0; c.pitch = LIMIT;
    key('KeyW');
    frames(90);
    key('KeyW', 'keyup');
    near(m.eye.y, 1.652, 0.01, 'looking straight up does not lift the player off the floor');
    assert.ok(m.eye.z < -0.5, 'and forward is still forward');
    c.pitch = 0;

    // Face -z so the movement assertions below measure travel, not the look tests' heading.
    c.clearInput(); m.reset(); c.yaw = 0; c.pitch = 0;
    key('KeyW');
    for (let i = 0; i < 120; i++) c.update(1 / 60);
    const walkDistance = -camera.position.z;
    m.reset(); c.clearInput(); key('KeyW'); key('ShiftLeft');
    for (let i = 0; i < 120; i++) c.update(1 / 60);
    assert.ok(-camera.position.z > walkDistance * 2.3);
    near(camera.position.y, 1.652, 0.01, 'running stays grounded');
    window.dispatchEvent(new Event('blur'));
    const stopped = camera.position.clone();
    for (let i = 0; i < 60; i++) c.update(1 / 60);
    near(camera.position.distanceTo(stopped), 0, 0.001, 'blur stops movement');
    c.dispose(); key('KeyW'); c.enabled = true;
    for (let i = 0; i < 60; i++) c.update(1 / 60);
    near(camera.position.distanceTo(stopped), 0, 0.001, 'disposed listeners removed');
  } finally {
    c.dispose();
    globalThis.document = oldDocument; globalThis.window = oldWindow;
    globalThis.navigator.getGamepads = oldGetGamepads;
  }
});
