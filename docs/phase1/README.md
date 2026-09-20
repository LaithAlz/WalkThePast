# Phase 1 — Walkable Historical World

Goal: a judge sees the original photograph, fades into the matching 3D view, and immediately starts walking.

## What the viewer does now

| Requirement | Implementation |
|---|---|
| WASD movement | `src/viewer/controls.ts` — walks on the ground plane relative to yaw; `Shift` runs |
| Mouse look | pointer lock on canvas click; `X` releases the captured mouse |
| Optional gamepad | left stick walk, right stick look, triggers run, `A` enter, `Y` photographer, `X` wipe |
| Reset-to-photographer | `R` eases the camera back (position, orientation, FOV) over 0.9 s; `Shift+R` ignores a saved pose |
| Photo ↔ world wipe | landing shows the photograph → `Enter` crossfades into the 3D pose; hold `Tab` to peek at the photo; `V` shows a draggable divider (photo left, world right) |
| Local caching | `public/sw.js` serves `/worlds/**` cache-first; "Cache world offline" in the dev panel prefetches the hero world's splat, pano and photo |

Dev panel is hidden for judges; `H` or `?dev=1` shows it. Query params from Phase 0 still work
(`?world=`, `?splat=`, `?lod=0`, `?budget=`, `?pano=0`, `?radius=`, `?panoYaw=`).

## Demo checklist

1. `cd viewer && npm run build && npm run preview` — production build, no HMR surprises.
2. Open the hero world, press `H`, click **Cache world offline**, wait for "offline ✓ NNN MB".
3. Turn Wi-Fi off, reload: the world must still open. Turn it back on.
4. Align the photographer once: `R`, tweak with `WASD` / `[` `]`, then `C` and paste the JSON into
   `sourceCamera` in that world's `world.json` (or `L` to keep it in this browser only).
5. Rehearse: landing → `Enter` → walk → `R` → hold `Tab` → `V` and drag.

## Hero world

`viewer/public/worlds/marble-paris-cropped` (Atget, rue Cardinale, 1922; Marble 1.1; ~2M splats; pano; 3.5 m walk radius).
