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

### Decode success rate per frame (120 frames per config; jsQR and zxing-wasm in-page on the first 30)

| Block | EC | QR ver. | Modules | zbar clean / moderate / harsh | zxing-cpp clean / mod. / harsh | page zxing-wasm clean / mod. / harsh | page jsQR clean / mod. / harsh |
|---|---|---|---|---|---|---|---|
| 200 | L | 10 | 57 | 100.0% / 100.0% / 93.3% | 100.0% / 100.0% / 100.0% | 100.0% / 100.0% / 100.0% | 100.0% / 100.0% / 100.0% |
| 400 | L | 14 | 73 | 100.0% / 99.2% / 4.2% | 100.0% / 100.0% / 100.0% | 100.0% / 100.0% / 100.0% | 100.0% / 100.0% / 76.7% |
| 600 | L | 18 | 89 | 100.0% / 100.0% / 0.0% | 100.0% / 100.0% / 96.7% | 100.0% / 100.0% / 93.3% | 100.0% / 100.0% / 0.0% |
| 800 | L | 20 | 97 | 100.0% / 100.0% / 0.0% | 100.0% / 100.0% / 59.2% | 100.0% / 100.0% / 53.3% | 100.0% / 100.0% / 0.0% |
| 1000 | L | 23 | 109 | 100.0% / 100.0% / 0.0% | 100.0% / 100.0% / 0.0% | 100.0% / 100.0% / 0.0% | 0.0% / 0.0% / 0.0% |
| 1400 | L | 28 | 129 | 100.0% / 91.7% / 0.0% | 100.0% / 100.0% / 0.0% | 100.0% / 100.0% / 0.0% | 100.0% / 3.3% / 0.0% |
| 200 | M | 11 | 61 | 100.0% / 100.0% / 89.2% | 100.0% / 100.0% / 100.0% | 100.0% / 100.0% / 100.0% | 100.0% / 100.0% / 100.0% |
| 400 | M | 16 | 81 | 100.0% / 100.0% / 0.0% | 100.0% / 100.0% / 100.0% | 100.0% / 100.0% / 100.0% | 100.0% / 100.0% / 80.0% |
| 600 | M | 20 | 97 | 100.0% / 100.0% / 0.0% | 100.0% / 100.0% / 87.5% | 100.0% / 100.0% / 90.0% | 100.0% / 100.0% / 0.0% |
| 800 | M | 23 | 109 | 100.0% / 100.0% / 0.0% | 100.0% / 100.0% / 0.0% | 100.0% / 100.0% / 0.0% | 100.0% / 100.0% / 0.0% |
| 1000 | M | 27 | 125 | 100.0% / 90.8% / 0.0% | 100.0% / 100.0% / 0.0% | 100.0% / 100.0% / 0.0% | 100.0% / 3.3% / 0.0% |
| 1400 | M | 32 | 145 | 100.0% / 84.2% / 0.0% | 100.0% / 100.0% / 0.0% | 100.0% / 100.0% / 0.0% | 100.0% / 0.0% / 0.0% |
| 200 | Q | 13 | 69 | 100.0% / 100.0% / 79.2% | 100.0% / 100.0% / 100.0% | 100.0% / 100.0% / 100.0% | 100.0% / 100.0% / 96.7% |
| 400 | Q | 19 | 93 | 100.0% / 100.0% / 0.0% | 100.0% / 100.0% / 96.7% | 100.0% / 100.0% / 96.7% | 100.0% / 100.0% / 3.3% |
| 600 | Q | 24 | 113 | 100.0% / 99.2% / 0.0% | 100.0% / 100.0% / 0.0% | 100.0% / 100.0% / 0.0% | 100.0% / 100.0% / 0.0% |
| 800 | Q | 28 | 129 | 100.0% / 90.0% / 0.0% | 100.0% / 100.0% / 0.0% | 100.0% / 100.0% / 0.0% | 100.0% / 6.7% / 0.0% |
| 1000 | Q | 32 | 145 | 100.0% / 78.3% / 0.0% | 100.0% / 100.0% / 0.0% | 100.0% / 100.0% / 0.0% | 100.0% / 0.0% / 0.0% |
| 1400 | Q | 38 | 169 | 100.0% / 30.0% / 0.0% | 100.0% / 100.0% / 0.0% | 100.0% / 100.0% / 0.0% | 100.0% / 0.0% / 0.0% |

### Decode time per frame (ms, one CPU core of the test box)

