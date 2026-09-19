# Phase 0 — Marble vs Lyra 1.0 scorecard

Fill this in after running both pipelines on the **same** historical photo.
Decision rule: the generator that makes Phase 2 (geometric provenance) easiest wins, not the prettier one.

Test photo: `assets/sources/________` (era: ____, aspect: ____)

| Criterion | Weight | Marble (`marble-1.1`) | Lyra 1.0 | Notes |
|---|---|---|---|---|
| Generated at all / no failure | gate | ☐ | ☐ | |
| Wall-clock photo → splat | 2 | ___ min | ___ min (+ ___ h setup) | |
| Cost for this world | 1 | $___ | $___ (GPU hours) | |
| Splat count / file size | 1 | ___ / ___ MB | ___ / ___ MB | |
| FPS on demo laptop (avg / 1 % low, `B`) | 3 | ___ / ___ | ___ / ___ | 500k tier for Marble |
| Photographer pose recoverable (`R` + overlay) | **5** | ☐ exact ☐ approx ☐ no | ☐ exact ☐ approx ☐ no | Lyra: pose+FOV given. Marble: origin assumed, FOV by hand |
| Source-visible region fidelity (does the photo's content match?) | 4 | 1–5: __ | 1–5: __ | |
| Extent beyond the photo (walkable area) | 3 | 1–5: __ | 1–5: __ | Marble typically much larger |
| Behaviour off-frame (hallucination quality) | 2 | 1–5: __ | 1–5: __ | Matters for the evidence boundary demo |
| Coordinate frame sanity (no `F` needed) | 2 | ☐ | ☐ | |
| Metric scale available | 1 | ✔ (`metric_scale_factor`) | ✘ (unit) | affects walk speed only |
| Re-generation at hackathon time (no GPU wrangling) | 3 | ✔ API, 5 min | ✘ needs live H100 | |
| Licence / sponsor fit | 1 | ToS, credits | Apache-2.0 code, NVIDIA Open Model weights | |

## Benchmark reports (paste `B` output)

### CDN sample (marble-sample-lane, 500k)
```json
```

### Marble — our photo
```json
```

### Lyra — our photo
```json
```

## Aligned photographer poses

Marble `sourceCamera`:
```json
```

Lyra `sourceCamera` (should be ~identity: position 0,0,0 · quaternion 0,0,0,1 · fovY from intrinsics):
```json
```

## Decision

Generator for Phase 1+: __________

Why:

Kill-switch note (from the plan): if the chosen generator's export blocks the provenance system, swap the
generator and keep the manifest/viewer architecture — nothing downstream depends on which one produced the splat.
