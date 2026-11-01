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
  };
  window.__dexqrReceiver = state;                 // read-only hook for automated tests

  function msg(text, cls) {
    const m = $("msg"); m.textContent = text || ""; m.className = "msg" + (text ? " show " + cls : "");
    // Errors interrupt (alert); progress and success messages are polite.
    m.setAttribute("role", cls === "err" ? "alert" : "status");
  }
  function setPhase(p) { state.phase = p; $("r-status").textContent = p; }
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
  async function decodeSource(src, w, h) {
    if (state.engine === "native") {
      const codes = await state.detector.detect(src);
      return codes.map((c) => c.rawValue);
    }
    const s = Math.min(1, MAX_SIDE / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s));
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    ctx.drawImage(src, 0, 0, cw, ch);
    return decodeImageData(ctx.getImageData(0, 0, cw, ch), state.engine);
  }

  function updateStats() {
    const s = state.session, p = s.progress(), st = s.stats;
    state.frames = st.frames;
    $("r-frames").textContent = `${st.frames} scanned, ${st.qrTexts} QR read`;
    $("r-dec").textContent = state.decoderName || "–";
    const bw = $("barwrap");
    if (!s.meta) {
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
    bw.setAttribute("aria-valuenow", pct.toFixed(0));
    bw.setAttribute("aria-valuetext", `${have} of ${p.K} blocks decoded`);
    const sw = $("switchbox");
    if (s.otherTransferWaiting) {
      $("switchtext").textContent = `A different transfer (${s.pending.fileIdHex}) has been on screen for ${s.otherStreak} packets, and this one (${s.meta.fileIdHex}) has not. If the sender changed files or re-prepared, switch.`;
      sw.hidden = false;
    } else sw.hidden = true;
  }

  function safeName(n) { n = String(n || "received.bin").replace(/[\\/\u0000-\u001f\u007f:*?"<>|]+/g, "_").replace(/^\.+/, "").slice(0, 200); return n || "received.bin"; }
  function revokeResult() { if (state.resultUrl) { URL.revokeObjectURL(state.resultUrl); state.resultUrl = null; } }

  async function tryOpen() {
    if (state.opening || state.opened || !state.session.done) return;   // one attempt at a time
    const sess = state.session;
    const pass = $("pass").value || undefined;
    state.opening = true; $("decrypt").disabled = true;
    setPhase(pass ? "decrypting" : "verifying");
    if (pass) msg("Deriving key (PBKDF2, several hundred thousand iterations) and decrypting…", "warn");
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
      state.result = { name, size: out.data.length, sha256: fileSha, encrypted: out.encrypted, compressed: out.compressed };
      state.error = null; state.opened = true;
      setPhase("done");
      msg("✓ Transfer complete. The file is verified and ready to save.", "ok");
      a.focus();
    } catch (e) {
      if (state.session !== sess) return;
      state.error = e.code || e.message;
      if (e.code === "NEED_PASSPHRASE") { $("passbox").hidden = false; setPhase("needs passphrase"); msg("All data received. This transfer is encrypted: enter the passphrase.", "warn"); $("pass").focus(); }
      else if (e.code === "WRONG_PASSPHRASE") { $("passbox").hidden = false; setPhase("wrong passphrase"); msg("✗ Wrong passphrase (AES-GCM authentication failed). Try again; no need to rescan.", "err"); $("pass").select(); $("pass").focus(); }
      else if (e.code === "TOO_LARGE") { setPhase("refused"); msg("✗ " + e.message + " Press Reset to scan something else.", "err"); }
      else if (e.code === "NO_DECOMPRESSION") { setPhase("cannot unpack"); msg("✗ " + e.message, "err"); }
      else if (e.code === "CHECKSUM_MISMATCH") { setPhase("checksum mismatch"); msg("✗ Checksum mismatch: the reconstructed data does not match the sender's SHA-256. Nothing was saved. Press Reset and scan again; if it repeats, the stream on screen is corrupted or forged.", "err"); }
      else { setPhase("error"); msg("✗ Could not open the transfer: " + e.message, "err"); }
    } finally {
      if (state.session === sess) { state.opening = false; $("decrypt").disabled = false; }
    }
  }

  async function onDecoded(texts) {
    const s = state.session;
    s.stats.frames++;
    const wasDone = s.done;
    for (const t of texts) s.addText(t);
    updateStats();
    if (s.done && !wasDone) { stopCamera(); stopVideoFile(); setPhase("verifying"); await tryOpen(); }
    else if (s.meta && !s.done && state.running) setPhase("receiving");
  }

  /* One scan loop per camera start or video file; a newer loop (scanGen) retires older ones. */
  function scanLoop(gen) {
    const v = $("video");
    const step = async () => {
      if (gen !== state.scanGen || !state.running || state.session.done) return;
      if (v.readyState >= 2 && v.videoWidth) {
        try { await onDecoded(await decodeSource(v, v.videoWidth, v.videoHeight)); }
        catch (e) { state.session.stats.frames++; }                    // a bad frame: count it, keep going
      }
      if (gen !== state.scanGen || !state.running || state.session.done) return;
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => step());
      else requestAnimationFrame(() => step());
    };
    step();
  }

  function cameraErrorText(e) {
    switch (e && e.name) {
      case "NotAllowedError": case "SecurityError": return "Camera permission was denied. Allow the camera for this page in the browser's site settings and press Start camera again, or decode image or video files instead (under “Camera, decoder and file input”).";
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
        msg("The camera stopped (unplugged, or permission was revoked). Progress is kept; press Start camera to continue.", "err");
      }));
      const v = $("video"); v.removeAttribute("src"); v.srcObject = stream; await v.play();
      if (token !== state.startToken) return;                          // the newer start owns the camera now
      $("empty").hidden = true;
      state.running = true; $("start").disabled = true; $("stop").disabled = false;
      setPhase(state.session.meta ? "receiving" : "scanning");
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
    $("start").disabled = state.busyFiles; $("stop").disabled = true;
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
        state.running = false; state.scanGen++;
        v.onended = v.onerror = null; v.pause(); v.removeAttribute("src"); v.load(); URL.revokeObjectURL(url);
        $("empty").hidden = false;
        resolve();
      };
      state.finishVideo = finish;
      v.srcObject = null; v.src = url; v.muted = true; v.playbackRate = 0.5;
      $("empty").hidden = true;
      state.running = true;
      v.onended = finish; v.onerror = finish;
      v.play().then(() => scanLoop(++state.scanGen)).catch(finish);
      state.videoPoll = setInterval(() => { if (state.session.done) finish(); }, 200);
    });
  }

  function resetAll() {
    stopCamera(); stopVideoFile(); revokeResult();
    state.session = new DQ.ReceiverSession(); state.result = null; state.error = null; state.opened = false; state.opening = false;
    $("result").textContent = ""; $("passbox").hidden = true; $("pass").value = ""; $("decrypt").disabled = false; $("bar").style.width = "0%"; msg("", "");
    ["r-id", "r-enc", "r-prog", "r-pk"].forEach((id) => ($(id).textContent = "–")); setPhase("idle"); updateStats();
  }

  function disarmReset() { if (state.resetArmed) { clearTimeout(state.resetArmed); state.resetArmed = 0; $("reset").textContent = "Reset"; $("reset").classList.remove("danger"); } }

  $("start").addEventListener("click", startCamera);
  $("stop").addEventListener("click", () => {
    state.startToken++; stopCamera(); setPhase(state.session.meta ? "paused" : "idle");
    msg(hasPartial() ? "Paused. Progress is kept; press Start camera to continue." : "", "warn");
  });
  $("files").addEventListener("change", (e) => decodeFiles(e.target));
  $("passbox").addEventListener("submit", (e) => { e.preventDefault(); tryOpen(); });
  $("switch").addEventListener("click", () => {
    if (!state.session.pending) return;
    state.session.switchToPending(); $("r-id").textContent = "–";
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
})();
