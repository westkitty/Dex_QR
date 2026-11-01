# Real-camera test checklist (for you to run)

**Not yet tested:** scanning with a real phone camera or a real laptop webcam. All automated tests used rendered images, H.264 video, or Chrome's fake camera fed from a video file (see RESULTS.md). Please run the checks below, note the results, and report them. Each check takes a minute or two.

**Setup:**
1. Open `sender.html` on the screen device and `receiver.html` on the camera device.
   - Desktop browsers can open them as local files.
   - On a phone, copy the file over and open it in Chrome or Safari. Some mobile browsers block the camera on `file://`. If yours does, use the GitHub Pages copy or `python3 -m http.server` on localhost.
2. Use a test file of about 100 KB and note its SHA-256 from the sender page. Success means the receiver shows the same SHA-256 and saves the file.
3. For each check, note the browser, the device, the decoder shown on the receiver ("BarcodeDetector" or "zxing-cpp"), the time to complete, and the "Packets" line (unique, duplicate, rejected).

## Checks

**Basics**
- [ ] The camera starts. The browser asks for permission. The back camera is chosen on phones, and the camera list works.
- [ ] Defaults (400 B, EC M, 8 fps, fit to screen), phone held still about 30 cm away: the transfer completes and the SHA-256 matches.

**Distance and size**
- [ ] 15 cm, 30 cm, 60 cm and 1 m with the default settings. Find where it stops working.
- [ ] Module size: set the sender's "Module size" to 2, 4 and 8 px. Smaller QR codes on screen need the camera closer.

**Density (QR version)**
- [ ] Block size 200, 400, 600, 1000 and 1400 at EC M. Find the densest setting that still reads reliably at 30 cm. Dense codes need more pixels per module on the camera sensor.

**Speed and screen refresh**
- [ ] 4, 8, 12, 15, 20 and 30 fps at 400 B. Watch whether "unique packets" keeps rising or stalls. Cameras run at 30 fps (sometimes 24 or 60). If the sender's rate gets near the camera's, frames blend or tear, and decoding drops sharply. Expect the useful limit to be around a third to a half of the camera frame rate.
- [ ] Look for rolling-shutter tearing: half of one code and half of the next in one image. Lowering the fps fixes it.
- [ ] Flicker and banding: screen PWM dimming at low brightness can cause dark bands on camera. Test at 30%, 60% and 100% brightness.
- [ ] Moiré: holding the camera very close to a high-DPI screen can cause interference patterns. Move back or increase the module size.

**Lighting**
- [ ] A dim room, a normally lit room, and a window or sunlight behind you.
- [ ] Glare: tilt the screen so a light source reflects in it, then tilt it back. Matte screens behave better.
- [ ] Dark mode or night-light filters on the sender (they should not affect the white canvas, but check).

**Focus and motion**
- [ ] Phone on a stand or propped up, compared with hand-held. Hand-held shake causes motion blur at low light. Note the difference in time.
- [ ] Autofocus hunting at very close range. Tap to focus if the browser allows it.

**Robustness**
- [ ] Start the receiver halfway through the stream. It should still complete, since the stream has no start.
- [ ] Look away for 5–10 seconds, then come back. It should continue where it left off.
- [ ] Encryption: transfer with a passphrase, type a wrong one first (expect "Wrong passphrase"), then the right one.
- [ ] Two senders visible at once, or switching files mid-stream: the receiver should stick to the first transfer and count the others as "from other transfers".

**Decoder comparison (receiver "QR decoder" menu)**
- [ ] Auto (BarcodeDetector if the browser has it, which Android Chrome and macOS browsers usually do), compared with zxing-cpp and with jsQR. Note which is fastest and most reliable for you. jsQR was much weaker on noisy frames in the synthetic tests.

**Record your results** as a small table: device, browser, decoder, block size, EC level, fps, distance, light, seconds to complete, and OK or FAIL.
