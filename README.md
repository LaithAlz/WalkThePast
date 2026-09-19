# Walk the Past

HTN 2026. The project is not photo-to-3D: it is the evidence layer that shows where the historical
source ends and AI reconstruction begins. Plan: [`WALK_THE_PAST_PHASES.md`](WALK_THE_PAST_PHASES.md).

## Layout

```
viewer/            Vite + TypeScript + three.js + Spark viewer: photo → crossfade → first-person world (Phases 0-1)
  public/worlds/   one folder per generated world: world.json + source photo (+ gitignored splats)
pipelines/marble/  historical photo → World Labs Marble API → .spz/.ply → world.json
docs/phase0/       runbook + Marble-vs-Lyra scorecard
docs/phase1/       walkable-world controls + demo checklist
archive/lyra/      evaluated and dropped NVIDIA Lyra pipeline, kept for the record
assets/sources/    historical photographs (inputs)
```

## Quick start

```bash
cd viewer && npm install && npm run dev      # opens the hero world: press Enter to walk in, H for the dev panel
```

Then follow [`docs/phase0/RUNBOOK.md`](docs/phase0/RUNBOOK.md) to generate a world from your own photo
with Marble and run the camera-alignment test. (NVIDIA Lyra 1.0 was evaluated and dropped; see docs/phase0/COMPARISON.md.)
