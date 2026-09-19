#!/usr/bin/env bash
# One-shot environment setup for NVIDIA Lyra 1.0 (single image -> 3D Gaussian splat).
#
# Run this ON A CUDA LINUX BOX, not the M1 laptop. Tested targets per NVIDIA: A100/H100,
# ~43 GB VRAM peak with offloading. Cheapest practical options at hackathon time:
#   - RunPod / Lambda / Vast: 1x A100-80GB or H100 pod, Ubuntu 22.04, CUDA 12.x image with conda
#   - Modal / Baseten: wrap this script in a custom image (heavier; only if you need it as a service)
#
# Usage:  bash setup_lyra.sh [/workspace]
# Needs:  `huggingface-cli login` (HF token) before checkpoint downloads.
set -euo pipefail

ROOT="${1:-$PWD}"
cd "$ROOT"

if ! command -v conda >/dev/null 2>&1; then
  echo "conda not found. Installing Miniconda to $ROOT/miniconda3 …"
  curl -fsSL https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh -o /tmp/miniconda.sh
  bash /tmp/miniconda.sh -b -p "$ROOT/miniconda3"
  # shellcheck disable=SC1091
  source "$ROOT/miniconda3/etc/profile.d/conda.sh"
else
  # shellcheck disable=SC1091
  source "$(conda info --base)/etc/profile.d/conda.sh"
fi

if [ ! -d lyra ]; then
  git clone https://github.com/nv-tlabs/lyra.git
fi
cd lyra/Lyra-1

# --- INSTALL.md, verbatim order -------------------------------------------------
if ! conda env list | grep -qE '^lyra\s'; then
  conda env create --file lyra.yaml
fi
conda activate lyra

pip install -r requirements_gen3c.txt
pip install -r requirements_lyra.txt

ln -sf "$CONDA_PREFIX"/lib/python3.10/site-packages/nvidia/*/include/* "$CONDA_PREFIX/include/" || true
ln -sf "$CONDA_PREFIX"/lib/python3.10/site-packages/nvidia/*/include/* "$CONDA_PREFIX/include/python3.10" || true
pip install "transformer-engine[pytorch]==1.12.0"

if [ ! -d apex ]; then git clone https://github.com/NVIDIA/apex; fi
CUDA_HOME="$CONDA_PREFIX" pip install -v --disable-pip-version-check --no-cache-dir --no-build-isolation \
  --config-settings "--build-option=--cpp_ext" --config-settings "--build-option=--cuda_ext" ./apex

pip install git+https://github.com/microsoft/MoGe.git
pip install --no-build-isolation "git+https://github.com/state-spaces/mamba@v2.2.4"

CUDA_HOME="$CONDA_PREFIX" PYTHONPATH="$(pwd)" python scripts/test_environment.py

# --- checkpoints (needs a Hugging Face token) --------------------------------------
if [ -n "${HF_TOKEN:-}" ]; then
  huggingface-cli login --token "$HF_TOKEN" --add-to-git-credential >/dev/null 2>&1 || hf auth login --token "$HF_TOKEN" >/dev/null 2>&1 || true
fi
if [ -z "${HF_TOKEN:-}" ] && ! huggingface-cli whoami >/dev/null 2>&1; then
  echo
  echo "ENV READY. Checkpoints skipped: no Hugging Face token."
  echo "Re-run with  HF_TOKEN=hf_xxx bash $0 $ROOT   to download them (~40 GB)."
  exit 0
fi
python3 -m scripts.download_tokenizer_checkpoints --checkpoint_dir checkpoints/cosmos_predict1 --tokenizer_types CV8x8x8-720p
python scripts/download_gen3c_checkpoints.py --checkpoint_dir checkpoints
python scripts/download_lyra_checkpoints.py --checkpoint_dir checkpoints
huggingface-cli download nvidia/Lyra-Testing-Example --repo-type dataset --local-dir assets/demo

# our inference config (custom image, save gaussians)
cp "$(dirname "$0")/lyra_static_custom.yaml" configs/demo/lyra_static_custom.yaml 2>/dev/null || true

echo
echo "Lyra 1.0 ready in $(pwd). Next: bash run_lyra.sh /path/to/photo.png <world-id>"
