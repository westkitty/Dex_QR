/* Dex_QR receiver page logic. Original code, MIT License. */
(function () {
  "use strict";
  const DQ = window.DexQR;
  const $ = (id) => document.getElementById(id);
  const MAX_SIDE = 1080;                         // downscale large camera frames before decoding
  const RESET_CONFIRM_MS = 5000;                 // how long the "press again to discard" state lasts
  const state = {
    session: new DQ.ReceiverSession(), stream: null, running: false, frames: 0, detector: null, engine: null, decoderName: "",
    result: null, error: null, phase: "idle", opened: false, opening: false, busyFiles: false, resultUrl: null,
    videoPoll: null, wakeLock: null, resetArmed: 0, scanGen: 0, startToken: 0,
    keyState: "", pendingCheck: false, checking: false, checkToken: 0, passOffered: null,
  };
  window.__dexqrReceiver = state;                 // read-only hook for automated tests
  const UI = window.DexUI;
  const map = new window.DexBlockMap($("blockmap"), UI);
  state.blockMap = map;                           // read-only hook for automated tests
  const coach = new DQ.coach.ScanCoach();
  state.coach = coach;                            // read-only hook for automated tests
  state.coachLog = [];                            // hints shown and announced (bounded), for automated tests

  function msg(text, cls) {
    const m = $("msg"); m.textContent = text || ""; m.className = "msg" + (text ? " show " + cls : "");
    // Errors interrupt (alert); progress and success messages are polite.
    m.setAttribute("role", cls === "err" ? "alert" : "status");
  }
  /* Phase drives the three-step strip (Scan, Receive, Save), the big button's label and the camera overlay. */
  const SCAN_PHASES = ["idle", "scanning", "no camera", "no Dex_QR codes found"];
  function setPhase(p) {
    state.phase = p; $("r-status").textContent = p;
    const step = p === "done" ? 2 : SCAN_PHASES.includes(p) && !state.session.meta ? 0 : 1;
    ["ph-scan", "ph-recv", "ph-save"].forEach((id, i) => {
      const el = $(id), done = i < step || (i === 2 && state.saved);
      el.className = done ? "done" : i === step ? "current" : "";
      if (i === step && !done) el.setAttribute("aria-current", "step"); else el.removeAttribute("aria-current");
    });
    $("start-text").textContent = hasPartial() && !state.running ? "Resume scanning" : "Start scanning";
    // Once the file is ready, saving it is the one primary action: the scan buttons step aside until Reset.
    $("scanbtns").hidden = p === "done";
    syncOverlay();
  }
  function syncOverlay() {
    const live = !!state.running;
    $("reticle").hidden = !live; $("camtag").hidden = !live;
    $("reticle").classList.toggle("scanning", live && !state.lockTimer);
    $("camtag-text").textContent = state.session.meta ? "Receiving" : "Looking for a Dex_QR code";
  }
  /* Brief lock-on (corners close in and turn green) each time a frame adds a new packet. */
  function lockPulse() {
    const r = $("reticle");
    r.classList.add("lock"); r.classList.remove("scanning");
    clearTimeout(state.lockTimer);
    state.lockTimer = setTimeout(() => { state.lockTimer = 0; r.classList.remove("lock"); syncOverlay(); }, 450);
  }
  function hasPartial() { return !!(state.session.meta && !state.opened); }

  // zxing-cpp compiled to WebAssembly (zxing-wasm), inlined as base64: no file or network fetch.
  let zxingReady = null;
  function loadZXing() {
    if (!zxingReady) {
      const b64 = window.DEXQR_ZXING_WASM_B64, bin = atob(b64), bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      zxingReady = window.ZXingWASM.prepareZXingModule({ overrides: { wasmBinary: bytes.buffer }, fireImmediately: true });
      zxingReady.catch(() => { zxingReady = null; });   // allow a retry instead of caching a failure
    }
    return zxingReady;
  }
  const ZX_OPTS = { formats: ["QRCode"], tryHarder: true, maxNumberOfSymbols: 1 };
  const ZX_OPTS_LIVE = { ...ZX_OPTS, returnErrors: true };            // camera: also report codes found but not read

  async function pickDecoder() {
    const want = $("dec").value;
    let detector = null, engine = null, name = "";
    if ((want === "auto" || want === "native") && "BarcodeDetector" in window) {
      try {
        const fmts = await window.BarcodeDetector.getSupportedFormats();
        if (fmts.includes("qr_code")) { detector = new window.BarcodeDetector({ formats: ["qr_code"] }); engine = "native"; name = "BarcodeDetector (browser built-in)"; }
      } catch (e) { /* fall through */ }
    }
    if (!engine) {
      if (want === "native") throw new Error("This browser has no BarcodeDetector with QR support. Choose “auto” or “zxing-cpp” under “Camera, decoder and file input”.");
      if (want === "jsqr") { engine = "jsqr"; name = "jsQR"; }
      else { await loadZXing(); engine = "zxing"; name = "zxing-cpp (WebAssembly)"; }
    }
    state.detector = detector; state.engine = engine; state.decoderName = name;
    $("r-dec").textContent = name;
  }

  /* Decode RGBA ImageData with the chosen engine (also used by the automated benchmark). */
  async function decodeImageData(img, engine) {
    if (engine === "jsqr") return DQ.scan.decodeImageData(img.data, img.width, img.height, window.jsQR).texts;
    await loadZXing();
    const res = await window.ZXingWASM.readBarcodes(img, ZX_OPTS);
    return res.filter((r) => r.isValid).map((r) => r.text);
  }
  state.decodeImageData = decodeImageData;

  const canvas = $("work");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  /* Where the decoder saw codes: count located (read or not), size of the largest as a share of the frame's
   * shorter side, and whether it touches the frame edge. Used only for scan coaching. */
  function codeGeometry(quads, w, h) {
    let box = 0, edge = false;
    const m = 0.015 * Math.min(w, h);
    for (const q of quads) {
      const xs = q.map((p) => p.x), ys = q.map((p) => p.y);
      const side = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / Math.min(w, h);
      if (side > box) box = side;
      if (Math.min(...xs) < m || Math.min(...ys) < m || Math.max(...xs) > w - m || Math.max(...ys) > h - m) edge = true;
    }
    return { found: quads.length, box: quads.length ? box : null, edge };
  }
  const corners = (p) => [p.topLeft, p.topRight, p.bottomRight, p.bottomLeft].filter(Boolean);
  async function decodeSource(src, w, h) {
    const live = !!state.stream;                                         // camera frames also feed the coach
    state.frameInfo = null;
    if (state.engine === "native") {
      const codes = await state.detector.detect(src);
      if (live) state.frameInfo = { ...codeGeometry(codes.filter((c) => c.cornerPoints && c.cornerPoints.length).map((c) => c.cornerPoints), w, h), img: null };
      return codes.map((c) => c.rawValue);
    }
    const s = Math.min(1, MAX_SIDE / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s));
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    ctx.drawImage(src, 0, 0, cw, ch);
    const img = ctx.getImageData(0, 0, cw, ch);
    if (!live) return decodeImageData(img, state.engine);
    if (state.engine === "jsqr") {
      const r = DQ.scan.decodeImageData(img.data, cw, ch, window.jsQR);
      state.frameInfo = { ...codeGeometry(r.location ? [corners({ topLeft: r.location.topLeftCorner, topRight: r.location.topRightCorner, bottomRight: r.location.bottomRightCorner, bottomLeft: r.location.bottomLeftCorner })] : [], cw, ch), img };
      return r.texts;
    }
    // zxing-cpp: also return codes it located but could not read, so the coach can tell "in view, not reading".
    await loadZXing();
    const res = await window.ZXingWASM.readBarcodes(img, ZX_OPTS_LIVE);
    state.frameInfo = { ...codeGeometry(res.filter((r) => r.position).map((r) => corners(r.position)), cw, ch), img };
    return res.filter((r) => r.isValid).map((r) => r.text);
  }

  /* Live scan coaching (cycle 7): one calm hint under the camera view, from what this frame looked like and what
   * the decoder and the session made of it. Frame statistics are measured at most every STATS_MS. */
  const STATS_MS = 120, COACH_LOG_MAX = 200;
  const sctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  function measureFrame(info, v) {
    if (info && info.img) return DQ.coach.frameStats(info.img.data, info.img.width, info.img.height);
    if (!v || !v.videoWidth) return null;                                // BarcodeDetector path: a small copy
    const s = Math.min(1, 640 / v.videoWidth), cw = Math.round(v.videoWidth * s), ch = Math.round(v.videoHeight * s);
    if (sctx.canvas.width !== cw || sctx.canvas.height !== ch) { sctx.canvas.width = cw; sctx.canvas.height = ch; }
    sctx.drawImage(v, 0, 0, cw, ch);
    return DQ.coach.frameStats(sctx.getImageData(0, 0, cw, ch).data, cw, ch);
  }
  function coachFrame(before) {
    if (!state.stream || !state.running) return;
    const s = state.session, st = s.stats, info = state.frameInfo || { found: 0, box: null, edge: false };
    const t = performance.now();
    let stats = null;
    if (t - (state.statsAt || 0) >= STATS_MS) { state.statsAt = t; try { stats = measureFrame(info, $("video")); } catch (e) { stats = null; } }
    const p = s.decoder ? s.decoder.progressCount / s.decoder.K : 0;
    const texts = st.qrTexts - before.qrTexts;
    const h = coach.push({ t, stats, found: Math.max(info.found, texts), decoded: texts, ours: (st.accepted - before.accepted) + (st.duplicates - before.duplicates) + (st.keyFrames - before.keyFrames) + (st.otherFile - before.otherFile),
      fresh: (s.decoder ? s.decoder.received : 0) - before.received, foreign: st.foreign - before.foreign, box: info.box, edge: info.edge, progress: p });
    showHint(h);
    const said = coach.announce(t);
    if (said) { $("coach-live").textContent = said; logCoach("said", h.id, t); }
  }
  function logCoach(kind, id, t) { state.coachLog.push({ kind, id, t: Math.round(t) }); if (state.coachLog.length > COACH_LOG_MAX) state.coachLog.shift(); }
  function showHint(h) {
    const el = $("coach");
    if (!h) { el.hidden = true; $("reticle").classList.remove("warn"); el.dataset.id = ""; return; }
    el.hidden = false;
    if (el.dataset.id === h.id) return;                                  // only touch the DOM when the hint changes
    el.dataset.id = h.id; el.className = "coach " + h.tone;
    $("coach-text").textContent = h.text;
    el.classList.remove("swap"); void el.offsetWidth; el.classList.add("swap");   // gentle fade-in (off with reduced motion)
    $("reticle").classList.toggle("warn", h.tone === "warn");
    logCoach("shown", h.id, performance.now());
  }
  function startCoach() { coach.reset(performance.now()); state.statsAt = 0; $("coach-live").textContent = ""; showHint(coach.hint()); }
  function stopCoach() { showHint(null); }

  function updateStats() {
    const s = state.session, p = s.progress(), st = s.stats;
    state.frames = st.frames;
    $("r-frames").textContent = `${st.frames} scanned, ${st.qrTexts} QR read`;
    $("r-dec").textContent = state.decoderName || "–";
    const bw = $("barwrap");
    if (!s.meta) {
      $("pct").textContent = "0%";
      $("blocks-sub").textContent = state.running ? "Looking for a Dex_QR code…" : "Waiting for the first code";
      bw.setAttribute("aria-valuenow", "0");
      bw.setAttribute("aria-valuetext", "nothing received yet");
      const bad = Object.entries(st.reasons).map(([k, v]) => `${v} ${k}`).join(", ");
      if (st.foreign || st.rejected) $("r-pk").textContent = `0 accepted; ignored: ${st.foreign} other QR codes${bad ? ", " + bad : ""}`;
      // Explain why nothing is happening when the camera sees codes that are not ours.
      if (state.running && !state.opening && !document.querySelector("#msg.err")) {
        if ((st.reasons.version || 0) >= 3) msg("This stream uses a Dex_QR protocol version this receiver does not support. Use the receiver page from the same release as the sender.", "warn");
        else if (st.foreign >= 5 && st.foreign > st.rejected) msg("The camera sees QR codes, but none is a Dex_QR stream.", "warn");
      }
      return;
    }
    $("r-id").textContent = s.meta.fileIdHex;
    $("r-enc").textContent = s.meta.encrypted ? "yes" : "no";
    $("r-zip").textContent = s.meta.encrypted ? "hidden inside the encryption" : s.meta.compressed ? "yes (unpacked after the last block)" : "no";
    updatePassUi();
    // Warn at the first frame, not after the whole scan, if this browser cannot unpack a compressed stream.
    if (s.meta.compressed && typeof DecompressionStream !== "function" && !state.warnedNoInflate) {
      state.warnedNoInflate = true;
      msg("This stream is compressed, but this browser has no DecompressionStream and will not be able to unpack it. Use a current Chrome, Edge, Firefox or Safari (16.4+), or ask the sender to untick “Compress” and press Prepare again.", "err");
    }
    const have = s.decoder.progressCount, pct = (100 * have) / p.K;
    $("r-prog").textContent = `${have} / ${p.K} (${pct.toFixed(1)}%), ${s.meta.length.toLocaleString()} bytes in transfer`;
    const ign = st.foreign ? `, ${st.foreign} other QR codes` : "";
    $("r-pk").textContent = `${p.received} unique, ${st.duplicates} duplicate, ${st.rejected} rejected, ${st.otherFile} from other transfers${ign}`;
    $("bar").style.width = pct.toFixed(1) + "%";
    $("pct").textContent = (have >= p.K ? 100 : Math.min(99, Math.floor(pct))) + "%";
    $("blocks-sub").textContent = `${have} of ${p.K} pieces · ${fmtBytes(s.meta.length)}${s.meta.encrypted ? " · encrypted" : ""}`;
    map.update(p.K, have, s.decoder.mode === "peel" ? s.decoder.known : null);
    bw.setAttribute("aria-valuenow", pct.toFixed(0));
    bw.setAttribute("aria-valuetext", `${have} of ${p.K} blocks decoded`);
    const sw = $("switchbox");
    if (s.otherTransferWaiting) {
      $("switchtext").textContent = `A different transfer (${s.pending.fileIdHex}) has been on screen for ${s.otherStreak} packets, and this one (${s.meta.fileIdHex}) has not. If the sender changed files or re-prepared, switch.`;
      sw.hidden = false;
    } else sw.hidden = true;
  }

  function fmtBytes(n) { return n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB" : (n / 1048576).toFixed(1) + " MB"; }

  /* Encrypted transfers: offer the passphrase box from the first packet, and say where the early check stands. */
  const fmtIter = (n) => Number(n || 0).toLocaleString("en-US");
  function keyText() {
    const s = state.session;
    if (!s.meta || !s.meta.encrypted) return "–";
    if (state.checking) return "checking…";
    if (s.keyCheckConflict) return "off: two different key-check frames seen (checked at the end instead)";
    if (state.keyState === "ok") return `✓ matches the sender's key check (PBKDF2 × ${fmtIter(state.checkIter)}, ${(state.checkMs / 1000).toFixed(1)} s here; final AES-GCM check at the end)`;
    if (state.keyState === "wrong") return "✗ does not match: wrong passphrase";
    if (state.pendingCheck) return "waiting for the sender's key-check frame";
    return s.keyCheck ? `key-check frame received (PBKDF2 × ${fmtIter(s.keyCheck.iterations)}${estText()}); enter the passphrase to check it` : "no key-check frame yet (older senders do not send one; then it is checked at the end)";
  }
  /* Slow-device warning (cycle 7): once the sender's iteration count is known (key-check frame), time a short
   * PBKDF2 probe here and, if deriving the key will take 3 s or more, say so before the passphrase is typed. */
  const fmtSecs = (ms) => (ms < 10000 ? (Math.round(ms / 500) / 2).toFixed(1).replace(/\.0$/, "") : String(Math.round(ms / 1000)));
  function estText() { const e = state.kdfEst; return e && state.session.keyCheck && e.iterations === state.session.keyCheck.iterations ? `; about ${fmtSecs(e.ms)} s on this device` : ""; }
  async function estimateKdf() {
    const s = state.session, it = s.keyCheck && s.keyCheck.iterations;
    if (!it || !s.meta || !s.meta.encrypted || state.opened || state.kdfFor === it) return;
    state.kdfFor = it;
    try {
      if (!state.kdfRate) { const e = await DQ.container.estimateDerive(it); if (!e.measured) return; state.kdfRate = e.msPerMillion; }
    } catch (e) { return; }
    if (state.session !== s || state.opened) return;
    const ms = (state.kdfRate * it) / 1e6, slow = ms >= DQ.container.SLOW_DERIVE_MS;
    state.kdfEst = { iterations: it, ms, slow };
    const box = $("passslow");
    if (slow) {
      box.textContent = `Heads-up: this device needs about ${fmtSecs(ms)} seconds to check the passphrase, because the sender chose strong protection (${fmtIter(it)} rounds of key stretching). Scanning keeps going while it works.`;
      box.hidden = false;
      // Say it once through the polite live region (the box is also the passphrase field's description), without
      // repeating it in the status message above.
      if (!$("pass").value && !state.checking) $("coach-live").textContent = box.textContent;
    } else { box.hidden = true; box.textContent = ""; }
    updatePassUi();
  }
  function updatePassUi() {
    const s = state.session;
    if (state.opened && state.result && state.result.encrypted) { $("r-key").textContent = "✓ AES-GCM authentication passed"; return; }
    if (!s.meta || !s.meta.encrypted || state.opened) { $("r-key").textContent = s.meta && !s.meta.encrypted ? "not needed" : "–"; return; }
    $("r-key").textContent = keyText();
    $("decrypt").textContent = s.done ? "Decrypt" : "Check passphrase";
    if (s.keyCheck && state.kdfFor !== s.keyCheck.iterations) estimateKdf();
    if ($("passbox").hidden) {
      $("passbox").hidden = false;
      if (state.passOffered !== s && !s.done) {
        state.passOffered = s;
        msg("This transfer is encrypted. You can enter the passphrase now; it is checked within seconds while scanning continues.", "warn");
      }
    }
  }

  /* Early check against the sender's key check value; never stops scanning or discards packets. */
  async function earlyCheck() {
    const sess = state.session;
    if (sess.done) return tryOpen();
    const pass = $("pass").value;
    if (!pass) { msg("Enter the passphrase first.", "warn"); $("pass").focus(); return; }
    const token = ++state.checkToken;
    state.keyState = ""; state.pendingCheck = false;
    if (!sess.keyCheck && !sess.keyCheckConflict) {
      state.pendingCheck = true; updatePassUi();
      msg("Passphrase noted. It is checked as soon as the sender's key-check frame is seen (one in every 32 frames). If the sender is an older version without key checks, it is checked when the scan completes.", "warn");
      return;
    }
    state.checking = true; updatePassUi();
    msg(`Checking the passphrase (PBKDF2, ${fmtIter(sess.keyCheck ? sess.keyCheck.iterations : 0)} iterations, as the sender chose${estText()})…`, "warn");
    let r;
    try { r = await sess.checkPassphrase(pass); }
    catch (e) { r = { result: "error", error: e }; }
    if (token !== state.checkToken || state.session !== sess) return;    // a newer check or a reset took over
    state.checking = false;
    if (sess.done && !state.opened) { updatePassUi(); return; }          // the scan finished meanwhile: tryOpen decides
    state.checkMs = r.ms || 0; state.checkIter = sess.derived ? sess.derived.iterations : 0;
    if (r.result === "ok") { state.keyState = "ok"; msg("✓ Passphrase matches the sender's key check. Keep scanning; the file opens by itself when the scan completes.", "ok"); }
    else if (r.result === "wrong") { state.keyState = "wrong"; msg("✗ Wrong passphrase: it does not match the sender's key check. Type it again; scanning continues and nothing received is lost.", "err"); $("pass").select(); $("pass").focus(); }
    else if (r.result === "conflict") msg("Two different key-check frames were seen for this transfer, so the early check is off. The passphrase will be checked when the scan completes.", "warn");
    else if (r.result === "pending") { state.pendingCheck = true; }
    else if (r.result === "error") msg("✗ Could not check the passphrase: " + ((r.error && r.error.message) || r.error), "err");
    updatePassUi();
  }

  function safeName(n) { n = String(n || "received.bin").replace(/[\\/\u0000-\u001f\u007f:*?"<>|]+/g, "_").replace(/^\.+/, "").slice(0, 200); return n || "received.bin"; }
  function revokeResult() { if (state.resultUrl) { URL.revokeObjectURL(state.resultUrl); state.resultUrl = null; } }

  async function tryOpen() {
    if (state.opening || state.opened || !state.session.done) return;   // one attempt at a time
    const sess = state.session;
    const pass = $("pass").value || undefined;
    state.opening = true; $("decrypt").disabled = true;
    setPhase(pass ? "decrypting" : "verifying");
    if (pass) msg(sess.derived && sess.derived.passphrase === pass ? "Decrypting with the key from the early check…" : `Deriving key (PBKDF2, ${sess.keyCheck ? fmtIter(sess.keyCheck.iterations) + " iterations" : "the sender's iteration count"}) and decrypting…`, "warn");
    try {
      const out = await sess.open(pass);
      if (state.session !== sess) return;                                // reset while we were working
      const hexs = Array.from(out.sha256, (b) => b.toString(16).padStart(2, "0")).join("");
      // Display SHA-256 of the received file content (what the sender page shows), not of the transfer payload.
      const fileSha = Array.from(await DQ.container.sha256(out.data), (b) => b.toString(16).padStart(2, "0")).join("");
      if (state.session !== sess) return;
      revokeResult();
      const blob = new Blob([out.data], { type: out.mime || "application/octet-stream" });
      const url = URL.createObjectURL(blob); state.resultUrl = url;
      const name = safeName(out.name);
      $("result").textContent = "";
      const a = document.createElement("a"); a.className = "dl"; a.href = url; a.download = name; a.id = "download"; a.textContent = `Save “${name}” (${out.data.length.toLocaleString()} bytes)`;
      const p = document.createElement("div"); p.className = "note mono-wrap"; p.textContent = `SHA-256 of file: ${fileSha}. Compare it with the sender page. Transfer checksum verified (${hexs.slice(0, 16)}…)${out.encrypted ? "; AES-GCM authentication passed" : ""}${out.compressed ? `; unpacked from ${out.compressedLength.toLocaleString()} compressed bytes (${out.compression})` : ""}.`;
      $("result").append(a, p);
      $("passbox").hidden = true; $("pass").value = "";
      state.result = { name, size: out.data.length, sha256: fileSha, encrypted: out.encrypted, compressed: out.compressed, usedCachedKey: !!out.usedCachedKey };
      state.error = null; state.opened = true; updatePassUi();
      a.addEventListener("click", () => { state.saved = true; setPhase("done"); });
      setPhase("done");
      celebrate();
      msg("✓ Transfer complete. The file is verified and ready to save.", "ok");
      a.focus();
    } catch (e) {
      if (state.session !== sess) return;
      state.error = e.code || e.message;
      if (e.code === "NEED_PASSPHRASE") { $("passbox").hidden = false; setPhase("needs passphrase"); msg("All data received. This transfer is encrypted: enter the passphrase.", "warn"); $("pass").focus(); }
      else if (e.code === "WRONG_PASSPHRASE") { state.keyState = "wrong"; $("r-key").textContent = "✗ wrong passphrase (AES-GCM authentication failed)"; $("passbox").hidden = false; $("decrypt").textContent = "Decrypt"; setPhase("wrong passphrase"); msg("✗ Wrong passphrase (AES-GCM authentication failed). Try again; no need to rescan.", "err"); $("pass").select(); $("pass").focus(); }
      else if (e.code === "TOO_LARGE") { setPhase("refused"); msg("✗ " + e.message + " Press Reset to scan something else.", "err"); }
      else if (e.code === "NO_DECOMPRESSION") { setPhase("cannot unpack"); msg("✗ " + e.message, "err"); }
      else if (e.code === "CHECKSUM_MISMATCH") { setPhase("checksum mismatch"); msg("✗ Checksum mismatch: the reconstructed data does not match the sender's SHA-256. Nothing was saved. Press Reset and scan again; if it repeats, the stream on screen is corrupted or forged.", "err"); }
      else { setPhase("error"); msg("✗ Could not open the transfer: " + e.message, "err"); }
    } finally {
      if (state.session === sess) { state.opening = false; $("decrypt").disabled = false; }
    }
  }

  function celebrate() {
    map.celebrate();
    const b = $("burst"); b.hidden = false; b.classList.remove("play");
    void b.offsetWidth;                                                  // restart the CSS animation
    b.classList.add("play");
  }

  async function onDecoded(texts) {
    const s = state.session;
    s.stats.frames++;
    const wasDone = s.done, before = s.decoder ? s.decoder.received : 0;
    for (const t of texts) s.addText(t);
    if (s.decoder && s.decoder.received > before && state.running) lockPulse();
    updateStats();
    if (state.pendingCheck && !state.checking && !s.done && (s.keyCheck || s.keyCheckConflict)) earlyCheck();
    if (s.done && !wasDone) { stopCamera(); stopVideoFile(); setPhase("verifying"); await tryOpen(); }
    else if (s.meta && !s.done && state.running) setPhase("receiving");
  }

  /* One scan loop per camera start or video file; a newer loop (scanGen) retires older ones. */
  function scanLoop(gen) {
    const v = $("video");
    const step = async () => {
      if (gen !== state.scanGen || !state.running || state.session.done) return;
      if (v.readyState >= 2 && v.videoWidth) {
        const st = state.session.stats, before = { qrTexts: st.qrTexts, accepted: st.accepted, duplicates: st.duplicates, keyFrames: st.keyFrames, otherFile: st.otherFile, foreign: st.foreign, received: state.session.decoder ? state.session.decoder.received : 0 };
        try { await onDecoded(await decodeSource(v, v.videoWidth, v.videoHeight)); }
        catch (e) { state.session.stats.frames++; state.frameInfo = null; }   // a bad frame: count it, keep going
        if (gen === state.scanGen && !state.session.done) coachFrame(before);
      }
      if (gen !== state.scanGen || !state.running || state.session.done) return;
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => step());
      else requestAnimationFrame(() => step());
    };
    step();
  }

  function cameraErrorText(e) {
    switch (e && e.name) {
      case "NotAllowedError": case "SecurityError": return "Camera permission was denied. Allow the camera for this page in the browser's site settings and press Start scanning again, or decode image or video files instead (under “Camera, decoder and file input”).";
      case "NotFoundError": case "OverconstrainedError": return "No camera was found" + ($("cam").value ? " with the selected device; choose “default”." : ". Connect one, or decode image or video files instead.");
      case "NotReadableError": case "AbortError": return "The camera is in use by another app or could not start. Close other apps using it and try again.";
      default: return "Camera error: " + ((e && e.message) || e);
    }
  }

  async function wake(on) {
    try {
      if (on && !state.wakeLock && navigator.wakeLock) { state.wakeLock = await navigator.wakeLock.request("screen"); state.wakeLock.addEventListener("release", () => { state.wakeLock = null; }); }
      else if (!on && state.wakeLock) { const l = state.wakeLock; state.wakeLock = null; await l.release(); }
    } catch (e) { /* best effort: not available on every browser or origin */ }
  }

  async function startCamera() {
    if (state.busyFiles) return;
    // Only the newest start wins: a quick second start (camera re-selected twice, say) retires the first,
    // which otherwise stopped the second one's stream in its error path and left no camera running.
    const token = ++state.startToken;
    msg("", "");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { msg("This browser does not offer camera access to this page. Chrome, Edge and Firefox allow it on file:// pages; some mobile browsers need the page served from http://localhost or https. You can still decode image or video files.", "err"); setPhase(hasPartial() ? "paused" : "no camera"); return; }
    $("start").disabled = true;
    let stream = null;
    try {
      await pickDecoder();
      if (token !== state.startToken) return;
      const devId = $("cam").value;
      const constraints = { audio: false, video: devId ? { deviceId: { exact: devId }, width: { ideal: 1280 }, height: { ideal: 720 } } : { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } } };
      stream = await navigator.mediaDevices.getUserMedia(constraints);
      if (token !== state.startToken) { stream.getTracks().forEach((t) => t.stop()); return; }
      stopCamera();                                                     // never hold two streams
      state.stream = stream;
      stream.getVideoTracks().forEach((t) => t.addEventListener("ended", () => {
        if (state.stream !== stream) return;
        stopCamera(); setPhase(hasPartial() ? "paused" : "idle");
        msg("The camera stopped (unplugged, or permission was revoked). Progress is kept; press Resume scanning to continue.", "err");
      }));
      const v = $("video"); v.removeAttribute("src"); v.srcObject = stream; await v.play();
      if (token !== state.startToken) return;                          // the newer start owns the camera now
      $("empty").hidden = true;
      state.running = true; $("start").disabled = true; $("stop").disabled = false;
      setPhase(state.session.meta ? "receiving" : "scanning");
      updateStats();
      startCoach();
      wake(true);
      listCameras();
      scanLoop(++state.scanGen);
    } catch (e) {
      if (token !== state.startToken) { if (stream && state.stream !== stream) stream.getTracks().forEach((t) => t.stop()); return; }
      stopCamera();
      msg(cameraErrorText(e), "err"); setPhase(hasPartial() ? "paused" : "idle");
    }
  }

  function stopCamera() {
    const wasStream = !!state.stream;
    if (wasStream) { state.running = false; state.scanGen++; state.stream.getTracks().forEach((t) => t.stop()); state.stream = null; }
    const v = $("video"); if (v.srcObject) { v.srcObject = null; }
    if (wasStream) { $("empty").hidden = false; wake(false); }
    stopCoach();
    $("start").disabled = state.busyFiles; $("stop").disabled = true;
    syncOverlay();
  }

  async function listCameras() {
    try {
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
      const sel = $("cam"), cur = sel.value;
      sel.textContent = "";
      const add = (value, label) => { const o = document.createElement("option"); o.value = value; o.textContent = label; sel.append(o); };
      add("", "default (back camera if any)");
      devs.forEach((d, i) => add(d.deviceId, d.label || "camera " + (i + 1)));
      sel.value = devs.some((d) => d.deviceId === cur) ? cur : "";
    } catch (e) { /* ignore */ }
  }

  function stopVideoFile() { if (state.finishVideo) state.finishVideo(); }

  async function decodeFiles(input) {
    const files = Array.from(input.files || []);
    input.value = "";                                                   // the same files can be picked again
    if (!files.length || state.busyFiles) return;
    if (state.session.done) { msg("This transfer is already complete. Press Reset to receive another.", "warn"); return; }
    stopCamera();
    state.busyFiles = true; input.disabled = true; $("start").disabled = true;
    msg("", "");
    try {
      await pickDecoder();
      const list = files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      setPhase("decoding files");
      for (const f of list) {
        if (state.session.done) break;
        if (f.type.startsWith("video/")) { await decodeVideoFile(f); continue; }
        let bmp = null;
        try {
          bmp = await createImageBitmap(f);
          await onDecoded(await decodeSource(bmp, bmp.width, bmp.height));
        } catch (e) { state.session.stats.frames++; updateStats(); }
        finally { if (bmp && bmp.close) bmp.close(); }
      }
      if (!state.session.done) {
        const s = state.session;
        setPhase(s.meta ? "incomplete" : "no Dex_QR codes found");
        msg(s.meta ? "Not enough frames to rebuild the file yet. Add more frames or scan the live stream; progress is kept." : (s.stats.qrTexts ? "Those files contain QR codes, but none from a Dex_QR stream." : "No QR codes were found in those files."), "warn");
      }
    } catch (e) {
      msg("✗ " + e.message, "err"); setPhase(hasPartial() ? "paused" : "idle");
    } finally {
      state.busyFiles = false; input.disabled = false; $("start").disabled = !!state.stream;
    }
  }

  function decodeVideoFile(f) {
    return new Promise((resolve) => {
      const v = $("video"); const url = URL.createObjectURL(f);
      let finished = false;
      const finish = () => {
        if (finished) return; finished = true;
        clearInterval(state.videoPoll); state.videoPoll = null; state.finishVideo = null;
        state.running = false; state.scanGen++; syncOverlay();
        v.onended = v.onerror = null; v.pause(); v.removeAttribute("src"); v.load(); URL.revokeObjectURL(url);
        $("empty").hidden = false;
        resolve();
      };
      state.finishVideo = finish;
      v.srcObject = null; v.src = url; v.muted = true; v.playbackRate = 0.5;
      $("empty").hidden = true;
      state.running = true; syncOverlay();
      v.onended = finish; v.onerror = finish;
      v.play().then(() => scanLoop(++state.scanGen)).catch(finish);
      state.videoPoll = setInterval(() => { if (state.session.done) finish(); }, 200);
    });
  }

  function resetAll() {
    stopCamera(); stopVideoFile(); revokeResult();
    state.session = new DQ.ReceiverSession(); state.result = null; state.error = null; state.opened = false; state.opening = false; state.saved = false;
    map.reset(); $("burst").hidden = true; $("burst").classList.remove("play");
    state.keyState = ""; state.pendingCheck = false; state.checking = false; state.checkToken++; state.passOffered = null;
    state.kdfFor = 0; state.kdfEst = null; $("passslow").hidden = true; $("passslow").textContent = "";
    $("result").textContent = ""; $("passbox").hidden = true; $("pass").value = ""; $("decrypt").textContent = "Decrypt"; $("r-key").textContent = "–"; $("decrypt").disabled = false; $("bar").style.width = "0%"; msg("", "");
    ["r-id", "r-enc", "r-prog", "r-pk"].forEach((id) => ($(id).textContent = "–")); setPhase("idle"); updateStats();
    $("start").focus();
  }

  function disarmReset() { if (state.resetArmed) { clearTimeout(state.resetArmed); state.resetArmed = 0; $("reset").textContent = "Reset"; $("reset").classList.remove("danger"); } }

  $("start").addEventListener("click", startCamera);
  // Drop QR images or a screen recording anywhere on the page to decode them (same path as the file input).
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
  document.addEventListener("dragenter", (e) => { if (hasFiles(e)) { dragDepth++; document.body.classList.add("dragging"); } });
  document.addEventListener("dragleave", () => { if (dragDepth && --dragDepth === 0) document.body.classList.remove("dragging"); });
  document.addEventListener("dragover", (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
  document.addEventListener("drop", (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault(); dragDepth = 0; document.body.classList.remove("dragging");
    const files = Array.from(e.dataTransfer.files).filter((f) => /^(image|video)\//.test(f.type));
    if (!files.length) { msg("Drop QR code images or a video of the stream here. To send a file, open the sender page.", "warn"); return; }
    const dt = new DataTransfer(); files.forEach((f) => dt.items.add(f));
    $("files").files = dt.files; decodeFiles($("files"));
  });
  $("stop").addEventListener("click", () => {
    state.startToken++; stopCamera(); setPhase(state.session.meta ? "paused" : "idle");
    msg(hasPartial() ? "Paused. Progress is kept; press Resume scanning to continue." : "", "warn");
  });
  $("files").addEventListener("change", (e) => decodeFiles(e.target));
  $("passbox").addEventListener("submit", (e) => { e.preventDefault(); if (state.session.done) tryOpen(); else earlyCheck(); });
  $("pass").addEventListener("input", () => {
    // A changed passphrase has not been checked yet.
    if (state.keyState || state.pendingCheck) { state.checkToken++; state.checking = false; state.keyState = ""; state.pendingCheck = false; updatePassUi(); }
  });
  $("switch").addEventListener("click", () => {
    if (!state.session.pending) return;
    state.session.switchToPending(); $("r-id").textContent = "–";
    state.keyState = ""; state.checking = false; state.checkToken++;
    state.kdfFor = 0; state.kdfEst = null; $("passslow").hidden = true; $("passslow").textContent = "";
    updateStats(); msg("Switched to the transfer now on screen. Its packets seen so far were kept.", "ok");
    if (state.session.done) { stopCamera(); stopVideoFile(); setPhase("verifying"); tryOpen(); }
  });
  $("reset").addEventListener("click", () => {
    // Discarding received packets cannot be undone: ask with a second press when there is partial progress.
    if (hasPartial() && !state.resetArmed) {
      const n = state.session.decoder.received;
      $("reset").textContent = `Discard ${n} received packet${n === 1 ? "" : "s"}? Press again`;
      $("reset").classList.add("danger");
      state.resetArmed = setTimeout(disarmReset, RESET_CONFIRM_MS);
      return;
    }
    disarmReset(); resetAll();
  });
  $("reset").addEventListener("blur", disarmReset);
  $("cam").addEventListener("change", () => { if (state.stream) startCamera(); });
  $("dec").addEventListener("change", async () => {
    if (!state.stream) return;
    try { await pickDecoder(); } catch (e) { msg("✗ " + e.message, "err"); }
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") disarmReset(); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && state.stream) wake(true); });
  window.addEventListener("beforeunload", (e) => { if (hasPartial()) { e.preventDefault(); e.returnValue = ""; } });
  setPhase("idle");
})();
