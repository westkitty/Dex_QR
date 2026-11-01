# Reproduce everything. Test-only tools: Python 3 with pyzbar, zxing-cpp, Pillow, NumPy; libzbar (set ZBAR_LIB);
# ffmpeg; Google Chrome. See README.md "Reproducing the tests".
PY ?= python3
ZBAR_LIB ?=
export PY
export LD_LIBRARY_PATH := $(ZBAR_LIB):$(LD_LIBRARY_PATH)

.PHONY: all build test sweep trials video browser bench report
all: build test trials video browser bench report
build:   ; node tools/build.mjs
test:    ; node --test tests/unit/*.test.mjs
sweep:   ; node tests/unit/lt-sweep.mjs 200
trials:  ; bash tests/e2e/run-drop-trials.sh
video:   ; bash tests/e2e/run-video-e2e.sh
browser: build ; node tests/browser/run.mjs
bench:   build ; for E in L M Q; do BENCH_ECL=$$E BENCH_OUT=bench_$$E.json node tests/bench/bench.mjs || exit 1; done
report:  ; node tools/report.mjs
