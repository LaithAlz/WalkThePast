# Walking and collision setup

The viewer now uses a capsule character controller instead of free flight.
Generation itself is unchanged. A splat is appearance data, not solid geometry:
each generated world needs an aligned collision mesh to enable proper terrain
and object collisions.

## Pipeline handoff

Marble exports a collider for every world it generates: a coarse GLB of
100–200k triangles "optimized for simple physics calculations", alongside the
splats and the panorama. `pipelines/marble/generate_world.py` downloads it to
`collider.glb` and writes the `collider` block below, so a generated world is
walkable without any manual modelling. Hand-authored meshes follow the same
contract.

Save a self-contained, uncompressed GLB collision mesh beside the splat, and
add these fields to `public/worlds/<id>/world.json` (example values only):

```json
{
  "collider": {
    "url": "collider.glb",
    "space": "world"
  },
  "walking": {
    "spawn": [0, 1.65, 0],
    "eyeHeight": 1.65,
    "height": 1.8,
    "radius": 0.28,
    "stepHeight": 0.3,
    "maxSlopeDegrees": 45,
    "speed": 1.6,
    "sprintMultiplier": 2.5
  }
}
```

- `space: "world"`: mesh is already in the rendered Three.js Y-up frame,
  with metric scale and ground offset baked in.
- `space: "splat"`: mesh has exactly the raw coordinates of the splat. The
  viewer applies the splat's metric scale, ground offset and axis conversion.
  Do not choose this for a mesh whose exporter already applied those transforms.
- Optional collider `position`, Euler `rotation` (radians), and uniform `scale`
  apply after the coordinate conversion. Prefer aligned exports without overrides.
- `spawn` is the desired **eye position** in rendered world coordinates, not
  raw splat coordinates or feet position. The controller finds a nearby floor
  and checks body/head clearance. If absent, it starts near the source camera.
  Keep `sourceCamera` unchanged: that pose is for historical evidence alignment.
- All player lengths/speeds use rendered world units; make those metres before
  tuning. Existing `bounds.radiusM` constrains horizontal travel around spawn;
  `walking.radiusLimit` overrides it (zero means no radial limit).
- Use only solid floor/wall/stair geometry with outward-facing triangles.
  Decorative objects, transparent panes and tiny noisy fragments can create
  unwanted obstructions. Animated, Draco/Meshopt-compressed meshes are not
  supported by this loader. Cross-origin URLs must permit browser CORS.

An absent collider deliberately enables a **level-ground preview** with a
visible warning. Its floor is `walking.groundY` (default zero); it cannot stop
the user walking through visible objects or follow uneven terrain. A declared
collider that fails to load, has no triangles, or has no safe spawn **disables
movement** with an error instead of silently allowing flight.

The current local Giza sample has no collider and therefore remains ground-only.
No collider has been invented from its photograph. Full collision validation on
that scene must wait for an aligned mesh from the pipeline.

## Controls and behavior

Standard pointer-lock mouselook. Click the viewport to capture the cursor and
the browser reports raw hardware deltas with no window to run out of.

- **Click the viewport to look around.** While the lock is held, `movementX` and
  `movementY` go straight onto yaw and pitch at `lookSpeed` (0.0025 rad/px)
  times the user's sensitivity, applied on the event itself. Nothing is
  smoothed, eased, accelerated, curved or banked: a hand that moves twice as
  far turns the view twice as far, and a still mouse is a still camera for as
  long as you leave it. Yaw is unbounded; pitch clamps at ±89° so the view can
  never flip, and comes straight back off the clamp with nothing stored up.

  This replaced two controllers that steered with a visible cursor, one
  accumulating deltas with a turn rate in an edge margin and one mapping cursor
  position to a turn rate over the whole canvas. Both drifted, for the same
  reason: the cursor is bounded by the window and yaw is not, so something had
  to convert "the cursor ran out of screen" into "keep turning", and whatever
  did that broke the correspondence between hand and view. Measured as a round
  trip, cursor returned to where it started:

  | | deltas + edge ramp | rate everywhere | pointer lock |
  | --- | --- | --- | --- |
  | horizontal, plain | 0.0° | 0.0° | n/a — no cursor to return |
  | vertical, grazing the clamp | **−10.0°** | 0.0° | n/a |
  | horizontal, one second at the edge | **−87.5°** | 0.0° | n/a |

  The column is "n/a" rather than zero because pointer lock removes the bound
  that caused the problem instead of working around it. There is no cursor
  position to correspond to, so there is nothing to drift away from.

- **W/S walk along the camera's horizontal heading; A/D strafe.** Pitch never
  tilts the floor: looking straight up and walking forward still travels flat.

