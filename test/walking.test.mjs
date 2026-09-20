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
  let pauseRequests = 0, resumeRequests = 0;
  // Mirror WorldCanvas: a pause request pauses the controller.
  c.onPauseRequest = () => { pauseRequests++; c.setPaused(true); };
  c.onResumeRequest = () => { resumeRequests++; c.setPaused(false); };
  const pointer = (type, values = {}) => {
    const event = new Event(type);
    for (const [key, value] of Object.entries(values)) Object.defineProperty(event, key, { value });
    canvas.dispatchEvent(event);
  };
  const key = (code, type = 'keydown') => { const event = new Event(type); Object.defineProperty(event, 'code', { value: code }); document.dispatchEvent(event); };
  try {
    // The canvas is 1000x800, so the cursor rests at (500, 400).
    const at = (x, y) => pointer('pointermove', { pointerType: 'mouse', clientX: x, clientY: y });
    const frames = (n) => { for (let i = 0; i < n; i++) c.update(1 / 60); };
    const rate = () => { const y = c.yaw, p = c.pitch; c.update(1 / 60); return { yaw: (c.yaw - y) * 60, pitch: (c.pitch - p) * 60 }; };

    // The cursor steers by where it sits, not by how it got there, and with no
    // button and no capture. The event itself never turns anything.
    pointer('pointerenter', { pointerType: 'mouse', clientX: 500, clientY: 400 });
    const resting = c.yaw;
    at(900, 400);
    assert.equal(c.yaw, resting, 'a pointer event alone does not turn the camera');
    assert.ok(rate().yaw < 0, 'a cursor right of centre turns right');
    at(100, 400);
    assert.ok(rate().yaw > 0, 'a cursor left of centre turns left');
    at(500, 720);
    assert.ok(rate().pitch < 0, 'a cursor below centre looks down');
    at(500, 80);
    assert.ok(rate().pitch > 0, 'a cursor above centre looks up');

    // Vertical is the same law as horizontal, which is the whole point: equal
    // deflection along either axis has to turn at the same rate.
    at(900, 400); const sideways = Math.abs(rate().yaw);
    at(500, 720); const upright = Math.abs(rate().pitch);
    near(upright, sideways, 1e-12, 'equal deflection turns at an equal rate in both axes');

    // A rest band around the crosshair, so the cursor has somewhere to sit.
    at(500, 400);
    near(rate().yaw, 0, 1e-12, 'the centre of the canvas does not drift');
    near(rate().pitch, 0, 1e-12, 'and does not pitch either');
    at(575, 460);
    near(rate().yaw, 0, 1e-12, 'nor does anywhere inside the rest band');
    near(rate().pitch, 0, 1e-12, 'in either axis');

    // Squared ramp: the first pixels outside the band barely move.
    at(620, 400); const entering = Math.abs(rate().yaw);
    at(1000, 400); const against = Math.abs(rate().yaw);
    assert.ok(entering > 0 && entering < against / 20, 'the ramp eases out of the rest band');

    // Nothing accumulates, so the view cannot drift away from the cursor. This
    // is the regression: under the old delta law, grazing the pitch clamp threw
    // away what it could not spend going up but charged all of it coming down,
    // and the same cursor position came back ten degrees lower.
    at(500, 400); frames(30);
    const horizon = c.pitch;
    at(500, 0); frames(120);
    near(c.pitch, Math.PI / 2 - 0.02, 1e-9, 'holding the cursor at the top reaches straight up');
    at(500, 400); frames(300);
    near(c.pitch, Math.PI / 2 - 0.02, 1e-9, 'and the view stays there rather than unwinding');
    at(500, 800); frames(240);
    near(c.pitch, -(Math.PI / 2 - 0.02), 1e-9, 'holding the cursor at the bottom reaches straight down');
    at(500, 400); frames(300);
    near(c.pitch, -(Math.PI / 2 - 0.02), 1e-9, 'the rest band holds whatever it was given');
    c.pitch = horizon;

    // Re-entering never jumps: there is no seed to go stale.
    pointer('pointerleave', { pointerType: 'mouse', clientX: 110, clientY: 60 });
    const awayYaw = c.yaw;
    pointer('pointerenter', { pointerType: 'mouse', clientX: 700, clientY: 400 });
    at(700, 400);
    assert.equal(c.yaw, awayYaw, 're-entering the canvas does not jump the view');

    // M pauses, and nothing turns while paused. Escape is the browser's key for
    // leaving fullscreen and cannot be taken back, so it is not ours to use.
    key('Escape');
    assert.equal(pauseRequests, 0, 'Escape is left to the browser');
    key('KeyM');
    assert.equal(pauseRequests, 1, 'M opens the pause menu');
    const pausedYaw = c.yaw;
    pointer('pointermove', { pointerType: 'mouse', clientX: 60, clientY: 40 });
    assert.equal(c.yaw, pausedYaw, 'a paused viewer ignores pointer input');
    key('KeyM');
    assert.equal(resumeRequests, 1, 'M closes the pause menu');
    assert.equal(pauseRequests, 1, 'closing the menu does not re-open it');

    // Touch has no cursor, so it turns by swiping and stops when the finger lifts.
    pointer('pointerenter', { pointerType: 'mouse', clientX: 50, clientY: 20 });
    const beforeTouch = c.yaw;
    pointer('pointermove', { pointerType: 'touch', clientX: 999, clientY: 20 });
    assert.equal(c.yaw, beforeTouch, 'touch without a finger down does not turn');
    pointer('pointerdown', { button: 0, pointerType: 'touch', clientX: 50, clientY: 20, pointerId: 4 });
    pointer('pointermove', { pointerType: 'touch', clientX: 62, clientY: 20 });
    assert.notEqual(c.yaw, beforeTouch, 'touch swipe turns');
    pointer('pointerup', { pointerType: 'touch', clientX: 62, clientY: 20, pointerId: 4 });
    const releasedYaw = c.yaw;
    pointer('pointermove', { pointerType: 'touch', clientX: 90, clientY: 20 });
    assert.equal(c.yaw, releasedYaw, 'a released swipe stops turning');

    // Scroll turns with no click, no capture and no held button, and it eases
    // out over several frames rather than snapping.
    const wheel = (values) => {
      const event = new Event('wheel');
      for (const [k, v] of Object.entries({ deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, preventDefault: () => {}, ...values })) {
        Object.defineProperty(event, k, { value: v });
      }
      canvas.dispatchEvent(event);
    };
    c.setSensitivity(1);
    // Take the cursor off the canvas so edge turning cannot colour these frames.
    pointer('pointerleave', { pointerType: 'mouse', clientX: 50, clientY: 20 });
    const scrollStart = c.yaw;
    wheel({ deltaX: 100 });
    assert.equal(c.yaw, scrollStart, 'scroll does not snap the camera on the event itself');
    c.update(1 / 60);
    const firstFrame = Math.abs(c.yaw - scrollStart);
    assert.ok(firstFrame > 0, 'scroll turns on the next frame');
    assert.ok(firstFrame < 0.22, 'the first frame spends only part of the scroll');
    for (let i = 0; i < 120; i++) c.update(1 / 60);
    near(Math.abs(c.yaw - scrollStart), 0.22, 1e-3, 'the whole scroll is eventually spent');
    // Frame rate must not change how far a given scroll turns.
    const slowStart = c.yaw;
    wheel({ deltaX: 100 });
    for (let i = 0; i < 20; i++) c.update(1 / 10);
    near(Math.abs(c.yaw - slowStart), 0.22, 1e-3, 'scroll travel is frame-rate independent');
    // Line and page deltas are normalised, and ctrl+wheel belongs to the browser.
    const lineStart = c.yaw;
    c.pitch = 0;
    wheel({ deltaY: 3, deltaMode: 1 });
    for (let i = 0; i < 120; i++) c.update(1 / 60);
    near(Math.abs(c.pitch), 3 * 16 * 0.0022, 1e-3, 'line deltas are scaled to pixels');
    assert.equal(c.yaw, lineStart, 'vertical scroll pitches rather than yawing');
    c.pitch = 0;
    const zoomStart = c.yaw;
    wheel({ deltaX: 500, ctrlKey: true });
    c.update(1 / 60);
    assert.equal(c.yaw, zoomStart, 'ctrl+wheel is left to the browser zoom');
    // Pitch cannot bank rotation past the clamp and unwind it later.
    wheel({ deltaY: -100000 });
    for (let i = 0; i < 200; i++) c.update(1 / 60);
    near(c.pitch, Math.PI / 2 - 0.02, 1e-9, 'pitch pins at the limit');
    wheel({ deltaY: 1 });
    for (let i = 0; i < 200; i++) c.update(1 / 60);
    assert.ok(c.pitch < Math.PI / 2 - 0.02, 'scrolling back down leaves the limit immediately');
    c.pitch = 0; c.clearInput();

    // The user multiplier scales cursor turning as well as scroll.
    pointer('pointerenter', { pointerType: 'mouse', clientX: 500, clientY: 400 });
    const turn = (sensitivity) => {
      c.setSensitivity(sensitivity);
      at(1000, 400);
      return Math.abs(rate().yaw);
    };
    const at1 = turn(1), at2 = turn(2);
    near(at1, 2.2, 1e-9, 'full deflection turns at lookRate');
    near(at2, at1 * 2, 1e-9, 'sensitivity scales cursor look');
    c.setSensitivity(99);
    assert.equal(c.sensitivity, 3, 'sensitivity is clamped');
    c.setSensitivity(Number.NaN);
    assert.equal(c.sensitivity, 3, 'a non-finite sensitivity is ignored');
    c.setSensitivity(1);

    // A full turn is reachable by holding the cursor out at the edge.
    c.setSensitivity(1);
    pointer('pointerenter', { pointerType: 'mouse', clientX: 500, clientY: 400 });
    at(500, 400);
    const spinStart = c.yaw;
    at(0, 400);
    frames(60 * 4);
    assert.ok(c.yaw - spinStart > Math.PI * 2, 'holding the edge turns a full circle');
    // A cursor that has left the canvas never spins the world behind a control.
    pointer('pointerleave', { pointerType: 'mouse', clientX: 0, clientY: 400 });
    near(rate().yaw, 0, 1e-12, 'a cursor off the canvas does not turn');

    // Face -z so the movement assertions below measure travel, not the look tests' heading.
    c.clearInput(); m.reset(); c.yaw = 0; c.pitch = 0;
    key('KeyW');
    for (let i = 0; i < 120; i++) c.update(1 / 60);
    const walkDistance = -camera.position.z;
    m.reset(); c.clearInput(); key('KeyW'); key('ShiftLeft'); key('KeyE');
    for (let i = 0; i < 120; i++) c.update(1 / 60);
    assert.ok(-camera.position.z > walkDistance * 2.3);
    near(camera.position.y, 1.652, 0.01, 'E did not raise player');
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
