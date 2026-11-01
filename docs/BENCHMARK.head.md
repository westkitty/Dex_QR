# Throughput benchmark

`tests/bench/bench.mjs` covers block sizes 200–1400 bytes at EC levels L, M and Q. For each configuration it renders 60 frames, each with the QR code about 600 px wide and the largest whole number of pixels per module. Three versions of each frame are decoded:

- **clean:** the rendered PNG.
- **moderate:** a synthetic camera-like image. The code is 600 px wide on a 1280×720 frame, with screen-like levels 45/215, 4° rotation, a 1.2 px Gaussian blur, noise with σ = 8, and JPEG quality 75.
- **harsh:** the code is 360 px wide on 1280×720, with levels 60/200, 7° rotation, a 1.4 px blur, noise with σ = 10, and JPEG quality 60.

The degradations are **synthetic** (`tests/bench/degrade.py`) and only stand in for a camera. They are useful for ranking settings, not for predicting a particular phone.

Decoders:
- zbar 0.23.x and zxing-cpp, both native, run single-process so the time is per CPU core.
- The receiver page's two built-in engines run inside headless Chrome on the first 30 frames: **zxing-cpp compiled to WebAssembly** (the default when the browser has no `BarcodeDetector`) and **jsQR**.

**Goodput** is the file data the receiver ends up with, per second: fps × block size × per-frame decode success ÷ 1.02. The 1.02 is the fountain overhead measured for files of 100 KiB and up. The 23-byte header, the CRC and the Base45 expansion are not counted in the block size.

**Maximum fps:**
- *Decoder limit:* zbar decodes these frames in about 5–15 ms clean and about 30 ms degraded per core, so it can keep up with 30+ fps on one core. zxing-cpp is faster. Each frame in a file pipeline is a separate image, so no "max fps" limit applies there beyond CPU speed.
- *Real limit:* the camera, unmeasured here. Cameras capture 30 (sometimes 60) fps, exposures blend consecutive sender frames, and rolling shutters tear them. A sender rate around a third to a half of the camera rate is the usual safe zone. The receiver page also needs time per frame (see the tables). With jsQR on noisy frames, it falls to about 2–3 frames/s.

## Results