| Block | EC | zbar clean / mod. / harsh | zxing-cpp | page zxing-wasm | page jsQR | QR encode (sender) |
|---|---|---|---|---|---|---|
| 200 | L | 5.2 / 33.0 / 33.2 | 2.0 / 8.5 / 8.9 | 2.9 / 6.7 / 7.1 | 20.0 / 426.4 / 526.9 | 2.26 |
| 400 | L | 6.8 / 34.1 / 33.6 | 2.4 / 9.1 / 9.7 | 2.6 / 7.1 / 7.4 | 21.8 / 466.6 / 556.1 | 3.82 |
| 600 | L | 12.6 / 34.2 / 33.8 | 2.5 / 9.3 / 9.6 | 2.8 / 6.8 / 7.6 | 25.3 / 459.5 / 529.3 | 5.73 |
| 800 | L | 14.6 / 33.3 / 32.3 | 2.2 / 8.9 / 8.9 | 2.1 / 6.8 / 9.6 | 20.9 / 440.6 / 548.3 | 6.31 |
| 1000 | L | 22.4 / 34.5 / 32.5 | 2.9 / 10.2 / 9.5 | 2.8 / 7.4 / 11.9 | 73.3 / 534.8 / 532.0 | 7.72 |
| 1400 | L | 14.7 / 33.4 / 31.2 | 3.0 / 10.3 / 8.9 | 2.8 / 7.7 / 11.0 | 34.6 / 555.0 / 541.3 | 11.11 |
| 200 | M | 5.3 / 193.6 / 33.6 | 1.6 / 8.7 / 9.1 | 2.4 / 6.7 / 7.5 | 14.9 / 429.2 / 529.5 | 2.78 |
| 400 | M | 7.9 / 32.6 / 32.7 | 2.0 / 9.9 / 9.3 | 2.2 / 7.4 / 7.6 | 20.8 / 485.7 / 569.8 | 4.56 |
| 600 | M | 12.9 / 35.2 / 34.1 | 2.4 / 9.3 / 9.4 | 2.2 / 7.0 / 8.1 | 22.0 / 467.6 / 583.3 | 6.17 |
| 800 | M | 22.9 / 33.2 / 32.2 | 2.7 / 9.3 / 8.9 | 2.8 / 6.7 / 11.3 | 29.6 / 471.5 / 565.6 | 7.95 |
| 1000 | M | 14.2 / 36.0 / 31.3 | 3.3 / 11.9 / 9.6 | 2.9 / 7.3 / 10.6 | 31.9 / 496.9 / 608.2 | 9.75 |
| 1400 | M | 18.9 / 33.6 / 30.6 | 1.9 / 10.9 / 9.2 | 2.7 / 7.5 / 10.4 | 36.3 / 549.7 / 638.8 | 13.71 |
| 200 | Q | 6.8 / 34.1 / 33.2 | 1.5 / 8.6 / 9.5 | 3.2 / 6.9 / 7.6 | 19.4 / 461.4 / 532.2 | 4.56 |
| 400 | Q | 12.0 / 32.1 / 32.0 | 1.8 / 9.0 / 8.9 | 2.1 / 6.9 / 7.9 | 21.4 / 417.3 / 489.0 | 6.35 |
| 600 | Q | 9.1 / 34.0 / 31.8 | 1.6 / 9.5 / 9.5 | 2.2 / 7.5 / 11.9 | 23.9 / 437.1 / 509.4 | 8.31 |
| 800 | Q | 13.9 / 33.8 / 30.9 | 3.1 / 10.1 / 8.6 | 2.8 / 7.5 / 10.6 | 32.7 / 465.1 / 535.9 | 10.81 |
| 1000 | Q | 18.0 / 35.4 / 32.2 | 2.1 / 12.2 / 9.9 | 2.7 / 7.8 / 10.4 | 37.9 / 501.0 / 532.7 | 13.23 |
| 1400 | Q | 37.1 / 33.5 / 30.7 | 3.5 / 10.5 / 8.5 | 3.5 / 8.1 / 10.4 | 49.6 / 501.3 / 530.5 | 19.88 |

### Goodput in file bytes per second (after 1.02× fountain overhead; header and Base45 costs are already outside the block size)

Goodput = fps × block size × per-frame success ÷ 1.02. For the receiver page engines, the frame rate is also capped at what the page can decode (1000 ÷ ms per frame). Computed by `tests/bench/goodput.mjs` from the measured rates and times above.