- **X releases the captured mouse; P opens the pause menu.** While the lock is held
  nothing on screen can be clicked, so the way out has to be a key — a small
  hint in the corner says which. Escape is deliberately left to the browser: it
  spends it leaving pointer lock *and* leaving fullscreen, and a page cannot
  preventDefault its way out of either. It still releases the cursor, and
  `pointerlockchange` reports that like any other release, which is why the
  prompt tracks what the browser says rather than what we last asked for.

- **Clicking the viewport re-enters.** Chrome refuses a request made too soon
  after an Escape exit and reports it by rejecting the returned promise rather
  than throwing; that rejection is swallowed and the click-to-look prompt stays
  up, which is the correct state anyway. A browsing context that forbids
  pointer lock outright fails the same way, so the app degrades to "prompt that
  will not go away" rather than breaking.

- **Losing the lock releases the movement keys.** Whatever took it — Escape, a
  tab switch, our own menu — means the player has stopped, and a key left stuck
  down would walk them into a wall with no way to steer.

- **The wheel no longer steers.** Scroll-to-turn was part of the visible-cursor
  system and its easing is exactly the smoothing this controller is not allowed
  to have. The handler survives only to `preventDefault`, which keeps the page
  from scrolling and keeps a horizontal trackpad swipe from triggering the
  browser's back/forward navigation.
  and calls `preventDefault`, which also stops a horizontal swipe triggering
  the browser's back/forward navigation.
- Looking only happens while the lock is held, so overlay controls are only
  ever reachable with a free cursor and can never be steered through.
- P opens the pause menu and P again resumes. X releases only the captured
  mouse; Escape keeps its native browser behavior, including leaving fullscreen.
- Because the view turns on the way to any control, the pause menu is the only
  in-world chrome: walking, looking and the voice historian are all held while
  it is up, so its buttons — resume, reset, evidence, leave — are the one place
  a click costs you nothing. The transport stays open across a pause, and a
  transient ICE drop no longer ends the session, so the conversation is still
  there when you come back.
- Look sensitivity is a slider in the pause menu, persisted per browser in
  `localStorage` under `wtp:look-sensitivity` and clamped to 0.25×–3×. It
  multiplies the mouse delta directly, with no curve of any kind, and scales
  touch swipe and the gamepad stick alike. The right value depends on
  the pointing device, so there is no single correct default.
- WASD or arrow keys walk and strafe; Shift runs.
- Touch devices show direction buttons and turn with a one-finger swipe, since
  a touchscreen has no cursor to follow.
- Gamepad: left stick walk, right stick look, triggers run, Y/triangle reset.
- R or **Reset position** returns instantly to the safe starting position,
  clears momentum and restores the source viewing direction. Eye height remains
  a standing height; reset does not necessarily reproduce the source lens height.
- E toggles evidence; it no longer moves the camera vertically.
- Development builds only: Alt+F toggles fly inspection; Q/C change height.
  Returning to walking resets safely. This shortcut is absent in production.

The simulation uses fixed 120 Hz substeps, smooth horizontal acceleration,
gravity, capsule wall sliding, a slope limit, low-step ascent/descent and automatic
recovery after falling below the starting area. Large drops fall instead of
snapping down. Input clears on blur, hidden tabs and world changes. There is no
jump or head bob, and no animated reset flight through walls.

## Verification

Run `npm test`, `npm run build`, and `npm run lint`. Tests execute TypeScript
directly, so use Node 22.18+ or 24+ for `npm test`.

The synthetic tests cover level-ground fallback, eye height, sprint, diagonal
speed, frame-rate independence, braking, thin walls, corners, wall sliding,
stairs, high steps, steep/gentle slopes, ledges, ceilings, fall recovery, reset,
obstructed spawn, bounds, coordinate transforms and keyboard cleanup.

Before accepting **each generated world**, check it in the actual browser:

1. Verify the badge says **Walking · walls and ground enabled**, not preview.
2. Confirm the floor and obstacles align with the splat and the spawn has a
   clear view. A successfully parsed GLB does not prove alignment.
3. Walk/run into walls and corners, approach stairs and slopes, pass under
   doorways and walk off a ledge. Watch for noisy/blocked or missing surfaces.
4. Reset while moving; switch tabs and return; test evidence mode and touch.
5. Check performance on a representative laptop/mobile device. Octree building
   is synchronous, so keep collision geometry reasonably coarse. Simplify a
   mesh if its startup or movement cost is too high.

Generated collision meshes may have holes or inaccurate surfaces. Repair or
restrict those areas before marking a world production-ready; fall recovery is
a safety net, not proof that arbitrary generated geometry is navigable.
