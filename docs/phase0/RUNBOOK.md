# Phase 0 runbook — World Generation Viability

Goal: prove `historical photo → Gaussian splat → Spark/three.js → photographer viewpoint recreated`
with **two generators side by side**, then pick one for Phase 1+.

| | World Labs Marble | NVIDIA Lyra 1.0 |
|---|---|---|
| What it is | Hosted world model, API + web app | Open feed-forward 3DGS model (Apache-2.0 code, NVIDIA Open Model License weights) |
| Runs on | World Labs cloud | **Needs an A100/H100 (~43 GB VRAM peak)** — not the M1 laptop |
| Input | 1 image (also multi-image / pano / video / text) | 1 image (also video for 4D) |
| Output | `.spz` (100k / 500k / full) + free `.ply` export | `.ply` gaussians |
| Cost | 230 credits ≈ $0.18 (draft) · 1 580 ≈ $1.26 (marble-1.1) · min buy $5 | GPU rental ≈ $2–4/h; ~15–30 min per world incl. diffusion |
| Turnaround | ~5 min | 15–30 min + 1–2 h one-time env setup |
| Source camera | **Not exported** — assumed at splat origin, FOV unknown → align by hand | **Identity pose + MoGe intrinsics** → pose and FOV known |
| Coordinate frame | OpenCV (`+x right, +y down, +z fwd`) + `metric_scale_factor`, `ground_plane_offset` | OpenCV, world = input camera frame, unit scale |

Both land in the same `world.json` manifest, so the viewer and every later phase are generator-agnostic.

---

## 0. Viewer (do this first, ~2 min, no accounts needed)

```bash
cd viewer && npm install && npm run dev
```

Open the printed URL. Two public Marble sample exports are pre-registered and stream from World Labs' CDN
(`marble-sample-lane`, `marble-sample-library`). Use them to validate Spark + FPS on the demo laptop before
spending credits. Drag-and-drop any local `.ply`/`.spz` to view it ad hoc.

Controls: `WASD` move · `Q/E` down/up · drag to look · `Shift` faster · `R` reset to photographer ·
`O` overlay · `[ ]` FOV · `C` copy camera JSON · `L` save pose · `F` flip axes · `G` grid · `B` 10 s benchmark.

