# Real-camera test checklist (for you to run)

**Not yet tested:** scanning with a real phone camera or a real laptop webcam. All automated tests used rendered images, H.264 video, or Chrome's fake camera fed from a video file (see RESULTS.md). Please run the checks below, note the results, and report them. Each check takes a minute or two.

**Setup:**
1. Open `sender.html` on the screen device and `receiver.html` on the camera device.
   - Desktop browsers can open them as local files.
   - On a phone, copy the file over and open it in Chrome or Safari. Some mobile browsers block the camera on `file://`. If yours does, serve the folder with `python3 -m http.server` on localhost.
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

**Early passphrase check (cycle 3)**
- [ ] Sender with a passphrase and "Let the receiver check the passphrase early" ticked. On the receiver, type a wrong passphrase while scanning and press Check passphrase: "Wrong passphrase" should appear within a few seconds and the Decoded count keeps rising. Then the right one: "matches", and the file opens by itself at the end.
- [ ] The key-check frame is a much smaller QR code (version 3) than the data frames. Check that the camera reads it at the same distance, and that the size change every 32 frames does not upset autofocus.

**Robustness**
- [ ] Start the receiver halfway through the stream. It should still complete, since the stream has no start.
- [ ] Look away for 5–10 seconds, then come back. It should continue where it left off.
- [ ] Encryption: transfer with a passphrase, type a wrong one first (expect "Wrong passphrase"), then the right one.
- [ ] Two senders visible at once, or switching files mid-stream: the receiver should stick to the first transfer and count the others as "from other transfers".

**Added in the 2026-11-01 pass (also untested on real devices)**
- [ ] Sender at 8 fps: the "Frames sent" line shows about 8.0 fps actual. On a 60 Hz phone it may read a little lower if the device is slow; note the value.
- [ ] Screen stays on: start a long transfer, put the sender phone down and do not touch it for 2 minutes. The screen should not dim or lock (Wake Lock API; Chrome and recent Safari have it). Do the same on the receiver while the camera runs.
- [ ] Full screen on iPhone Safari: press Full screen. The code should fill the page (in-page mode, since Safari has no element Fullscreen API on iPhone), with Pause and Exit buttons under it.
- [ ] Deny the camera permission once: the receiver should explain how to allow it, and Start camera should work after you allow it in site settings.
- [ ] Re-prepare the sender with a different passphrase mid-transfer: within a few seconds the receiver should offer "Switch to the new transfer", and switching should complete without starting over.
- [ ] Switch cameras from the menu while scanning (laptop with two cameras, or front/back on a phone): exactly one camera light, scanning continues.
- [ ] Reload the receiver mid-transfer: the browser should ask before leaving.

**Decoder comparison (receiver "QR decoder" menu)**
- [ ] Auto (BarcodeDetector if the browser has it, which Android Chrome and macOS browsers usually do), compared with zxing-cpp and with jsQR. Note which is fastest and most reliable for you. jsQR was much weaker on noisy frames in the synthetic tests.

**Record your results** as a small table: device, browser, decoder, block size, EC level, fps, distance, light, seconds to complete, and OK or FAIL.

**Key stretching and strength meter (cycle 4)**
- [ ] On the sender laptop, prepare with a passphrase and "Tuned to this device": note the iteration count and the "about X s here" figure on the Encrypted line.
- [ ] On the phone receiver, note how long "Check passphrase" (or the final decrypt) takes with that count. If it is much more than a few seconds, repeat with "Standard: 600,000" and record both.
- [ ] Type a few passphrases into the sender (e.g. `Summer2024!`, five random words) and confirm the meter text is announced by a screen reader and never repeats the passphrase.

**Scan coaching and slow-passphrase warning (cycle 7, also untested on real devices)**
- [ ] Cover the lens or point at a dark corner: within about 2 s the hint under the camera view says "Too dark to read".
- [ ] Point at a plain wall: "The view is almost plain". Point at any other QR code (a menu, a URL): "not a Dex_QR stream".
- [ ] Hold the phone too close for focus (5 cm): note whether it says "blurry", "cut off" or "not reading". Then too far (2 m): note whether it says "small" or "No code found". The thresholds were set on synthetic frames; write down any hint that is wrong for what you see.
- [ ] Shine a lamp onto the sender's screen: note whether "Too bright or there is glare" appears.
- [ ] While receiving normally: "Locked on" and near the end "Almost there"; pause the sender: "Only repeats are arriving" within about 2 s.
- [ ] With a screen reader (VoiceOver or TalkBack): hint changes are read out, not more than once every few seconds, and do not interrupt.
- [ ] Encrypted transfer with "Tuned to this device" key stretching from a fast laptop, received on an older phone: a "Heads-up: this device needs about N seconds" note appears above the passphrase box before typing. Time the real check and note it next to N.

**Done confirmation (cycle 9)**
- [ ] After a transfer completes, the receiver's camera area shows a small "Done" code. On the sender (laptop with a webcam), press **Confirm with camera**, allow the camera, and hold the receiver phone's screen 15–40 cm from the webcam. Note the time until the sender turns green ("Done: the receiver confirmed it") and whether glare on the phone screen or the webcam's mirror image matters.
- [ ] Show the sender the Done code of a *different* transfer (finish a second, unrelated transfer on another receiver): the sender must say it is for a different transfer and stay unconfirmed.
- [ ] Deny the camera permission on the sender: it must say so and "Receiver done: stop" must still work. On a device without a camera, "Confirm with camera" must not appear.
