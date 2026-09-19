#!/usr/bin/env bash
# Historical photo -> Lyra 1.0 -> Gaussian splat bundle for the viewer.
#
# Usage (inside the Lyra-1 dir on the GPU box, conda env `lyra` active):
#   bash run_lyra.sh /path/to/photo.png <world-id> [movement_factor=1.0]
#
# Two stages, straight from Lyra-1/README.md:
#   1. GEN3C video diffusion: renders 6 camera trajectories (left/right/up/zoom_out/zoom_in/clockwise)
#      away from the input image, saving rgb .mp4, latent .pkl, pose .npz (w2c, OpenCV) and intrinsics .npz
#   2. Lyra feed-forward 3DGS reconstruction from those latents -> gaussians_<idx>.ply
#
# Then collect_outputs.py packages ply + source photo + camera intrinsics into
# bundles/<world-id>/ which you scp back into viewer/public/worlds/<world-id>/.
set -euo pipefail

IMG="${1:?image path}"
WID="${2:?world id}"
MOVE="${3:-1.0}"
HERE="$(cd "$(dirname "$0")" && pwd)"

[ -f sample.py ] || { echo "run from lyra/Lyra-1 (sample.py not found)"; exit 1; }

GEN_DIR=assets/demo/static/diffusion_output_generated
IN_DIR=assets/demo/static/diffusion_input/images
mkdir -p "$IN_DIR"

# GEN3C expects a clean folder for a fresh run; keep old runs aside
if [ -d "$GEN_DIR" ]; then mv "$GEN_DIR" "${GEN_DIR}_prev_$(date +%s)"; fi

# Lyra's demo expects PNG input; convert anything else.
NAME="$(basename "${IMG%.*}")"
python - "$IMG" "$IN_DIR/$NAME.png" <<'PY'
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert("RGB")
im.save(sys.argv[2])
print(f"input {im.size[0]}x{im.size[1]} -> {sys.argv[2]}")
PY

echo "== stage 1/2: GEN3C multi-trajectory video diffusion (this is the slow part, ~10-20 min on H100)"
CUDA_HOME="$CONDA_PREFIX" PYTHONPATH="$(pwd)" torchrun --nproc_per_node=1 \
  cosmos_predict1/diffusion/inference/gen3c_single_image_sdg.py \
  --checkpoint_dir checkpoints \
  --num_gpus 1 \
  --input_image_path "$IN_DIR/$NAME.png" \
  --video_save_folder "$GEN_DIR" \
  --foreground_masking \
  --multi_trajectory \
  --total_movement_distance_factor "$MOVE"

echo "== stage 2/2: Lyra 3DGS reconstruction"
cp "$HERE/lyra_static_custom.yaml" configs/demo/lyra_static_custom.yaml
CUDA_HOME="$CONDA_PREFIX" PYTHONPATH="$(pwd)" accelerate launch sample.py --config configs/demo/lyra_static_custom.yaml

echo "== packaging"
python "$HERE/collect_outputs.py" --image "$IN_DIR/$NAME.png" --id "$WID" \
  --gen-dir "$GEN_DIR" --out-dir outputs/walkthepast --bundle-dir bundles
