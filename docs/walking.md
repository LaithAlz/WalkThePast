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

- **Move the cursor** over the scene to turn: horizontal movement yaws,
  vertical movement pitches. On a trackpad that is a one-finger swipe.
- **Hold the cursor against the left or right edge** and it keeps yawing.
  Cursor travel is bounded by the window, so without this you can only turn as
  far as one sweep of the screen buys you and then stop dead. The rate ramps
  with the square of how far the cursor is into a margin of
  `clamp(48, width × 0.12, 120)` px, so it barely moves as you enter the margin
  and reaches `edgeTurnSpeed` (2.2 rad/s, about a full turn in three seconds)
  hard against the edge. Yaw only: pitch is clamped to just under a quarter
  turn, which is ~390 px of travel and fits on any screen, so a vertical
  equivalent would buy nothing and would creep the view whenever the cursor
  neared the toolbar.
- **Scroll** to turn as well, which is a two-finger swipe. Scroll is banked
  and eased out over a few frames, so a notched wheel glides instead of
  stepping and a trackpad flick coasts. It also carries you past the point
  where the cursor runs out of screen, which is the main reason to keep both.
  Ctrl/pinch wheel is left to the browser's zoom. The handler is non-passive
  and calls `preventDefault`, which also stops a horizontal swipe triggering
  the browser's back/forward navigation.
- Turning, edge turning included, only happens while the pointer is over the
  canvas, so all of it stops the moment the cursor reaches an overlay control
  and a cursor parked on a button never spins the world. Re-entering the canvas
  reseeds from the entry point rather than from where the cursor was last seen,
  so coming back from a button never snaps the view. The unavoidable cost of
  cursor-steering is that the view does turn on the way to a control; Escape
  freezes everything if you need the pointer somewhere without moving.
- Escape opens the pause menu and Escape again resumes. Since nothing captures
  the pointer, the key is never swallowed and this needs no special handling.
- Look sensitivity is a slider in the pause menu, persisted per browser in
  `localStorage` under `wtp:look-sensitivity` and clamped to 0.25×–3×. It
  scales cursor, edge, scroll and gamepad turning alike. The right value depends on
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
