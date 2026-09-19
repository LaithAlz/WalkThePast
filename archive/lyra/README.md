# Archived: NVIDIA Lyra 1.0 pipeline (evaluated and dropped, 2026-09-19)

Kept for the record. Marble was chosen for Phase 1+; see `docs/phase0/COMPARISON.md` for the verdict.

- `pipeline/` — the scripts that ran Lyra 1.0 on a RunPod H100: `setup_lyra.sh`, `pod_launch.sh`,
  `pod_queue.sh`, `run_lyra.sh`, `collect_outputs.py`, `lyra_pt_to_ply.py` (converts Lyra's
  torch-archive "ply" into a real 3DGS PLY), `lyra_static_custom.yaml`.
- `world-lyra-paris/` — manifest + source for the one world produced (Atget, rue Cardinale 1922, uncropped scan).
  The 114 MB `splat.ply` was not committed; regenerate with the pipeline if ever needed.

Lessons: see the "Lessons from the first live runs" section of `docs/phase0/RUNBOOK.md`.
