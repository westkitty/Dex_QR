# Reproduce everything. Test-only tools: Python 3 with pyzbar, zxing-cpp, Pillow, NumPy; libzbar (set ZBAR_LIB);
# ffmpeg; Google Chrome. See README.md "Reproducing the tests".
PY ?= python3
ZBAR_LIB ?=
export PY
export LD_LIBRARY_PATH := $(ZBAR_LIB):$(LD_LIBRARY_PATH)

.PHONY: all build lint test fuzz fuzz-quick sweep trials video browser ux look a11y soak compress keycheck kdf screens bench compress-bench keycheck-bench report
all: build lint test fuzz-quick trials video browser ux look a11y soak compress keycheck bench compress-bench keycheck-bench report
build:   ; node tools/build.mjs
lint:    ; node tools/lint.mjs
test:    ; node --test tests/unit/*.test.mjs
fuzz:    ; node --expose-gc tests/fuzz/fuzz.mjs --cases 100000 --seed 1 --out results/fuzz_after.json
fuzz-quick: ; node --expose-gc tests/fuzz/fuzz.mjs --cases 5000 --seed 7 --long 60
sweep:   ; node tests/unit/lt-sweep.mjs 200
trials:  ; bash tests/e2e/run-drop-trials.sh
video:   ; bash tests/e2e/run-video-e2e.sh
browser: build ; node tests/browser/run.mjs
ux:      build ; node tests/browser/ux.mjs
a11y:    build ; node tests/browser/a11y.mjs
soak:    build ; node tests/browser/soak.mjs
compress: build ; node tests/browser/compression.mjs
bench:   build ; for E in L M Q; do BENCH_ECL=$$E BENCH_OUT=bench_$$E.json node tests/bench/bench.mjs || exit 1; done
compress-bench: ; BENCH_OUT=compression_after.json node tests/bench/compression.mjs
keycheck: build ; node tests/browser/keycheck.mjs
kdf:     build ; node tests/browser/kdf.mjs
look:    build ; node tests/browser/look.mjs
screens: build ; node tests/browser/screens.mjs work/screens dexqr
keycheck-bench: ; node tests/bench/keycheck.mjs 100
report:  ; node tools/report.mjs
