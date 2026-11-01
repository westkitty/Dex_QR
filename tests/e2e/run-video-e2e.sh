#!/usr/bin/env bash
# Truly end-to-end video runs (3 per drop rate per size). Needs run-drop-trials.sh to have rendered the frames.
set -euo pipefail
cd "$(dirname "$0")/../.."
for SIZE in 10240 102400 512000; do
  node tests/e2e/video-e2e.mjs --dir work/drop_${SIZE} --trials ${VTRIALS:-3} --drops 0.1,0.3,0.5 --seed $SIZE --out results/video_e2e_${SIZE}.json
done