| Block | EC | QR ver. | 10 fps moderate: zbar / page zxing-wasm / page jsQR | 10 fps harsh: zbar / page zxing-wasm / page jsQR | 15 fps moderate: zbar / page zxing-wasm | 20 fps moderate: page zxing-wasm |
|---|---|---|---|---|---|---|
| 200 | L | 10 | 1961 / 1961 / 460 | 1829 / 1961 / 372 | 2941 / 2941 | 3922 |
| 400 | L | 14 | 3890 / 3922 / 840 | 165 / 3922 / 541 | 5835 / 5882 | 7843 |
| 600 | L | 18 | 5882 / 5882 / 1280 | 0 / 5490 / 0 | 8824 / 8824 | 11765 |
| 800 | L | 20 | 7843 / 7843 / 1780 | 0 / 4183 / 0 | 11765 / 11765 | 15686 |
| 1000 | L | 23 | 9804 / 9804 / 0 | 0 / 0 / 0 | 14706 / 14706 | 19608 |
| 1400 | L | 28 | 12586 / 13725 / 82 | 0 / 0 / 0 | 18879 / 20588 | 27451 |
| 200 | M | 11 | 1961 / 1961 / 457 | 1749 / 1961 / 370 | 2941 / 2941 | 3922 |
| 400 | M | 16 | 3922 / 3922 / 807 | 0 / 3922 / 551 | 5882 / 5882 | 7843 |
| 600 | M | 20 | 5882 / 5882 / 1258 | 0 / 5294 / 0 | 8824 / 8824 | 11765 |
| 800 | M | 23 | 7843 / 7843 / 1663 | 0 / 0 / 0 | 11765 / 11765 | 15686 |
| 1000 | M | 27 | 8902 / 9804 / 66 | 0 / 0 / 0 | 13353 / 14706 | 19608 |
| 1400 | M | 32 | 11557 / 13725 / 0 | 0 / 0 / 0 | 17335 / 20588 | 27451 |
| 200 | Q | 13 | 1961 / 1961 / 425 | 1553 / 1961 / 356 | 2941 / 2941 | 3922 |
| 400 | Q | 19 | 3922 / 3922 / 940 | 0 / 3791 / 27 | 5882 / 5882 | 7843 |
| 600 | Q | 24 | 5835 / 5882 / 1346 | 0 / 0 / 0 | 8753 / 8824 | 11765 |
| 800 | Q | 28 | 7059 / 7843 / 112 | 0 / 0 / 0 | 10588 / 11765 | 15686 |
| 1000 | Q | 32 | 7676 / 9804 / 0 | 0 / 0 / 0 | 11515 / 14706 | 19608 |
| 1400 | Q | 38 | 4118 / 13725 / 0 | 0 / 0 / 0 | 6176 / 20588 | 27451 |

## Recommended settings

These come from the synthetic degradations above, not from phone cameras, which were **not tested**. Use them as a starting point.

| Situation | Block size | EC | Sender fps | Expected goodput* | Why |
|---|---|---|---|---|---|
| **Default (shipped)** | 400 B | M | 8 | ≈ 3.1 KB/s | Version 16 with about 6.7 px/module at 600 px. The page's zxing-wasm decoded 100% of moderate *and* harsh frames in about 7 ms each. Leaves a wide margin. |
| Good light, steady phone, close range | 800 B (L) or 600 B (M) | L / M | 10 | ≈ 6–8 KB/s | 100% on moderate frames. Harsh frames still 63% (800 L) and 90% (600 M), which the fountain code absorbs. |
| Best case (screen fills camera view) | 1000–1400 B | L / M | 10–15 | ≈ 10–20 KB/s | 100% on moderate frames with zxing (native or wasm), but **0% on harsh**. Only works when the code is large in the camera image. |
| Difficult (far, shaky, glare, old phone) | 200 B | any | 6–10 | ≈ 1.2–2 KB/s | The only density that survived harsh frames with every decoder (zbar 88–92%, zxing 100%, jsQR 97–100%). |
| Receiver forced to jsQR | 200–400 B | M | ≤ 3 | ≈ 0.5–1 KB/s | jsQR needs its blur retry on noisy frames, which costs about 400 ms per frame (≈ 2.4 frames/s). It fails at 1000 B and up even on moderate frames. |

\*Goodput = fps × block size × per-frame success ÷ 1.02, assuming the receiver keeps up. On a real camera, exposure blending and rolling shutter will lose some frames. The fountain code tolerates loss, so the cost is time, not failure. At 50% loss, goodput halves.

Findings behind the table:

1. **Module size matters more than the EC level.** At a fixed block size, a higher EC level needs a bigger QR version and so smaller modules. On harsh frames, 600 B at **L** (v18) decoded 93–97% while 600 B at **Q** (v24) decoded 0%. Use L or M; Q and H only help with partial occlusion such as a glare spot, which this benchmark does not model.
2. **zxing-cpp beats zbar on degraded frames.** At 400 B on harsh frames, zbar decoded 0–5% while zxing-cpp and zxing-wasm decoded 93–100%. That is why the receiver page's default engine, when no native `BarcodeDetector` exists, is zxing-wasm and not jsQR.
3. **Sender fps vs. camera fps.** The page decodes a frame in about 7 ms, so the decoder is not the limit. The camera is. For a 30 fps camera, keep the sender at **≤ 10 fps** (one third of the camera rate) so each QR is held for at least about 3 camera frames. 15 fps and up is likely to show blended or torn frames. This is unmeasured.
4. **Encoding cost.** The sender spends 2–17 ms per frame on QR encoding, depending on version, so 30 fps is achievable on the sending side.
5. **Fountain overhead.** With protocol v2, files of 100 KiB and up need ≈ 1.001–1.007× K packets, so goodput ≈ raw frame throughput. Small files (≈ 26 blocks) need ≈ 7–8% extra packets (worst trial 1.31×), as shown in RESULTS.md. (Protocol v1 measured 1.01–1.02× and 10–15%; the goodput table above still divides by the conservative overhead stated in its heading.)
