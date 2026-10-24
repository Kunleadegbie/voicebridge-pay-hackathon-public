"use strict";

// Stage 3E-A: optional N-ATLAS RunPod speech-to-text ONLY.
// Audio remains on-device until the user reviews consent and clicks Transcribe.
// No speech transcript/intent is used to create, approve or capture PayPal orders.
(() => {
  const $ = (id) => document.getElementById(id);
  const start = $("natlas-record");
  const stop = $("natlas-stop");
  const submit = $("natlas-submit");
  const check = $("natlas-check");
  const capacity = $("natlas-capacity");
  const capacityStatus = $("natlas-capacity-status");
  const output = $("natlas-result");
  const status = $("natlas-status");
  const language = $("natlas-language");
  const passcode = $("natlas-passcode");
  const privacy = $("natlas-privacy");
  const supported = Boolean(navigator.mediaDevices?.getUserMedia) &&
    Boolean(window.AudioContext || window.webkitAudioContext);
  let stream = null;
  let context = null;
  let processor = null;
  let inputNode = null;
  let chunks = [];
  let recording = false;
  let inFlight = false;
  let localAudio = null;
  let capacityExhausted = false;
  let polls = 0;
  let timer = null;

  function message(value) { status.textContent = value; }
  function controls() {
    start.disabled = !supported || recording || inFlight || Boolean(check.dataset.pending);
    stop.disabled = !recording;
    submit.disabled = recording || inFlight || capacityExhausted ||
      !localAudio || !privacy.checked || !passcode.value.trim();
    check.disabled = inFlight || !check.dataset.pending;
    capacity.disabled = recording || inFlight || !passcode.value.trim();
  }
  function clearLocalAudio() { localAudio = null; chunks = []; controls(); }
  privacy.addEventListener("change", controls);
  passcode.addEventListener("input", () => {
    capacityExhausted = false;
    controls();
  });
  language.addEventListener("change", () => {
    clearLocalAudio();
    privacy.checked = false;
    message("Language changed. Record a new short sample; spoken words never approve a payment.");
  });
  if (!supported) {
    message("This browser cannot record WAV audio. Try another browser or use the separate typed checkout controls.");
  }
  controls();

  function wav16k(segments, sourceRate) {
    let total = 0;
    for (const chunk of segments) total += chunk.length;
    if (!total || !sourceRate) throw Error("No microphone audio");
    const merged = new Float32Array(total);
    let offset = 0;
    for (const chunk of segments) { merged.set(chunk, offset); offset += chunk.length; }
    const sampleCount = Math.floor(total * 16000 / sourceRate);
    if (sampleCount < 6400 || sampleCount > 16000 * 30) {
      throw Error("Please record between half a second and 25 seconds.");
    }
    const ab = new ArrayBuffer(44 + sampleCount * 2);
    const view = new DataView(ab);
    function txt(pos, str) {
      for (let i = 0; i < str.length; i++) view.setUint8(pos + i, str.charCodeAt(i));
    }
    txt(0, "RIFF");
    view.setUint32(4, 36 + sampleCount * 2, true);
    txt(8, "WAVE");
    txt(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);  // PCM
    view.setUint16(22, 1, true);  // mono
    view.setUint32(24, 16000, true);
    view.setUint32(28, 32000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    txt(36, "data");
    view.setUint32(40, sampleCount * 2, true);
    let peak = 0;
    for (let i = 0; i < sampleCount; i++) {
      const p = i * sourceRate / 16000;
      const a = Math.floor(p);
      const sample = (merged[a] || 0) * (1 - (p - a)) +
        (merged[Math.min(a + 1, total - 1)] || 0) * (p - a);
      peak = Math.max(peak, Math.abs(sample));
      const bounded = Math.max(-1, Math.min(1, sample));
      view.setInt16(44 + i * 2, bounded < 0 ? bounded * 32768 : bounded * 32767, true);
    }
    if (peak < 0.001) throw Error("Recording appears silent. Check microphone permissions.");
    // Small bounded payload; never use a giant spread-operator conversion.
    const bytes = new Uint8Array(ab);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    return btoa(binary);
  }

  async function stopRecording() {
    if (!recording) return;
    recording = false;
    if (timer) clearTimeout(timer);
    timer = null;
    processor?.disconnect();
    inputNode?.disconnect();
    stream?.getTracks().forEach(t => t.stop());
    try { await context?.close(); } catch { /* browser already closed */ }
    const oldContext = context;
    context = processor = inputNode = stream = null;
    try {
      localAudio = wav16k(chunks, oldContext.sampleRate);
      message("Recording ready locally. Review the privacy notice, enter your private demo passcode and press Transcribe.");
    } catch (error) {
      localAudio = null;
      message(error.message || "Recording could not be prepared.");
    }
    chunks = [];
    controls();
  }

  start.addEventListener("click", async () => {
    if (recording || inFlight || !supported) return;
    try {
      clearLocalAudio();
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true,
          autoGainControl: true }
      });
      context = new (window.AudioContext || window.webkitAudioContext)();
      await context.resume();
      inputNode = context.createMediaStreamSource(stream);
      processor = context.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (event) => {
        if (recording) chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      };
      inputNode.connect(processor);
      processor.connect(context.destination);
      recording = true;
      timer = setTimeout(() => { void stopRecording(); }, 25000);
      message("Recording. Speak for 2–20 seconds, without personal or financial secrets.");
    } catch {
      recording = false;
      stream?.getTracks().forEach(t => t.stop());
      try { await context?.close(); } catch { /* ignore */ }
      context = processor = inputNode = stream = null;
      message("Microphone unavailable. Check permissions and try again.");
    }
    controls();
  });
  stop.addEventListener("click", () => { void stopRecording(); });

  async function post(action, extra = {}) {
    const response = await fetch("/api/voice", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Requested-With": "VoiceBridgeVoice" },
      body: JSON.stringify({ action, ...extra }),
      cache: "no-store"
    });
    const data = await response.json();
    if (!response.ok || data.ok !== true) {
      if (data.reason === "natlas_not_configured") throw Error("N-ATLAS pilot is not activated on the cloud yet.");
      if (data.reason === "voice_demo_access_denied") throw Error("Demo passcode is incorrect.");
      if (data.reason === "voice_capacity_reached") {
        capacityExhausted = true;
        controls();
        throw Error("Shared N-ATLAS demo capacity is reached. Check demo capacity for the reset and remaining overall allowance.");
      }
      if (data.reason === "voice_quota_unavailable") {
        throw Error("N-ATLAS quota tracking is unavailable; submissions are safely paused.");
      }
      if (data.reason === "voice_job_expired") throw Error("Voice session expired. A new recording will be required.");
      if (data.reason === "voice_job_already_active") throw Error("An earlier recording is still processing. Check its result first.");
      throw Error("N-ATLAS transcription is temporarily unavailable; no payment action was taken.");
    }
    return data;
  }

  capacity.addEventListener("click", async () => {
    if (inFlight || recording || !passcode.value.trim()) return;
    inFlight = true;
    controls();
    capacityStatus.textContent = "Checking the shared quota. No recording is submitted.";
    try {
      const result = await post("capacity", { demo_passcode: passcode.value });
      if (!Number.isSafeInteger(result.remaining) || !Number.isSafeInteger(result.daily_limit) ||
          !Number.isSafeInteger(result.lifetime_remaining)) {
        throw Error("Capacity information is temporarily unavailable.");
      }
      capacityExhausted = result.remaining === 0;
      const daily = Math.max(0, result.daily_limit - result.daily_used);
      capacityStatus.textContent = "Shared N-ATLAS capacity: " + result.remaining +
        " submission(s) currently available. Daily allowance remaining: " + daily +
        ". Overall pilot allowance remaining: " + result.lifetime_remaining +
        ". Daily limit resets at " + result.reset_at_utc +
        " (UTC); the overall pilot limit does not reset automatically.";
    } catch (error) {
      capacityStatus.textContent = error.message || "Unable to check demo capacity.";
    } finally {
      inFlight = false;
      controls();
    }
  });

  async function checkStatus() {
    if (inFlight || !check.dataset.pending) return;
    inFlight = true;
    controls();
    try {
      const result = await post("status");
      if (result.status === "completed" && result.provider === "natlas") {
        output.textContent = result.transcript; // never innerHTML
        message("N-ATLAS transcription completed. Model: " + result.model_id +
          ". Review the transcript for accuracy; it cannot authorize a payment.");
        delete check.dataset.pending;
        clearLocalAudio();
      } else if (result.status === "failed") {
        delete check.dataset.pending;
        message("The N-ATLAS transcription job failed. No payment action was taken.");
      } else {
        message("N-ATLAS is still processing; you can check again.");
        if (++polls < 25) {
          timer = setTimeout(() => { void checkStatus(); }, 3000);
        } else {
          message("Still processing. Use Check transcription status later; no extra job was submitted.");
        }
      }
    } catch (error) {
      message(error.message || "Voice status unavailable. You can check again later.");
    } finally {
      inFlight = false;
      controls();
    }
  }
  check.addEventListener("click", () => { void checkStatus(); });
  submit.addEventListener("click", async () => {
    if (!localAudio || !privacy.checked || !passcode.value.trim() || inFlight) return;
    inFlight = true;
    controls();
    message("Submitting your recording to the restricted N-ATLAS test service…");
    output.textContent = "";
    try {
      const result = await post("submit", {
        language: language.value,
        audio_base64: localAudio,
        demo_passcode: passcode.value,
        confirm_privacy: true
      });
      if (result.status !== "processing") throw Error("Unexpected N-ATLAS job response.");
      clearLocalAudio();
      passcode.value = "";
      capacityExhausted = false;
      capacityStatus.textContent = "One new submission has been reserved. Re-enter the passcode and check capacity before another recording.";
      check.dataset.pending = "1";
      polls = 0;
      message("Recording submitted. N-ATLAS is processing your selected language.");
    } catch (error) {
      message(error.message || "The recording was not submitted.");
    } finally {
      inFlight = false;
      controls();
      if (check.dataset.pending) void checkStatus();
    }
  });
})();