FPS gate: run `B` while walking. Target on the judging laptop: **≥ 30 fps 1 % low** at the 500k tier
(`?lod=0` disables Spark's LoD to see the raw cost; edit the URL `_500k` → `_2m` to stress test).

## 1. Marble

1. Sign in at https://platform.worldlabs.ai, add a payment method, buy the minimum credit pack, create an API key.
2. `export WORLDLABS_API_KEY=...` (or put it in `.env` at the repo root — gitignored).
3. Put the historical photo in `assets/sources/` (jpg/png/webp, upright, as high-res as you have).
4. Smoke test with the draft model, then the hero model:

```bash
pip install -r pipelines/marble/requirements.txt
python pipelines/marble/generate_world.py --image assets/sources/photo.jpg --id marble-photo --model marble-1.0-draft
python pipelines/marble/generate_world.py --image assets/sources/photo.jpg --id marble-photo --model marble-1.1 --fov 55
```

The script uploads, generates (~5 min), downloads every `.spz` tier, requests the **free** full-res `.ply`
export (needed for the Phase 2 provenance engine), writes `viewer/public/worlds/marble-photo/world.json`
and registers it in the viewer dropdown. Reload the viewer → pick the world.

## 2. Lyra 1.0 — DROPPED 2026-09-19 (see COMPARISON.md); kept for the record

Rent a GPU box (RunPod/Lambda/Vast: 1× A100-80GB or H100, Ubuntu 22.04, CUDA 12 image). Then:

```bash
scp -r pipelines/lyra gpu:~/lyra-wtp
ssh gpu
huggingface-cli login            # needed for the NVIDIA checkpoints
bash ~/lyra-wtp/setup_lyra.sh ~/work        # ~1–2 h: conda env, apex build, ~40 GB of checkpoints
cd ~/work/lyra/Lyra-1
bash ~/lyra-wtp/run_lyra.sh /path/photo.png lyra-photo 1.0
#   ^ stage 1 GEN3C diffusion (6 trajectories), stage 2 Lyra 3DGS, stage 3 bundle
scp -r bundles/lyra-photo laptop:WalkThePast/viewer/public/worlds/
```

Add `{ "id": "lyra-photo", "name": "Lyra · photo" }` to `viewer/public/worlds/index.json`.

Notes
- `total_movement_distance_factor` 1.0 is safe; 2.0 explores further but adds artifacts.
- Lyra resizes to 704×1280 (16:9 landscape). Portrait historical photos will be letterboxed/cropped by MoGe —
  prefer landscape sources for the comparison.
- If `save_gaussians` is not honoured by the config, look for `gaussians/*.ply` under `outputs/` and pass
  `--ply` to `collect_outputs.py` explicitly.

## 2b. Lessons from the first live runs (2026-09-19)

- **Trim scan borders first.** Marble reproduced the Atget print's paper border as a picture frame and built a
  world where the photo hangs *inside a shop window*. Run `pipelines/prep_photo.py` (explicit `--crop` beats
  `--auto-border` on textured paper) and generate from `assets/sources/prepped/`. The `.crop.json` sidecar keeps the
  crop box in original-scan pixels for later camera mapping.
- **Use the full-res tier.** `splat_full_res.spz` (~2M splats) is far sharper up close than 500k; Spark's LoD keeps
  60 fps on the M1. Manifests default to it now; `?splat=splat_500k.spz` swaps tiers.
- **Why Marble's site looks better:** it composites the 360 pano behind the splats, renders every splat, and fences
  you to a few metres. The viewer now does all three (`pano` + `bounds.radiusM` in world.json; `?pano=0`,
  `?radius=0`, `?budget=N`, `?lod=0` to A/B). Pano yaw for Marble exports is 90° (verified against the photo).
- **Input resolution caps close-up quality.** The 512 px Giza illustration is blurry at arm's length no matter the tier.
- **Lyra 1.0 on RunPod:** H100 SXM secure cloud, build on local disk (network volume is too slow for conda), ~75 GB of
  checkpoints, apex from master needs `list[int]`→`List[int]` patched for torch 2.6, guardrail/Pixtral/Llama-Guard
  downloads are not needed (inference force-disables them). GEN3C stage ≈ 6 min per trajectory × 6.

## 3. Camera-alignment test (the actual exit gate)

For each generated world:

1. Press `R`. The viewer places the camera at the splat origin looking down OpenCV `+z`
   (the frame both generators build the world in). Lyra also sets the exact FOV from MoGe intrinsics.
2. Press `O` for a 50 % overlay of the source photo. The stage is letterboxed to the photo's aspect, so
   if the pose is right the overlay lines up edge-to-edge.
3. Nudge with `WASD/QE`, drag to look, `[ ]` to change FOV. Use the `wipe` slider to compare halves.
4. When it lines up: `C` copies the camera JSON. Paste it as `"sourceCamera"` in that world's `world.json`
   and commit. (`L` stashes it in localStorage meanwhile.)
5. Record the result in `docs/phase0/COMPARISON.md`.

If the world appears mirrored or upside-down, press `F` (toggles the OpenCV→three.js flip) and note it.

## 4. Exit gate checklist

- [ ] Viewer renders the CDN sample at acceptable FPS on the demo laptop (`B` report pasted in COMPARISON.md)
- [ ] One Marble world from *our* historical photo loads locally
- [ ] One Lyra world from the *same* photo loads locally
- [ ] Photographer viewpoint approximately recreated in at least one of them (`sourceCamera` committed)
- [ ] Generator decision recorded in COMPARISON.md
