#!/usr/bin/env bash
# Runs ON THE POD. Starts the Lyra env build and the checkpoint downloads concurrently.
#   ROOT    = fast local disk (conda, repo, compiled extensions)
#   PERSIST = persistent volume (checkpoints, demo assets, HF cache)
# Token: /root/.hf_token (mode 600), copied over by the laptop side.
set -euo pipefail
ROOT="${1:-/opt/wtp}"
PERSIST="${2:-/workspace}"
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$ROOT" "$PERSIST/checkpoints" "$PERSIST/assets_demo" "$PERSIST/hf"
export HF_HOME="$PERSIST/hf"
[ -f /root/.hf_token ] && export HF_TOKEN="$(cat /root/.hf_token)"

cd "$ROOT"
[ -d lyra ] || git clone -q https://github.com/nv-tlabs/lyra.git
cd lyra/Lyra-1
[ -L checkpoints ] || { rm -rf checkpoints; ln -s "$PERSIST/checkpoints" checkpoints; }
mkdir -p assets && { [ -L assets/demo ] || { rm -rf assets/demo; ln -s "$PERSIST/assets_demo" assets/demo; }; }

# 1) environment build (conda + pip + apex), long
cd "$ROOT"
nohup bash "$HERE/setup_lyra.sh" "$ROOT" "$PERSIST" > "$PERSIST/setup.log" 2>&1 < /dev/null &
echo "setup pid $!"

# 2) checkpoint downloads with the system python (only needs huggingface_hub/torch/safetensors)
cd "$ROOT/lyra/Lyra-1"
nohup bash -c '
  set -x
  pip install -q --break-system-packages "huggingface_hub[cli]" safetensors
  export PYTHONPATH=$(pwd)
  python3 -m scripts.download_tokenizer_checkpoints --checkpoint_dir checkpoints/cosmos_predict1 --tokenizer_types CV8x8x8-720p
  python3 scripts/download_lyra_checkpoints.py --checkpoint_dir checkpoints
  python3 scripts/download_gen3c_checkpoints.py --checkpoint_dir checkpoints
  # the t5-11b snapshot also ships a 45 GB TensorFlow copy that Cosmos never loads
  rm -f checkpoints/google-t5/t5-11b/tf_model.h5
  hf download nvidia/Lyra-Testing-Example --repo-type dataset --local-dir assets/demo || huggingface-cli download nvidia/Lyra-Testing-Example --repo-type dataset --local-dir assets/demo
  echo DOWNLOADS_DONE
' > "$PERSIST/download.log" 2>&1 < /dev/null &
echo "download pid $!"
