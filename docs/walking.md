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

Nothing needs a button held or a pointer captured. There is deliberately no
click-to-capture (pointer lock) and no drag-to-look: you turn by moving.

- **The body and the eyes are separate.** A and D turn the body, held, with no
  limit, and W and S walk along wherever it is facing. The cursor moves only
  the eyes, and only within a cone around the body's forward direction: the
  centre of the canvas is straight ahead, each edge is `lookRange` (±70°) off
  it, and every position in between maps to exactly one direction. Walking
  follows the body, never the eyes, so you can walk down a corridor while
  looking out of a window.

  The split is what makes the cursor honest. Two earlier controllers steered
  entirely with the cursor and both drifted, for one reason: the cursor is
  bounded by the window and yaw is not, so something had to turn "the cursor
  ran out of screen" into "keep turning", and whatever did that broke the
  correspondence between where the cursor sat and where you were looking.
  Giving unbounded turning to A and D removes the need, so the cursor can be a
  pure function of position. Put it back in the same place and you are looking
  in the same direction; centre it and you are looking exactly where the body
  faces, whatever route it took to get there and however many times it hit the
  bound.

  | round trip, cursor returns to where it started | deltas + edge ramp | rate everywhere | body + eyes |
  | --- | --- | --- | --- |
  | horizontal, plain | 0.0° | 0.0° | 0.0° |
  | vertical, grazing the bound | **−10.0°** | 0.0° | 0.0° |
  | horizontal, one second at the edge | **−87.5°** | 0.0° | 0.0° |

  The first controller accumulated cursor deltas in the middle of the canvas
  and switched to a yaw rate in an edge margin. Its vertical figure is the
  pitch clamp: a sweep from the middle of an 863 px canvas to the top was 98.8°
  of intent, pitch stopped at 88.9°, and the 9.9° it could not spend was
  discarded — but the sweep back subtracted all 98.8°, so the same cursor
  position came back ten degrees lower. Its horizontal figure is the edge
  margin advancing yaw while the cursor stood still. The second replaced both
  laws with a single rate over the whole canvas, which is driftless but steers
  like a joystick: the view only rests when the cursor is parked.

- **A and D are unbounded and stop dead.** `turnSpeed` is 2 rad/s, about a full
  circle in three seconds; six seconds of holding D is 679° and still going.
  The input eases in over `TURN_EASE` so a tap nudges rather than snapping to
  full speed, but release is applied on the same frame rather than eased —
  coasting on past where you let go is the drift this controller exists to be
  rid of, and an eased release would have cost 9.5° of it.

- **There is no edge continuation.** Holding the cursor against an edge for
  five seconds turns the view by 0.00°. That behaviour belonged to the cursor
  when the cursor had to reach everywhere; it belongs to A and D now.

- **The eyes ease onto the cursor** at `LOOK_EASE`, which takes the jitter off
  a shaky hand and glides rather than jumps when the cursor re-enters the
  canvas. It converges on the target exactly rather than asymptotically, so the
  ±70° bound and the return-to-centre are both exact. Leaving the canvas
  freezes the look where it is rather than springing it forward, so reaching
  for a control does not also swing the view.
- **Scroll** turns the body as well, which is a two-finger swipe. Scroll is
  banked and eased out over a few frames, so a notched wheel glides instead of
  stepping and a trackpad flick coasts. Only the horizontal axis does anything:
  pitch belongs to the cursor now, and a second owner accumulating into it
  would fight the cursor's absolute position every frame. Ctrl/pinch wheel is
  left to the browser's zoom. The handler is non-passive
  and calls `preventDefault`, which also stops a horizontal swipe triggering
  the browser's back/forward navigation.
- Looking only happens while the pointer is over the canvas, so it stops the
  moment the cursor reaches an overlay control. The view does move on the way
  to a control, but only within the look cone and reversibly; M freezes
  everything if you need the pointer somewhere without moving.
- M opens the pause menu and M again resumes. Escape would be the conventional
  key, but a browser spends it leaving fullscreen and a page cannot
  preventDefault its way out of that, so pressing it would cost the visitor
  their fullscreen and hand them a menu they did not ask for.
- Because the view turns on the way to any control, the pause menu is the only
  in-world chrome: walking, looking and the voice historian are all held while
  it is up, so its buttons — resume, reset, evidence, leave — are the one place
  a click costs you nothing. The transport stays open across a pause, and a
  transient ICE drop no longer ends the session, so the conversation is still
  there when you come back.
- Look sensitivity is a slider in the pause menu, persisted per browser in
  `localStorage` under `wtp:look-sensitivity` and clamped to 0.25×–3×. It
  bends how quickly cursor travel reaches a given look angle (linear at 1×,
  sooner above it, finer near the centre below it) and scales scroll and swipe.
  The ±70° bound does not move with it. The right value depends on
  the pointing device, so there is no single correct default.
- W/S or up/down walk, A/D or left/right turn; Shift runs. There is no strafe: A and D spend their keys on turning, which is what makes the cursor able to stay bounded.
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
