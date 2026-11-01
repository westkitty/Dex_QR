# Threat note: what an observer of the screen learns

**Model.** Anyone who can see the sender's screen, or record it with a camera, a screen recorder, a CCTV system or a person filming over your shoulder, receives exactly what the receiver receives. A QR stream is a broadcast. There is no pairing and no back channel, and the sender cannot tell who is reading.

## Without a passphrase

An observer who captures enough frames, roughly K × 1.01–1.15 distinct frames (see RESULTS.md), **gets the whole file**, including its name and MIME type. Capture does not need to be continuous: any sufficient subset of frames, in any order, from any part of the stream will do. Even partial capture leaks something:

- **From a single frame:** that this is a Dex_QR transfer (the `DQ` prefix and fixed header), whether it was compressed (flag bit 1), the exact payload size F (file size + 7 bytes + the lengths of the file name and MIME type, so about 45 bytes for a typical name; with compression, the compressed size + 9 bytes), the block size T, the block count K, and the file ID.
- **The file ID** is SHA-256(payload)[0..8]. Someone who already has a candidate file can confirm that it is the one being sent, without capturing the whole stream.
- **From timing:** when the transfer happened and how long it ran.
- **From fewer than K frames:** the observer cannot rebuild the file in general. Degree-1 packets carry raw source blocks, though, and linear combinations of few blocks can reveal fragments. Treat a partial capture as a **partial disclosure** of the plaintext, not as zero disclosure.

## With a passphrase (AES-256-GCM, key from PBKDF2-HMAC-SHA-256 with 600,000 iterations)

- **Still visible:**
  - that it is a Dex_QR transfer, and that it is encrypted (header flag)
  - the payload size (the plaintext payload size + 52 bytes, where "plaintext payload" is the compressed container when compression was used), T, K and the timing
  - the file ID, but this is now a hash of the **ciphertext**. A fresh random salt and IV per send make it useless for confirming a guessed file or linking two sends of the same file.
- **Hidden:** the file contents, the file name and the MIME type, because all of them are inside the ciphertext. Whether the payload was compressed is hidden too (header flag bit 1 is never set on encrypted streams).
- **Compression length leak (cycle 2).** The sender compresses before it encrypts, so the visible payload size is the *compressed* size. That reveals how compressible the file is: a 76 KB CSV log shows up as about 13 KB, while a 21 KB JPEG stays 21 KB. An observer who can guess candidate files can compare their compressed sizes with the observed one, which narrows the guess. Attacks of the CRIME/BREACH kind need an attacker who can inject chosen text next to a secret and watch many sizes; Dex_QR sends one file once with no attacker input, so that does not apply directly, but the size is still a fingerprint. If the size itself is sensitive, untick "Compress when it helps" on the sender (the stream is then exactly as before, and its size reveals only the file length, as described above).
- **Still possible:** an observer who records enough frames gets the **complete ciphertext** and can run an **offline passphrase-guessing attack** at their own pace. Nothing limits the number of attempts. PBKDF2 makes each guess cost 600,000 HMAC-SHA-256 operations, but it is not memory-hard, so GPU farms speed it up a lot (OWASP recommends Argon2id first, and WebCrypto does not offer it). Security therefore rests almost entirely on **passphrase entropy**:
  - Use at least 5–6 random diceware words, or 16 or more random characters. The page's strength hint is a rough heuristic, not a guarantee.
  - A human-chosen or reused password, or one under about 50 bits, should be assumed crackable by a motivated adversary.
  - Share the passphrase out of band: say it aloud away from cameras, or type it on the receiver. Never show it on the same screen as the stream.
- **Integrity:** AES-GCM authenticates the payload, so tampered or forged frames cannot produce a file that decrypts. Without a passphrase, the 64-bit SHA-256 prefix (the file ID) catches accidental corruption and inconsistent streams. It does **not** stop an attacker who can show you their own stream with its own matching file ID. Check the SHA-256 shown on both pages if that matters.

## Other notes

- **Physical side channels:** the screen's light can be filmed from a distance, through windows and in reflections. Plan as if every frame is seen.
- **Network:** the pages make no network requests. A Content-Security-Policy with `connect-src 'none'` enforces this, and the automated tests check it: 0 requests outside `file:`, `data:` and `blob:`. The receiver uses the camera only after you press "Start camera", and stops it when the transfer completes.
- **Nothing is stored:** received packets, partial progress and the rebuilt file live only in the page's memory. Nothing is written to localStorage, IndexedDB or disk until you press Save. Closing or reloading the receiver loses partial progress (the page asks first). Resuming across reloads was considered and left out, because it would leave fragments of the file on disk by default.
- **Hostile frames:** a code shown to the receiver can carry any header with a valid CRC. The receiver rejects headers beyond its resource limits (PROTOCOL.md §4), never switches transfers without a click, and verifies the file ID (and the AES-GCM tag when encrypted) before offering a download. A compressed payload is never inflated beyond its declared size or 32 MiB + 4 KiB, whichever is smaller, so a small stream cannot expand into a memory bomb.
- **What you trust:** the HTML file you open. Verify its SHA-256 against the repository, or build it yourself with `npm run build`, before using it for anything sensitive.
