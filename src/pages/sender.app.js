/* Dex_QR sender page logic. Original code, MIT License. */
(function () {
  "use strict";
  const DQ = window.DexQR;
  const $ = (id) => document.getElementById(id);
  const MAX_FILE = 32 * 1024 * 1024;
  const state = {
    session: null, playing: false, sent: 0, due: 0, qrSize: 0, raf: 0, ecl: "M", text: "",
    prepared: null, preparing: false, fpsSamples: [], actualFps: 0, wakeLock: null, focusMode: false,
    need: 0, finish: "", playMs: 0, playSince: 0,   // cycle 8: finished state ("" | "likely" | "final")
    confirmed: false, ack: { stream: null, gen: 0, verdict: "", log: [] }, camera: "unknown",   // cycle 9: Done confirmation
  };
  window.__dexqrSender = state; // read-only hook for automated tests
  const UI = window.DexUI;
  const ICON_PLAY = "M8 5v14l11-7z", ICON_PAUSE = "M7 5h4v14H7zM13 5h4v14h-4z";

  function msg(text, cls) {
    const m = $("msg"); m.textContent = text || ""; m.className = "msg" + (text ? " show " + cls : "");
    m.setAttribute("role", cls === "err" ? "alert" : "status");
  }
  function fmtTime(s) { if (!isFinite(s)) return "–"; s = Math.ceil(s); return s < 90 ? s + " s" : Math.floor(s / 60) + " min " + (s % 60) + " s"; }
  function hex(b) { return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""); }
  function clampInput(id, lo, hi, dflt) {
    const el = $(id); let v = Math.round(Number(el.value));
    if (!Number.isFinite(v) || el.value.trim() === "") v = dflt;
    v = Math.max(lo, Math.min(hi, v));
    if (String(v) !== el.value) el.value = String(v);
    return v;
  }
  const fps = () => clampInput("fps", 1, 30, 8);

  $("pass").addEventListener("input", () => {
    const p = $("pass").value, el = $("strength");
    if (!p) { el.textContent = ""; el.className = "strength"; return; }
    const s = DQ.container.estimateStrength(p);
    // Warnings never quote the passphrase: this screen may be filmed.
    el.textContent = `Strength estimate: ${s.label} (about ${s.bits} bits of guessing). ` + (s.warnings[0] ? s.warnings[0] + " " : "") + (s.bits < 60 ? "Too weak against an offline guessing attack on a recorded stream." : "OK if it was chosen at random.");
    el.className = "strength " + s.label;
  });

  function drawText(text) {
    const qr = DQ.render.makeQr(text, state.ecl);
    const quiet = 4, n = qr.size + 2 * quiet;
    let px = clampInput("px", 0, 20, 0);
    if (!px) {
      const stage = $("stage");
      const reserve = state.focusMode || document.fullscreenElement ? 56 : 40;   // room for the stage bar
      const avail = Math.max(200, Math.min(stage.clientWidth - 16, (state.focusMode || document.fullscreenElement ? stage.clientHeight : window.innerHeight) - reserve));
      px = Math.max(2, Math.floor(avail / n));
    }
    const c = $("qr");
    if (c.width !== n * px) { c.width = n * px; c.height = n * px; }
    const g = c.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = "#000";
    for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.getModule(x, y)) g.fillRect((x + quiet) * px, (y + quiet) * px, px, px);
    state.qrSize = qr.size; state.qrVersion = qr.version; state.modulePx = px; state.text = text;
  }
  function redraw() {
    if (!state.text) return;
    drawText(state.text);
    $("s-qr").textContent = `version ${state.qrVersion} (${state.qrSize}×${state.qrSize} modules), EC ${state.ecl}, ${state.modulePx} px/module`;
  }

  function updateStats() {
    const s = state.session; if (!s) return;
    const f = fps();
    const need = Math.ceil((Math.ceil(s.K * 1.05) + 1) / s.dataFrameShare);   // key-check frames take 1 in 32
    const pct = Math.min(100, (100 * state.sent) / need);
    state.need = need;
    checkFinish();
    $("s-sent").textContent = String(state.sent) + (state.playing && state.actualFps ? ` (${state.actualFps.toFixed(1)} fps actual)` : "");
    $("bar").style.width = pct.toFixed(1) + "%";
    $("barwrap").setAttribute("aria-valuenow", pct.toFixed(0));
    const left = Math.max(0, need - state.sent);
    $("s-eta").textContent = `${fmtTime(left / f)} left with no missed frames; ${fmtTime(left / 0.7 / f)} if 30% are missed (total ≈ ${fmtTime(need / f)} / ${fmtTime(need / 0.7 / f)})`;
    $("stage-info").textContent = `frame ${state.sent} · ${f} fps`;
    // Progress ring: the wrapper's border around the white stage, never on the code itself.
    $("ring").style.setProperty("--p", pct.toFixed(1));
    const fpsTxt = state.playing && state.actualFps ? state.actualFps.toFixed(1) : String(f);
    $("live-text").textContent = state.playing
      ? `Sending · frame ${state.sent} · ${fpsTxt} fps · ${left ? "about " + fmtTime(left / f) + " to go" : "keep going until the receiver is done"}`
      : state.sent ? `Paused at frame ${state.sent} · press Resume to continue` : `Ready · ${s.K} blocks · about ${fmtTime(need / f)} at ${f} fps`;
  }

  function showNext(ts) {
    drawText(state.session.nextFrame());
    state.sent++;
    if (ts !== undefined) {
      const w = state.fpsSamples; w.push(ts);
      while (w.length > 2 && ts - w[0] > 2000) w.shift();
      state.actualFps = w.length > 1 ? (1000 * (w.length - 1)) / (w[w.length - 1] - w[0]) : 0;
    }
    updateStats();
  }

  /* Frame clock: frames are due every 1000/fps ms on an absolute schedule (due += interval), so the
   * average rate matches the setting even when the interval is not a whole number of display
   * refreshes (8 fps on a 60 Hz screen alternates 7 and 8 refreshes). The old "ts - last >= interval"
   * test rounded every frame up to whole refreshes: 8 fps ran at 7.5 fps. After a stall (hidden tab,
   * slow device) the schedule restarts instead of bursting to catch up. */
  function loop(ts) {
    if (!state.playing) return;
    const interval = 1000 / fps();
    if (!state.due || ts - state.due > 4 * interval) state.due = ts;
    if (ts >= state.due - 2) {
      state.due += interval;
      showNext(ts);
    }
    state.raf = requestAnimationFrame(loop);
  }

  function setPlaying(on) {
    if (!state.session) return;
    if (on === state.playing) return;
    if (on && state.finish === "final") leaveFinal();
    const now = performance.now();
    if (on) state.playSince = now; else if (state.playSince) { state.playMs += now - state.playSince; state.playSince = 0; }
    state.playing = on;
    syncPlayButton();
    $("play").setAttribute("aria-pressed", String(on));
    $("ring").classList.toggle("playing", on);
    $("live-dot").classList.toggle("on", on);
    $("stage-play").textContent = on ? "Pause" : "Play";
    $("qr").setAttribute("aria-label", on ? "Animated QR code stream, playing" : "Animated QR code stream, paused");
    cancelAnimationFrame(state.raf);
    if (on) { state.due = 0; state.fpsSamples = []; state.actualFps = 0; state.raf = requestAnimationFrame(loop); }
    wake(on);
    updateStats();
  }

  async function wake(on) {
    try {
      if (on && !state.wakeLock && navigator.wakeLock) { state.wakeLock = await navigator.wakeLock.request("screen"); state.wakeLock.addEventListener("release", () => { state.wakeLock = null; }); }
      else if (!on && state.wakeLock) { const l = state.wakeLock; state.wakeLock = null; await l.release(); }
    } catch (e) { /* best effort: the screen may still dim on browsers without the Wake Lock API */ }
  }

  /* The big button: "Start sending" prepares (if needed) and plays; then it toggles Pause / Resume. */
  function syncPlayButton() {
    const stale = !state.session || settingsKey() !== state.prepared;
    const label = state.playing ? "Pause" : stale ? "Start sending" : state.sent ? "Resume" : "Start sending";
    $("play-text").textContent = label;
    $("play-icon").setAttribute("d", state.playing ? ICON_PAUSE : ICON_PLAY);
    $("play").classList.toggle("on", state.playing);
    $("play").disabled = state.preparing || (!state.session && !$("file").files[0]);
  }
  async function playClicked() {
    if (state.preparing) return;
    if (!state.playing && (!state.session || settingsKey() !== state.prepared)) {
      if (!(await prepare())) return;
      setPlaying(true);
      // On a phone the code panel sits below the controls: bring it into view.
      if (window.innerWidth <= 860) $("ring").scrollIntoView({ block: "center", behavior: UI.reducedMotion() ? "auto" : "smooth" });
      msg("✓ Sending. Point the receiver's camera at the code and keep going until it says the file is ready.", "ok");
      return;
    }
    setPlaying(!state.playing);
  }

  function settingsKey() { const f = $("file").files[0]; return [f ? f.name + ":" + f.size + ":" + f.lastModified : "", $("pass").value, $("bs").value, $("zip").checked, $("kc").checked, $("kdf").value].join("\u0000"); }
  function checkStale() {
    if (!state.session || state.preparing) return;
    const stale = settingsKey() !== state.prepared;
    $("prepare").classList.toggle("attn", stale);
    $("prepare").textContent = stale ? "Prepare (apply changes)" : "Prepare";
    if (stale) msg("Settings changed. The stream on screen still uses the previous file, passphrase, key stretching, compression, key check and density; press Prepare (or pause and press Start sending) to apply.", "warn");
    else if ($("msg").classList.contains("warn") && /Settings changed/.test($("msg").textContent)) msg("", "");
    syncPlayButton();
  }

  function describeCompression(c) {
    if (!c) return "–";
    if (c.used) return `${c.algorithm}: ${c.innerLength.toLocaleString()} → ${c.compressedLength.toLocaleString()} bytes (−${(100 * (1 - c.compressedLength / c.innerLength)).toFixed(0)}%)`;
    if (c.reason === "off") return "off";
    if (c.reason === "unavailable") return "not available in this browser (no CompressionStream); sent uncompressed";
    return "skipped: the file does not shrink (already compressed?)";
  }

  function describeKdf(tuned, n) {
    if (!tuned) return ", standard";
    const c = state.calibration;
    if (!c || !c.measured) return ", standard: this device could not be timed";
    const x = (n / DQ.container.DEFAULT_ITERATIONS).toFixed(1);
    return `, tuned to this device: about ${(c.estimatedMs / 1000).toFixed(1)} s here, ${x}× the standard 600,000` + (c.capped ? ", at the 8,000,000 cap" : c.floored ? ", the minimum" : "");
  }

  async function prepare() {
    const f = $("file").files[0];
    if (!f) { msg("Choose a file first: drop it on the box, paste it, or press the box to browse.", "warn"); $("file").focus(); return false; }
    if (f.size > MAX_FILE) { msg("Files over 32 MiB are not supported (a QR stream that long is impractical).", "err"); return false; }
    setPlaying(false);
    state.preparing = true; $("prepare").disabled = true; $("play").disabled = true;
    let ok = false;
    msg($("pass").value ? "Preparing the key…" : "Preparing…", "warn");
    try {
      // Key stretching (cycle 4): measure this device once per page load, then derive with that count.
      let iterations = DQ.container.DEFAULT_ITERATIONS;
      const tuned = !!$("pass").value && $("kdf").value === "auto";
      if (tuned) {
        if (!state.calibration) { msg("Measuring this device's PBKDF2 speed…", "warn"); state.calibration = await DQ.container.calibrateIterations(); }
        iterations = state.calibration.iterations;
      }
      if ($("pass").value) msg(`Deriving key (PBKDF2, ${iterations.toLocaleString("en-US")} iterations)…`, "warn");
      const key = settingsKey();
      const data = new Uint8Array(await f.arrayBuffer());
      const sha = await DQ.container.sha256(data);
      state.ecl = $("ecl").value;
      const startSeed = crypto.getRandomValues(new Uint32Array(1))[0];
      state.session = await DQ.SenderSession.create({ name: f.name, mime: f.type, data, blockSize: Number($("bs").value), passphrase: $("pass").value || undefined, iterations, startSeed, compress: $("zip").checked, keyCheck: $("kc").checked });
      state.prepared = key;
      state.sent = 0; state.fileSha = hex(sha); state.playMs = 0; state.playSince = 0; clearFinish();
      const s = state.session;
      $("s-file").textContent = `${f.name} (${f.size.toLocaleString()} bytes)`;
      $("s-sha").textContent = state.fileSha;
      $("s-enc").textContent = s.encrypted ? `yes (AES-256-GCM, PBKDF2-SHA-256 × ${iterations.toLocaleString("en-US")}${describeKdf(tuned, iterations)})` + (s.keyFrameText ? "; early passphrase check on (1 key-check frame in 32)" : "; early passphrase check off") : "no — anyone who sees the stream can read the file";
      $("s-zip").textContent = describeCompression(s.compression);
      $("s-id").textContent = DQ.packet.hex(s.fileId);
      $("s-k").textContent = `${s.K} × ${s.blockSize} bytes`;
      drawText(s.textForSeed(s.nextSeed));   // preview a data packet so the QR line shows the data-frame size
      redraw();
      $("qr").setAttribute("aria-label", "Animated QR code stream, paused");
      updateStats();
      $("fs").disabled = false;
      showSummary(f, s);
      msg("✓ Ready. Press Start sending and point the receiver's camera at the code.", "ok");
      ok = true;
    } catch (e) { msg("✗ Could not prepare: " + e.message, "err"); }
    state.preparing = false; $("prepare").disabled = false;
    checkStale(); syncPlayButton();
    return ok;
  }

  function fmtSize(n) { return n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB" : (n / 1048576).toFixed(1) + " MB"; }
  function chip(text, cls) { const c = document.createElement("span"); c.className = "chip" + (cls ? " " + cls : ""); c.textContent = text; return c; }
  function showSummary(f, s) {
    const box = $("summary"); box.textContent = "";
    box.append(chip(s.encrypted ? "🔒 Encrypted" : "Not encrypted", s.encrypted ? "lock" : "open"));
    if (s.compression && s.compression.used) box.append(chip(`Compressed −${(100 * (1 - s.compression.compressedLength / s.compression.innerLength)).toFixed(0)}%`));
    box.append(chip(`${s.K} blocks`), chip(`QR v${state.qrVersion}`));
    box.hidden = false;
    // The stage switches from the placeholder to the white code panel.
    $("stage").classList.remove("idle"); $("ring").classList.remove("idle"); $("stage-empty").hidden = true; $("qr").hidden = false;
    redraw();
  }


  /* Cycle 8: the finished state. The sender cannot see the receiver, so "likely done" is the frame estimate:
   * once the stream has sent what a receiver needs with no missed frames, a card below the code says so and
   * offers one-press actions; the stream keeps playing (a receiver that missed frames needs a few more). A second
   * line appears once even 30% missed frames should be covered. "Receiver says Done: stop" ends the session with
   * a summary in place of the code; "Send another file" goes back to step 1 with the passphrase and tuning kept. */
  let sayT = 0;
  function say(text) { const el = $("finish-say"); el.textContent = ""; clearTimeout(sayT); sayT = setTimeout(() => { el.textContent = text; }, 60); }
  function checkFinish() {
    const s = state.session; if (!s || !state.need || state.finish === "final") return;
    const lossy = state.sent >= Math.ceil(state.need / 0.7);
    if (state.sent < state.need) return;
    if (!state.finish) {
      state.finish = "likely";
      $("finish").hidden = false; $("finish").classList.remove("final");
      $("finish-h").textContent = "The receiver should have it by now";
      $("finish-stats").hidden = true; $("finish-stop").hidden = false; $("finish-resume").hidden = true;
      syncConfirm();
      $("ring").classList.add("reached");
      if (/Sending\./.test($("msg").textContent)) msg("", "");   // the card replaces the "Sending" line
      say("Estimate reached: a receiver that missed no frames has the file. Keep the code showing until it says Done.");
    }
    const t = lossy ? "Enough even if 30% of frames were missed. Not done yet? Check the receiver's camera view." : "Enough frames if none were missed. Keep showing the code until the receiver says Done.";
    if ($("finish-p").textContent !== t) { $("finish-p").textContent = t; if (lossy) say("Enough frames even with 30% missed."); }
  }
  // Keep the card where the sender is looking: beside the code in the control column on wide screens (the code
  // fills the window height there, so below it would be off screen), directly under the code on phones.
  const narrow = window.matchMedia ? window.matchMedia("(max-width: 860px)") : null;
  function placeFinish() {
    const card = $("finish"), wide = !(narrow && narrow.matches);
    if (wide && card.parentElement !== $("step3-body")) $("msg").after(card);
    else if (!wide && card.previousElementSibling !== $("live")) $("live").after(card);
    card.classList.toggle("side", wide);
  }
  if (narrow && narrow.addEventListener) narrow.addEventListener("change", placeFinish);
  placeFinish();
  function clearFinish() {
    stopAckCam(""); state.confirmed = false;
    $("finish").classList.remove("confirmed"); $("stage-done").classList.remove("confirmed"); $("stage-done-h").textContent = "Sent";
    $("finish-again").className = "secondary";
    state.finish = ""; $("finish").hidden = true; $("finish").classList.remove("final"); $("ring").classList.remove("reached");
    $("stage-done").hidden = true; $("finish-p").textContent = "";
  }
  function statRow(dl, k, v) { const dt = document.createElement("dt"), dd = document.createElement("dd"); dt.textContent = k; dd.textContent = v; dl.append(dt, dd); }
  function finishNow() {
    const s = state.session; if (!s) return;
    setPlaying(false);
    if (document.fullscreenElement || state.focusMode) exitFull();
    state.finish = "final";
    const f = $("file").files[0], name = f ? f.name : "the file", secs = state.playMs / 1000;
    $("finish").hidden = false; $("finish").classList.add("final"); $("ring").classList.add("reached");
    $("finish-h").textContent = `Sent ${name}`;
    $("finish-p").textContent = "The stream is stopped. Check that the receiver saved the file and that its SHA-256 matches the one under Transfer details.";
    const dl = $("finish-stats"); dl.textContent = "";
    if (f) statRow(dl, "Size", fmtSize(f.size));
    statRow(dl, "Frames shown", `${state.sent.toLocaleString("en-US")} (estimate ${state.need.toLocaleString("en-US")})`);
    statRow(dl, "Time", fmtTime(secs) + (secs > 0 ? ` at ${(state.sent / secs).toFixed(1)} fps` : ""));
    statRow(dl, "Encrypted", s.encrypted ? "yes" : "no");
    dl.hidden = false;
    $("finish-stop").hidden = true; $("finish-resume").hidden = !!state.confirmed; $("finish-again").className = "okbtn";
    syncConfirm();
    // The stage shows a check mark instead of the code: nothing is being sent now.
    $("qr").hidden = true; $("stage").classList.add("idle"); $("ring").classList.remove("idle");
    $("stage-done-name").textContent = `${name} · ${state.sent.toLocaleString("en-US")} frames · ${fmtTime(secs)}`;
    $("stage-done").hidden = false;
    $("live-text").textContent = `Finished · ${state.sent} frames sent`;
    msg(`✓ Finished: ${name} was shown in ${state.sent} frames. Send another file, or show the code again if the receiver is not done.`, "ok");
    say(`Finished. Sent ${name} in ${state.sent} frames. Press Send another file to choose the next one.`);
    $("finish-again").focus();
  }
  function leaveFinal() {
    state.finish = "likely";
    if (state.confirmed) { state.confirmed = false; $("finish").classList.remove("confirmed"); $("stage-done").classList.remove("confirmed"); $("stage-done-h").textContent = "Sent"; }
    $("stage-done").hidden = true; $("qr").hidden = false; $("stage").classList.remove("idle");
    $("finish").classList.remove("final"); $("finish-stats").hidden = true; $("finish-stop").hidden = false; $("finish-resume").hidden = true; $("finish-again").className = "secondary";
    $("finish-h").textContent = "The receiver should have it by now";
    $("finish-p").textContent = "";
    syncConfirm();
    redraw(); checkFinish();
  }
  /* Cycle 9: "Confirm with camera". The receiver shows a static Done code once it has rebuilt and verified the
   * file; this device's camera can read it and turn "should have it by now" into a confirmed Done. Optional:
   * without a camera (or permission) the manual "Receiver done: stop" is unchanged. The stream keeps playing while
   * the camera looks. Frames are read about 8 times a second from a copy at most 640 px wide, with the browser's
   * BarcodeDetector when it reads QR codes, else the built-in jsQR. Only a v1 Done frame carrying this transfer's
   * ID confirms; other codes get a plain-language hint and are otherwise ignored. */
  const ACK_TICK_MS = 125, ACK_TIMEOUT_MS = 120000, ACK_SIDE = 640, ACK_LOG_MAX = 100;
  const actx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  function cameraApi() { return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia); }
  function syncConfirm() {
    const show = !!state.session && !state.confirmed && (state.finish === "likely" || state.finish === "final") && cameraApi() && state.camera !== "none";
    $("finish-confirm").hidden = !show || !!state.ack.stream;
  }
  async function probeCamera() {
    // Without permission, enumerateDevices still lists "videoinput" entries (unlabelled); none means no camera.
    if (!cameraApi()) { state.camera = "none"; return; }
    try { const d = await navigator.mediaDevices.enumerateDevices(); state.camera = d.some((x) => x.kind === "videoinput") ? "yes" : "none"; }
    catch (e) { state.camera = "unknown"; }
    syncConfirm();
  }
  function ackHint(text, verdict) {
    const el = $("ackcam-hint");
    if (el.textContent !== text) el.textContent = text;
    el.className = "ackcam-hint" + (verdict ? " " + verdict : "");
  }
  function ackLog(verdict, detail) { const l = state.ack.log; l.push({ verdict, detail: detail || "", t: Math.round(performance.now()) }); if (l.length > ACK_LOG_MAX) l.shift(); }
  function camErr(e) {
    switch (e && e.name) {
      case "NotAllowedError": case "SecurityError": return "Camera permission was denied, so the Done code cannot be read here. When the receiver says Done, press “Receiver done: stop”.";
      case "NotFoundError": case "OverconstrainedError": return "This device has no camera. When the receiver says Done, press “Receiver done: stop”.";
      case "NotReadableError": case "AbortError": return "The camera is in use by another app. Close it and try again, or press “Receiver done: stop” when the receiver says Done.";
      default: return "The camera could not start (" + ((e && e.message) || e) + "). Press “Receiver done: stop” when the receiver says Done.";
    }
  }
  async function pickAckDecoder() {
    if (state.ack.decoder) return state.ack.decoder;
    let d = { name: "jsqr" };
    if ("BarcodeDetector" in window && !state.ack.forceJsqr) {
      try { if ((await window.BarcodeDetector.getSupportedFormats()).includes("qr_code")) d = { name: "native", det: new window.BarcodeDetector({ formats: ["qr_code"] }) }; } catch (e) { /* jsQR */ }
    }
    state.ack.decoder = d; return d;
  }
  async function startAckCam() {
    if (!state.session || state.ack.stream || state.ack.starting) return;
    const gen = ++state.ack.gen; state.ack.starting = true;
    $("ackcam").hidden = false; $("ackcam").classList.remove("off"); $("finish-confirm").hidden = true; $("finish").classList.add("looking");
    ackHint("Starting the camera…", "");
    let stream = null;
    try {
      if (!cameraApi()) { const e = new Error("no camera API"); e.name = "NotFoundError"; throw e; }
      await pickAckDecoder();
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "user" }, width: { ideal: 640 }, height: { ideal: 480 } } });
      if (gen !== state.ack.gen) { stream.getTracks().forEach((t) => t.stop()); return; }
      state.ack.stream = stream; state.ack.since = performance.now(); state.ack.verdict = "";
      const v = $("ackvideo"); v.srcObject = stream; await v.play();
      if (gen !== state.ack.gen) return;
      ackHint("Looking for the Done code…", "");
      ackLog("started", state.ack.decoder.name);
      state.ack.timer = setTimeout(() => ackTick(gen), ACK_TICK_MS);
    } catch (e) {
      if (gen !== state.ack.gen) { if (stream) stream.getTracks().forEach((t) => t.stop()); return; }
      if (e && (e.name === "NotFoundError" || e.name === "OverconstrainedError")) state.camera = "none";
      stopAckCam(camErr(e), "warn");
      ackLog("error", e && e.name);
    } finally { if (gen === state.ack.gen) state.ack.starting = false; }
  }
  function stopAckCam(text, tone) {
    const a = state.ack; a.gen++; a.starting = false; clearTimeout(a.timer);
    if (a.stream) { a.stream.getTracks().forEach((t) => t.stop()); a.stream = null; }
    const v = $("ackvideo"); if (v.srcObject) v.srcObject = null;
    $("finish").classList.remove("looking");
    if (text) { $("ackcam").hidden = false; $("ackcam").classList.add("off"); ackHint(text, tone || ""); }
    else { $("ackcam").hidden = true; $("ackcam").classList.remove("off"); ackHint("", ""); }
    syncConfirm();
  }
  async function ackTick(gen) {
    const a = state.ack, s = state.session;
    if (gen !== a.gen || !a.stream || !s) return;
    if (performance.now() - a.since > ACK_TIMEOUT_MS) { stopAckCam("Stopped looking after 2 minutes. Press “Confirm with camera” to try again, or “Receiver done: stop”.", "warn"); ackLog("timeout"); return; }
    const v = $("ackvideo");
    let texts = [];
    if (v.readyState >= 2 && v.videoWidth) {
      try {
        if (a.decoder.name === "native") texts = (await a.decoder.det.detect(v)).map((c) => c.rawValue);
        else {
          const k = Math.min(1, ACK_SIDE / Math.max(v.videoWidth, v.videoHeight)), w = Math.max(1, Math.round(v.videoWidth * k)), h = Math.max(1, Math.round(v.videoHeight * k));
          if (actx.canvas.width !== w || actx.canvas.height !== h) { actx.canvas.width = w; actx.canvas.height = h; }
          actx.drawImage(v, 0, 0, w, h);
          texts = DQ.scan.decodeImageData(actx.getImageData(0, 0, w, h).data, w, h, window.jsQR).texts;
        }
      } catch (e) { texts = []; }
    }
    if (gen !== a.gen || !a.stream) return;
    a.scans = (a.scans || 0) + 1;
    for (const t of texts) if (onAckText(t)) return;
    a.timer = setTimeout(() => ackTick(gen), ACK_TICK_MS);
  }
  /* One scanned text; returns true once this transfer is confirmed. Also the test hook for synthetic texts. */
  function onAckText(text) {
    const s = state.session; if (!s) return false;
    const mine = DQ.packet.hex(s.fileId), c = DQ.ack.classify(text, mine);
    ackLog(c.verdict, c.ack && c.ack.ok ? c.ack.fileIdHex : c.ack.reason);
    if (c.verdict === "done") { confirmDone(c.ack); return true; }
    if (c.verdict === state.ack.verdict) return false;   // the hint is already up (and was announced once)
    state.ack.verdict = c.verdict;
    if (c.verdict === "other") ackHint(`That Done code is for a different transfer (${c.ack.fileIdHex.slice(0, 8)}…). This one is ${mine.slice(0, 8)}…: show the receiver that got this file.`, "warn");
    else if (c.verdict === "newer") ackHint(c.ack.reason === "version"
      ? `That Done code comes from a newer Dex_QR version (confirmation format ${c.ack.version}) that this page cannot read. Use the same Dex_QR version on both devices, or press “Receiver done: stop”.`
      : "That Done code says something this version of Dex_QR does not understand. Use the same Dex_QR version on both devices, or press “Receiver done: stop”.", "warn");
    else if (c.verdict === "stream") ackHint("That is a Dex_QR stream frame, not the Done code. Show the receiver's finished screen.", "warn");
    else ackHint("That QR code is not a Dex_QR Done code. Show the receiver's finished screen.", "warn");
    return false;
  }
  state.ackFeedForTest = onAckText;
  function confirmDone(ack) {
    stopAckCam("");
    state.confirmed = true;
    if (state.finish !== "final") finishNow(); else syncConfirm();
    const f = $("file").files[0], name = f ? f.name : "the file";
    $("finish").classList.add("confirmed"); $("stage-done").classList.add("confirmed");
    $("finish-h").textContent = "Done: the receiver confirmed it";
    $("finish-p").textContent = `The receiver showed its Done code for this transfer (${ack.fileIdHex}): it rebuilt ${name} and verified its checksum. The stream is stopped.`;
    $("stage-done-h").textContent = "Confirmed";
    $("finish-resume").hidden = true;
    msg(`✓ Done: the receiver confirmed it has ${name}.`, "ok");
    say(`Done. The receiver confirmed it has ${name}. Press Send another file to choose the next one.`);
    $("finish-again").focus();
  }

  function sendAnother() {
    setPlaying(false);
    if (document.fullscreenElement || state.focusMode) exitFull();
    clearFinish();
    state.session = null; state.prepared = null; state.sent = 0; state.text = ""; state.playMs = 0; state.need = 0;
    $("file").value = "";
    $("qr").hidden = true; $("stage").classList.add("idle"); $("ring").classList.add("idle"); $("ring").style.setProperty("--p", "0");
    $("stage-empty").hidden = false; $("summary").hidden = true; $("fs").disabled = true;
    $("bar").style.width = "0%"; $("barwrap").setAttribute("aria-valuenow", "0"); $("s-eta").textContent = "–"; $("s-sent").textContent = "0";
    ["s-file", "s-sha", "s-enc", "s-zip", "s-id", "s-k", "s-qr"].forEach((id) => { $(id).textContent = "–"; });
    $("qr").setAttribute("aria-label", "Animated QR code stream (choose a file first)");
    $("live-text").textContent = "Ready when you are";
    fileChanged();
    msg("Ready for the next file. The passphrase and tuning are kept; clear the passphrase if the next receiver should not use it.", "ok");
    $("step1").scrollIntoView({ block: "nearest", behavior: UI && UI.reducedMotion() ? "auto" : "smooth" });
    $("file").focus();
    try { if ($("file").showPicker) $("file").showPicker(); else $("file").click(); } catch (e) { /* the drop box stays focused; Enter opens the picker */ }
  }

  /* Step 1: file picker, drag and drop anywhere on the page, or paste. */
  function fileChanged() {
    const f = $("file").files[0];
    $("drop").classList.toggle("has", !!f);
    $("drop-t1").textContent = f ? f.name : "Drop a file here, paste it, or browse";
    $("drop-t2").textContent = f ? `${fmtSize(f.size)}${f.type ? " · " + f.type : ""} · press to choose another` : "Any type, up to 32 MiB. It never leaves this page.";
    if (!f) { const u = document.createElement("u"); u.textContent = "browse"; $("drop-t1").textContent = "Drop a file here, paste it, or "; $("drop-t1").append(u); }
    if (f && f.size > MAX_FILE) msg("This file is over 32 MiB, which is not supported (a QR stream that long is impractical).", "err");
    syncSteps(); checkStale(); syncPlayButton();
  }
  function takeFiles(list, how) {
    const files = Array.from(list || []).filter((f) => f && f.size >= 0);
    if (!files.length) return false;
    const dt = new DataTransfer(); dt.items.add(files[0]);
    $("file").files = dt.files;
    fileChanged();
    if (files.length > 1) msg(`One file at a time: using “${files[0].name}” (${how}). Multi-file transfer is on the roadmap.`, "warn");
    else if (!state.session) msg("", "");
    return true;
  }
  function syncSteps() {
    const hasFile = !!$("file").files[0], hasPass = !!$("pass").value;
    $("step1").className = "step " + (hasFile ? "done" : "current");
    $("step2").className = "step" + (hasFile && hasPass ? " done" : "");
    $("step3").className = "step" + (hasFile ? " current" : "");
  }

  /* Full screen, with an in-page fallback ("focus mode") where the Fullscreen API is missing or refused (iPhone Safari). */
  async function enterFull() {
    if (!state.session) return;
    const st = $("stage");
    try {
      if (!st.requestFullscreen) throw new Error("no Fullscreen API");
      await st.requestFullscreen();
    } catch (e) { state.focusMode = true; st.classList.add("focus"); document.body.classList.add("noscroll"); }
    $("stagebar").hidden = false;
    $("stage-exit").focus();
    redraw();
  }
  function exitFull() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (state.focusMode) { state.focusMode = false; $("stage").classList.remove("focus"); document.body.classList.remove("noscroll"); }
    $("stagebar").hidden = true;
    redraw();
    $("fs").focus();
  }
  document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement && !state.focusMode) $("stagebar").hidden = true; redraw(); });

  $("prepare").addEventListener("click", prepare);
  $("play").addEventListener("click", playClicked);
  $("file").addEventListener("change", fileChanged);
  $("pass").addEventListener("input", syncSteps);
  let dragDepth = 0;
  document.addEventListener("dragenter", (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files")) { dragDepth++; $("drop").classList.add("over"); } });
  document.addEventListener("dragleave", () => { if (dragDepth && --dragDepth === 0) $("drop").classList.remove("over"); });
  document.addEventListener("dragover", (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
  document.addEventListener("drop", (e) => {
    // Always stop the browser from navigating away to the dropped file.
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault(); dragDepth = 0; $("drop").classList.remove("over");
    takeFiles(e.dataTransfer.files, "dropped");
  });
  document.addEventListener("paste", (e) => {
    const files = e.clipboardData && e.clipboardData.files;
    if (files && files.length) { e.preventDefault(); takeFiles(files, "pasted"); }
  });
  $("finish-stop").addEventListener("click", () => { stopAckCam(""); finishNow(); });
  $("finish-confirm").addEventListener("click", startAckCam);
  $("ackcam-cancel").addEventListener("click", () => { stopAckCam(""); $("finish-confirm").focus(); });
  $("finish-again").addEventListener("click", sendAnother);
  $("finish-resume").addEventListener("click", () => setPlaying(true));
  $("stage-play").addEventListener("click", () => setPlaying(!state.playing));
  $("fs").addEventListener("click", enterFull);
  $("stage-exit").addEventListener("click", exitFull);
  ["file", "bs", "zip", "kc", "kdf"].forEach((id) => $(id).addEventListener("change", checkStale));
  $("pass").addEventListener("input", checkStale);
  // Rendering-only settings apply live: they change how a packet is drawn, not the stream.
  $("ecl").addEventListener("change", () => { state.ecl = $("ecl").value; redraw(); });
  $("px").addEventListener("change", redraw);
  $("fps").addEventListener("change", () => { fps(); state.due = 0; updateStats(); });
  let rz = 0;
  window.addEventListener("resize", () => { cancelAnimationFrame(rz); rz = requestAnimationFrame(redraw); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.focusMode) { exitFull(); return; }
    const t = e.target, tag = t && t.tagName;
    if (e.ctrlKey || e.metaKey || e.altKey || tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || (tag === "BUTTON" && (e.key === " " || e.key === "Enter"))) return;
    if (e.key === " " || e.key === "k" || e.key === "K") { if (state.session) { e.preventDefault(); setPlaying(!state.playing); } }
    else if (e.key === "f" || e.key === "F") { if (state.session) { e.preventDefault(); if (document.fullscreenElement || state.focusMode) exitFull(); else enterFull(); } }
  });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && state.playing) wake(true); });

  syncSteps(); syncPlayButton(); probeCamera();
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener("devicechange", probeCamera);
  // Test hook: render the next frame synchronously and return its PNG data URL (used by headless tests only).
  state.renderNextForTest = () => { showNext(); return $("qr").toDataURL("image/png"); };
})();
