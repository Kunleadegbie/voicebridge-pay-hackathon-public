import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import handler from "../api/voice.js";

const originalFetch = globalThis.fetch;
const keys = [
  "ENABLE_NATLAS_VOICE", "VOICE_SERVICE_KEY", "VOICE_DEMO_PASSCODE",
  "CHECKOUT_SESSION_SECRET", "BACKEND_URL"
];
const oldEnv = Object.fromEntries(keys.map(k => [k, process.env[k]]));

function request(action, extra = {}, origin = "https://voicebridgepay.chumcred.com") {
  return {
    method: "POST",
    headers: {
      origin,
      host: "voicebridgepay.chumcred.com",
      "x-requested-with": "VoiceBridgeVoice",
      "content-type": "application/json",
      "sec-fetch-site": "same-origin"
    },
    body: { action, ...extra }
  };
}

function response() {
  return {
    statusCode: null,
    headers: {},
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    end(body) { this.payload = JSON.parse(body); }
  };
}

beforeEach(() => {
  process.env.ENABLE_NATLAS_VOICE = "1";
  process.env.VOICE_SERVICE_KEY = "v".repeat(64);
  process.env.VOICE_DEMO_PASSCODE = "example-private-passcode-12345";
  process.env.CHECKOUT_SESSION_SECRET = "x".repeat(64);
  process.env.BACKEND_URL = "https://voicebridge-pay-hackathon-production.up.railway.app";
});

afterEach(() => {
  for (const k of keys) {
    if (oldEnv[k] === undefined) delete process.env[k];
    else process.env[k] = oldEnv[k];
  }
  globalThis.fetch = originalFetch;
});

test("capacity check requires passcode and never contacts backend for rejected code", async () => {
  globalThis.fetch = async () => { throw new Error("should not contact backend"); };
  const res = response();
  await handler(request("capacity", { demo_passcode: "wrong" }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.payload.reason, "voice_demo_access_denied");
});

test("capacity check is read-only with no audio, RunPod or PayPal requests", async () => {
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(options.method, "GET");
    assert.equal(new URL(url).pathname, "/api/internal/voice/capacity");
    assert.equal(options.headers["X-Voice-Service-Key"], "v".repeat(64));
    assert.equal(options.body, undefined);
    return new Response(JSON.stringify({
      status: "available", remaining: 2, daily_limit: 12, daily_used: 10,
      lifetime_remaining: 15, reset_at_utc: "2026-10-19T00:00:00Z"
    }), { status: 200 });
  };
  const res = response();
  await handler(request("capacity", {
    demo_passcode: "example-private-passcode-12345"
  }), res);
  assert.equal(calls, 1);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.remaining, 2);
  assert.equal(res.payload.ok, true);
  assert.equal(res.headers["cache-control"], "no-store");
});

test("quota failure passes through without misleading a user about remaining time", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    detail: "Voice demo capacity reached"
  }), { status: 429 });
  const res = response();
  await handler(request("submit", {
    demo_passcode: "example-private-passcode-12345",
    language: "ha-NG",
    confirm_privacy: true,
    audio_base64: "a".repeat(128)
  }), res);
  assert.equal(res.statusCode, 429);
  assert.equal(res.payload.reason, "voice_capacity_reached");
});

test("quota store outage is fail-closed and distinct from a daily limit", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    detail: "Voice demo capacity service unavailable"
  }), { status: 503 });
  const res = response();
  await handler(request("capacity", {
    demo_passcode: "example-private-passcode-12345"
  }), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.payload.reason, "voice_quota_unavailable");
});

test("cross-origin capacity probes are rejected before remote access", async () => {
  globalThis.fetch = async () => { throw new Error("unexpected request"); };
  const res = response();
  await handler(request("capacity", {
    demo_passcode: "example-private-passcode-12345"
  }, "https://attacker.example"), res);
  assert.equal(res.statusCode, 403);
});
