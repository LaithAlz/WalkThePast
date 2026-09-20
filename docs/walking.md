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

- **Point where you want to look.** The cursor steers by position, not by
  movement: where it sits inside the canvas sets how fast the view turns. A
  rest band of `LOOK_REST_BAND` (16% of each half-axis, so the middle 32% of
  the canvas in both directions) holds the view still, and outside it the rate
  ramps with the square of the deflection, reaching `lookRate` (2.2 rad/s,
  about a full turn in three seconds) at the very edge. Both axes, identically:
  the same deflection left and the same deflection down turn at the same rate.
  Turning stops the moment the cursor leaves the canvas.

  This replaced a controller that accumulated cursor deltas in the middle of
  the canvas and switched to a rate in an edge margin. Two control laws in one
  controller produced both of the bugs that made it feel wrong, and measuring
  them is the clearest way to see why one law was the fix:

  | round trip, cursor returns to where it started | old | new |
  | --- | --- | --- |
  | horizontal, no clamp and no edge margin | 0.0° | 0.0° |
  | vertical, grazing the pitch clamp | **−10.0°** | 0.0° |
  | horizontal, one second in the edge margin | **−87.5°** | 0.0° |

  The vertical figure is the clamp: a sweep from the middle of an 863 px canvas
  to the top is 98.8° of intent, pitch stops at 88.9°, and the 9.9° it could
  not spend was discarded — but the sweep back subtracted all 98.8°, so the
  same cursor position came back ten degrees lower. The horizontal figure is
  the edge margin advancing yaw while the cursor stood still. A rate law has
  neither, because nothing accumulates: the cursor's position is the whole of
  the input, every frame, and a rate cannot overshoot a clamp.

  Excluding pitch from the old edge ramp was also what made looking up feel
  unlike looking sideways. The full pitch range needed 775 px of travel against
  863 px of canvas — one shot from a perfect starting position, and flatly
  impossible below 1× sensitivity, where it needs 1551 px. There was no
  vertical equivalent of the ramp to get round it. Now both axes reach both
  limits by holding the cursor there.
- **Scroll** to turn as well, which is a two-finger swipe. Scroll is banked
  and eased out over a few frames, so a notched wheel glides instead of
  stepping and a trackpad flick coasts. It also carries you past the point
  where the cursor runs out of screen, which is the main reason to keep both.
  Ctrl/pinch wheel is left to the browser's zoom. The handler is non-passive
  and calls `preventDefault`, which also stops a horizontal swipe triggering
  the browser's back/forward navigation.
- Turning only happens while the pointer is over the canvas, so it stops the
  moment the cursor reaches an overlay control and a cursor parked on a button
  never spins the world. Re-entering never snaps the view, because there is no
  seed to go stale. The unavoidable cost of cursor-steering is that the view
  does turn on the way to a control; M freezes everything if you need the
  pointer somewhere without moving.
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
  scales cursor, scroll, swipe and gamepad turning alike. The right value depends on
  the pointing device, so there is no single correct default.
- WASD or arrow keys walk; Shift runs.
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
