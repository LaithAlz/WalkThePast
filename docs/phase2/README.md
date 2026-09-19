# Phase 2 — Geometric Provenance

Goal: show exactly where source evidence ends and generated reconstruction begins.

## Method (`viewer/src/provenance.ts`, pure typed-array math, unit-tested)

For each Gaussian, in world space:

1. Transform it into the historical source camera (the photographer pose: saved pose → `sourceCamera`
   in `world.json` → splat origin; FOV from the pose or `source.fovY`; aspect from the photo).
2. Project it into the original image → `(u, v)` and depth along the view axis.
3. Compare its depth with the **visible source depth** at that pixel: a min-depth map rendered from the
   photographer's pose over the opaque Gaussians (opacity ≥ 0.45). The generator reproduces the photograph
   from that pose, so the front surface there is what the photograph observed.
4. Classify:

| Class | Rule | Colour |
|---|---|---|
| `SOURCE_VISIBLE` | inside the frame and `depth ≤ surface + tol` | green `#3ddc84` |
| `OCCLUDED_INFERRED` | inside the frame, behind the surface the photo shows there | amber `#f2b134` |
| `UNSUPPORTED` | outside the frame, or behind the camera | purple `#a96bff` |

`tol = 0.04·surface + 1.5·maxScale + 0.03 m`. Tunable per world via `provenance: { width, opacityMin, relTol }`.

## Rendering (`viewer/src/evidence.ts`)

The class per splat lives in a Spark `RgbaArray` on the GPU; a dyno object modifier tints each Gaussian
from it, so switching modes or walking costs nothing on the CPU.

- **Exploration mode**: source-visible splats stay natural; inferred/unsupported splats desaturate and dim
  by a `shift` uniform that rises as the viewer walks away from the photographer (0 at 0.35 m → 1 at 3 m).
- **Evidence mode** (`M`): green / amber / purple at 78 % blend, plus the historical camera frustum (`K`)
  with the photograph on its image plane 1 m in front.
- **Inspector** (always on in world mode): the crosshair hit point is classified with the same rule and the
  panel explains *why*, with the hit marked on a thumbnail of the photograph.

## Requirements

Provenance runs when the world has a source photo (`provenance.enabled !== false`, `?prov=0` disables).
It loads the splat without Spark's LoD tree (indices must match the file), which is fine for ~2M splats.
Re-align the photographer (`R`/`WASD`/`[ ]`, then `L` or paste into `sourceCamera`) and press `P` to recompute.

## First numbers (Atget Paris, Marble 1.1, 500k tier, origin pose, 50° FOV)

| class | share |
|---|---|
| source-visible | 25.6 % |
| occluded / inferred | 12.1 % |
| unsupported | 62.2 % |

Compute time: ~0.5 s for 500k on the M1 (proportional; ~2 s at 2M).

## Kill switch status

Not needed: the occlusion label is stable on the test world. If it ever misbehaves, `provenance.relTol: 1e9`
collapses OCCLUDED into VISIBLE, leaving the exact in-frame / out-of-frame boundary.
