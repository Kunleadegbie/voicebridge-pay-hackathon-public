import test from "node:test";
import assert from "node:assert/strict";
import handler from "../api/voice.js";

const ORIGIN = "https://voicebridgepay.chumcred.com";
const JOB = "VoiceJob123456";
const model = "NCAIR1/Yoruba-ASR";
const oldEnv = { ...process.env };
const oldFetch = globalThis.fetch;

function configure() {
  process.env.BACKEND_URL = "https://voicebridge-pay-hackathon-production.up.railway.app";
  process.env.ENABLE_NATLAS_VOICE = "1";
  process.env.VOICE_SERVICE_KEY = "v".repeat(64);
  process.env.CHECKOUT_SESSION_SECRET = "s".repeat(64);
  process.env.VOICE_DEMO_PASSCODE = "private-demo-passcode";
}
function request(body, cookie = "") {
  return {
    method: "POST",
    headers: {
      origin: ORIGIN, host: "voicebridgepay.chumcred.com",
      "content-type": "application/json", "x-requested-with": "VoiceBridgeVoice",
      "sec-fetch-site": "same-origin", cookie
    },
    body
  };
}
function response() {
  const headers = new Map();
  return {
    statusCode: 200, headers, data: null,
    setHeader(k, v) { headers.set(k.toLowerCase(), v); },
    end(raw) { this.data = JSON.parse(raw); }
  };
}
function sample() { return "AA".repeat(100); }
function submitBody(passcode = "private-demo-passcode", language = "yo-NG") {
  return {
    action: "submit", language, audio_base64: sample(),
    demo_passcode: passcode, confirm_privacy: true
  };
}
test("isolated voice gateway fails closed by default", async () => {
  delete process.env.ENABLE_NATLAS_VOICE;
  const r = response();
  await handler(request(submitBody()), r);
  assert.equal(r.statusCode, 503);
  assert.equal(r.data.reason, "natlas_not_configured");
});

test("rejects forged origins, invalid passcodes and missing consent", async () => {
  configure();
  const forged = request(submitBody());
  forged.headers.origin = "https://other.example";
  let r = response();
  await handler(forged, r);
  assert.equal(r.statusCode, 403);
  r = response();
  await handler(request(submitBody("wrong-code")), r);
  assert.equal(r.statusCode, 403);
  assert.equal(r.data.reason, "voice_demo_access_denied");
  r = response();
  await handler(request({ ...submitBody(), confirm_privacy: false }), r);
  assert.equal(r.statusCode, 422);
});

test("session binds exact job and model; no provider credentials or automatic payment action", async () => {
  configure();
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const target = new URL(url);
    calls.push({ path: target.pathname, method: opts.method, auth: opts.headers["X-Voice-Service-Key"] });
    if (opts.method === "POST") {
      const body = JSON.parse(opts.body);
      assert.equal(body.language, "yo-NG");
      assert.equal(body.audio_base64, sample());
      assert.equal(body.confirm_privacy, true);
      return new Response(JSON.stringify({
        job_id: JOB, status: "processing", language: "yo-NG"
      }), { status: 202 });
    }
    assert.match(target.search, /language=yo-NG/);
    return new Response(JSON.stringify({
      status: "completed", language: "yo-NG",
      provider: "natlas", model_id: model,
      transcript: "Ẹ káàárọ̀", duration_ms: 800
    }), { status: 200 });
  };
  const submitted = response();
  await handler(request(submitBody()), submitted);
  assert.equal(submitted.statusCode, 202);
  assert.equal(submitted.data.status, "processing");
  assert.equal(JSON.stringify(submitted.data).includes(JOB), false);
  assert.equal(JSON.stringify(submitted.data).includes("private-demo-passcode"), false);
  const cookie = submitted.headers.get("set-cookie").split(";")[0];
  assert.match(cookie, /__Host-vbpay_voice_job=/);
  const polled = response();
  await handler(request({ action: "status" }, cookie), polled);
  assert.equal(polled.statusCode, 200);
  assert.equal(polled.data.transcript, "Ẹ káàárọ̀");
  assert.equal(polled.data.model_id, model);
  assert.equal(polled.data.provider, "natlas");
  assert.equal(calls.filter(x=>x.method==="POST").length, 1);
  assert.equal(calls.every(x=>x.auth === "v".repeat(64)), true);
  assert.equal(calls.every(x=>!x.path.includes("/paypal/")), true);
});

test("tampered job cookie cannot read another voice transcription", async () => {
  configure();
  globalThis.fetch = async () => new Response(JSON.stringify({
    job_id: JOB, status: "processing", language: "yo-NG"
  }), { status: 202 });
  const submitted = response();
  await handler(request(submitBody()), submitted);
  const cookie = submitted.headers.get("set-cookie").split(";")[0];
  const altered = cookie.slice(0, -3) + "XXX";
  const polled = response();
  await handler(request({ action: "status" }, altered), polled);
  assert.equal(polled.statusCode, 401);
});

test("model spoofing response from backend is rejected", async () => {
  configure();
  globalThis.fetch = async (url, opts) => new Response(JSON.stringify(
    opts.method === "POST"
      ? { job_id: JOB, status: "processing", language: "yo-NG" }
      : { status: "completed", transcript: "fake", provider: "natlas",
          language: "yo-NG", model_id: "NCAIR1/NigerianAccentedEnglish", duration_ms: 800 }
  ), { status: 200 });
  const created = response();
  await handler(request(submitBody()), created);
  assert.equal(created.statusCode, 202);
  const checked = response();
  await handler(request({ action: "status" }, created.headers.get("set-cookie").split(";")[0]), checked);
  assert.equal(checked.statusCode, 503);
  assert.equal(checked.data.reason, "natlas_result_invalid");
});

test.after(() => {
  globalThis.fetch = oldFetch;
  for (const k of ["BACKEND_URL", "ENABLE_NATLAS_VOICE", "VOICE_SERVICE_KEY", "CHECKOUT_SESSION_SECRET", "VOICE_DEMO_PASSCODE"]) {
    if (oldEnv[k] === undefined) delete process.env[k];
    else process.env[k] = oldEnv[k];
  }
});
