#!/usr/bin/env bash
# Runs ON THE POD: wait for setup_lyra.sh to finish, then run one photo through Lyra.
#   bash pod_queue.sh /workspace/inputs/photo.jpg <world-id> [movement=1.0]
IMG="${1:?image}"; WID="${2:?world id}"; MOVE="${3:-1.0}"
ROOT=/opt/wtp; PERSIST=/workspace
until grep -qE "Lyra 1.0 ready|ENV READY" "$PERSIST/setup.log"; do
  pgrep -f "[s]etup_lyra.sh" >/dev/null || { echo "setup_lyra.sh is no longer running and never reported ready; see setup.log"; exit 1; }
  sleep 30
done
until grep -q DOWNLOADS_DONE "$PERSIST/download.log"; do sleep 30; done
echo "== env + checkpoints ready at $(date -u +%H:%M:%S) UTC"
# shellcheck disable=SC1091
source "$ROOT/miniconda3/etc/profile.d/conda.sh"
set +u; conda activate lyra
export HF_HOME="$PERSIST/hf"; [ -f /root/.hf_token ] && export HF_TOKEN="$(cat /root/.hf_token)"
cd "$ROOT/lyra/Lyra-1"
exec bash /workspace/lyra-wtp/run_lyra.sh "$IMG" "$WID" "$MOVE"
