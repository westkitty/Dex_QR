#!/usr/bin/env bash
# Drop-rate trials: render -> real decoder (zbar, zxing-cpp) once per frame -> 100 replay trials per drop rate.
set -euo pipefail
cd "$(dirname "$0")/../.."
PY=${PY:-python3}
BS=${BS:-400}; ECL=${ECL:-M}; SCALE=${SCALE:-4}; TRIALS=${TRIALS:-100}
mkdir -p work results
for SIZE in 10240 102400 512000; do
  D=work/drop_${SIZE}
  if [ ! -f "$D/manifest.json" ]; then node tests/e2e/render-frames.mjs --size $SIZE --bs $BS --ecl $ECL --scale $SCALE --out $D; fi
  for DEC in zbar zxing; do
    [ -f "$D/decoded_${DEC}.json" ] || $PY tests/e2e/decode_frames.py $D --decoder $DEC
    node tests/e2e/trials.mjs --dir $D --decoder $DEC --trials $TRIALS --drops 0.1,0.3,0.5 --seed $SIZE --out results/trials_${SIZE}_${DEC}.json
  done
done
