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
- **Key-check frames (cycle 3).** With the early check on (the default), every 32nd frame carries the salt, the iteration count and a 2-byte key check value (KCV) derived from the PBKDF2 key with HKDF under its own label. What that changes for an attacker:
  - **Work per guess: unchanged.** Every guess still costs one full PBKDF2 run (600,000 HMAC-SHA-256). Checking the KCV afterwards is one cheap HKDF, about as cheap as checking the AES-GCM tag; the KCV makes no guess faster.
  - **Capture needed to start: much less.** Before, an attacker needed the whole ciphertext (about K frames) to test a guess. Now one key-check frame is enough to *filter* guesses. 16 bits cannot confirm one: of N wrong candidates about N / 65,536 still pass, so a weak passphrase from a space of 2^30 leaves about 16,000 candidates that still need the full ciphertext to tell apart. For a strong passphrase (60+ bits) this changes nothing in practice; for a weak one it means an attacker who filmed a few seconds can do most of the cracking work and keep a short list.
  - **Why 2 bytes.** Longer would only matter for false accepts on the receiver (1 in 65,536, and AES-GCM catches those at the end) and would make the KCV a stronger confirmation oracle. Shorter (1 byte) would let 1 wrong passphrase in 256 pass the early check.
  - **Forged key frames** can make a receiver say "wrong passphrase" for the right one or "matches" for a wrong one (they cannot make it accept a wrong file: AES-GCM decides at the end). Showing a forged stream is already possible, so this adds no new capability; the receiver also turns the early check off when two different key frames claim one transfer, and ignores a cached key whose salt does not match the payload.
  - **To avoid it:** untick "Let the receiver check the passphrase early" on the sender. The stream is then exactly the pre-cycle-3 format.
- **Integrity:** AES-GCM authenticates the payload, so tampered or forged frames cannot produce a file that decrypts. Without a passphrase, the 64-bit SHA-256 prefix (the file ID) catches accidental corruption and inconsistent streams. It does **not** stop an attacker who can show you their own stream with its own matching file ID. Check the SHA-256 shown on both pages if that matters.

## Other notes

- **Physical side channels:** the screen's light can be filmed from a distance, through windows and in reflections. Plan as if every frame is seen.
- **Network:** the pages make no network requests. A Content-Security-Policy with `connect-src 'none'` enforces this, and the automated tests check it: 0 requests outside `file:`, `data:` and `blob:`. The receiver uses the camera only after you press "Start camera", and stops it when the transfer completes.
- **Nothing is stored:** received packets, partial progress and the rebuilt file live only in the page's memory. Nothing is written to localStorage, IndexedDB or disk until you press Save. Closing or reloading the receiver loses partial progress (the page asks first). Resuming across reloads was considered and left out, because it would leave fragments of the file on disk by default.
- **Hostile frames:** a code shown to the receiver can carry any header with a valid CRC. The receiver rejects headers beyond its resource limits (PROTOCOL.md §4), never switches transfers without a click, and verifies the file ID (and the AES-GCM tag when encrypted) before offering a download. A compressed payload is never inflated beyond its declared size or 32 MiB + 4 KiB, whichever is smaller, so a small stream cannot expand into a memory bomb.
- **What you trust:** the HTML file you open. Verify its SHA-256 against the repository, or build it yourself with `npm run build`, before using it for anything sensitive.

## Addendum 2026-11-01 (cycle 4)
- **Work per guess is now tuned to the sender's device:** about 1 s there, 600,000–8,000,000 iterations, so each offline guess costs up to about 13× what it did with the fixed 600,000. This is a constant factor; it does not replace a strong passphrase, and PBKDF2 is still not memory-hard.
- **Receiver cost:** the receiver derives the key once with the sender's count. A slow phone may take several seconds; "Standard" keeps 600,000. A forged stream cannot ask for more than 10,000,000 iterations.
- **Strength meter:** runs locally in the page on each keystroke; the passphrase is never stored or sent, and the warnings are generic (they never quote parts of it, since the sender screen may be filmed). It estimates guesses for common human patterns; it cannot know whether a passphrase is reused or leaked elsewhere.

## Addendum 2026-11-01 (cycle 9): the Done code
- **What it reveals:** the receiver's Done code carries the transfer's 8-byte file ID and a CRC, nothing else. The file ID is already in every stream frame, so someone who films the Done code learns only that this receiver finished this transfer (and when).
- **It is not proof:** anyone who has seen one stream frame can build a valid Done code for that transfer, and a CRC is not a signature. The sender's "Confirmed" is a convenience, the same trust as "the receiver says Done"; the real check is still the SHA-256 the receiver shows, compared with the sender's.
- **Camera:** the sender's camera turns on only when you press "Confirm with camera", looks at most 2 minutes, and stops as soon as the code is read, on "Stop the camera", "Receiver done: stop" or "Send another file". Frames are decoded in the page and never stored.
