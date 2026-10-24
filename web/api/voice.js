// Isolated N-ATLAS voice demo gateway. Not connected to payment authorization.
// Voice recordings are sent only after an explicit user action and passcode.
// Browser never receives provider credentials or Voice-Service-Key.
import { createHmac, createHash, timingSafeEqual } from "node:crypto";

const ALLOWED_ORIGINS = new Set([
  "https://voicebridgepay.chumcred.com",
  "https://voicebridge-pay-hackathon-web.vercel.app"
]);
const VOICE_COOKIE = "__Host-vbpay_voice_job";
const JOB_RE = /^[A-Za-z0-9_-]{8,128}$/;
const LANGUAGES = new Set(["en-NG", "yo-NG", "ha-NG", "ig-NG"]);
const TTL_MS = 12 * 60 * 1000;
const BACKEND = "https://voicebridge-pay-hackathon-production.up.railway.app/";

function h(req, key) {
  const value = req.headers?.[key];
  return Array.isArray(value) ? value[0] : (value || "");
}

function respond(res, status, body, cookie) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (cookie) res.setHeader("Set-Cookie", cookie);
  res.end(JSON.stringify(body));
}

function configuration() {
  if (process.env.ENABLE_NATLAS_VOICE !== "1") return null;
  const key = process.env.VOICE_SERVICE_KEY || "";
  const pin = process.env.VOICE_DEMO_PASSCODE || "";
  const secret = process.env.CHECKOUT_SESSION_SECRET || "";
  if (key.length < 48 || secret.length < 48 || pin.length < 12 || pin.length > 128 ||
      process.env.BACKEND_URL !== BACKEND.slice(0, -1)) return null;
  return { key, pin, secret };
}

function cookieToken(jobId, language, secret) {
  const body = Buffer.from(JSON.stringify({
    job_id: jobId, language, exp: Date.now() + TTL_MS
  })).toString("base64url");
  const signature = createHmac("sha256", secret).update("voice:" + body).digest("base64url");
  return body + "." + signature;
}

function readCookie(req, secret) {
  const raw = h(req, "cookie").split(";").map(s => s.trim())
    .find(s => s.startsWith(VOICE_COOKIE + "="));
  if (!raw) return null;
  const token = raw.slice(VOICE_COOKIE.length + 1);
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const expected = createHmac("sha256", secret).update("voice:" + parts[0]).digest();
  let supplied;
  try { supplied = Buffer.from(parts[1], "base64url"); }
  catch { return null; }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  try {
    const value = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (!JOB_RE.test(value.job_id) || !LANGUAGES.has(value.language) ||
        !Number.isSafeInteger(value.exp) || value.exp <= Date.now() ||
        value.exp > Date.now() + TTL_MS) return null;
    return value;
  } catch { return null; }
}

function validateCode(value, expected) {
  if (typeof value !== "string" || value.length > 128) return false;
  const actual = createHash("sha256").update(value).digest();
  const trusted = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actual, trusted);
}

async function callBackend(config, method, path, body) {
  const response = await fetch(new URL(path, BACKEND), {
    method,
    redirect: "error",
    cache: "no-store",
    headers: {
      "X-Voice-Service-Key": config.key,
      "Accept": "application/json",
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(18000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 429) return { error: "voice_capacity_reached" };
    if (response.status === 503 &&
        data.detail === "Voice demo capacity service unavailable") {
      return { error: "voice_quota_unavailable" };
    }
    if (response.status === 422) return { error: "invalid_recording" };
    return { error: "voice_provider_unavailable" };
  }
  return { data };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    respond(res, 405, { ok: false, reason: "method_not_allowed" });
    return;
  }
  const origin = h(req, "origin");
  let sameHost = false;
  try { sameHost = new URL(origin).host === h(req, "host"); }
  catch { /* reject */ }
  if (!ALLOWED_ORIGINS.has(origin) || !sameHost ||
      h(req, "x-requested-with") !== "VoiceBridgeVoice" ||
      !h(req, "content-type").toLowerCase().startsWith("application/json") ||
      (h(req, "sec-fetch-site") && h(req, "sec-fetch-site") !== "same-origin")) {
    respond(res, 403, { ok: false, reason: "origin_rejected" });
    return;
  }
  const config = configuration();
  if (!config) {
    respond(res, 503, { ok: false, reason: "natlas_not_configured" });
    return;
  }
  const data = typeof req.body === "string" ? (() => {
    try { return JSON.parse(req.body); } catch { return null; }
  })() : req.body;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    respond(res, 400, { ok: false, reason: "invalid_request" });
    return;
  }
  try {
    if (data.action === "capacity") {
      if (!validateCode(data.demo_passcode, config.pin)) {
        respond(res, 403, { ok: false, reason: "voice_demo_access_denied" });
        return;
      }
      const upstream = await callBackend(config, "GET", "/api/internal/voice/capacity");
      if (upstream.error) {
        respond(res, 503, { ok: false, reason: upstream.error });
        return;
      }
      const capacity = upstream.data;
      if (!capacity || !["available", "reached"].includes(capacity.status) ||
          !Number.isSafeInteger(capacity.remaining) || capacity.remaining < 0 ||
          !Number.isSafeInteger(capacity.daily_limit) || capacity.daily_limit < 1 ||
          !Number.isSafeInteger(capacity.daily_used) || capacity.daily_used < 0 ||
          !Number.isSafeInteger(capacity.lifetime_remaining) ||
          capacity.lifetime_remaining < 0 ||
          typeof capacity.reset_at_utc !== "string" ||
          !/^\d{4}-\d{2}-\d{2}T00:00:00Z$/.test(capacity.reset_at_utc)) {
        respond(res, 503, { ok: false, reason: "voice_quota_unavailable" });
        return;
      }
      respond(res, 200, { ok: true, ...capacity });
      return;
    }
    if (data.action === "submit") {
      if (!validateCode(data.demo_passcode, config.pin)) {
        respond(res, 403, { ok: false, reason: "voice_demo_access_denied" });
        return;
      }
      if (!LANGUAGES.has(data.language) || data.confirm_privacy !== true ||
          typeof data.audio_base64 !== "string" ||
          data.audio_base64.length < 56 || data.audio_base64.length > 1_420_000) {
        respond(res, 422, { ok: false, reason: "invalid_recording" });
        return;
      }
      if (readCookie(req, config.secret)) {
        respond(res, 409, { ok: false, reason: "voice_job_already_active" });
        return;
      }
      const upstream = await callBackend(config, "POST", "/api/internal/voice/submit", {
        language: data.language,
        audio_base64: data.audio_base64,
        confirm_privacy: true
      });
      if (upstream.error) {
        respond(res, upstream.error === "voice_capacity_reached" ? 429 : 503,
          { ok: false, reason: upstream.error });
        return;
      }
      if (!JOB_RE.test(upstream.data?.job_id) || upstream.data.status !== "processing" ||
          upstream.data.language !== data.language) {
        respond(res, 503, { ok: false, reason: "voice_job_response_invalid" });
        return;
      }
      const cookie = VOICE_COOKIE + "=" +
        cookieToken(upstream.data.job_id, data.language, config.secret) +
        "; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=720";
      respond(res, 202, { ok: true, status: "processing", language: data.language }, cookie);
      return;
    }
    if (data.action !== "status") {
      respond(res, 400, { ok: false, reason: "invalid_action" });
      return;
    }
    const session = readCookie(req, config.secret);
    if (!session) {
      respond(res, 401, { ok: false, reason: "voice_job_expired" });
      return;
    }
    const upstream = await callBackend(config, "GET",
      "/api/internal/voice/status/" + session.job_id +
      "?language=" + encodeURIComponent(session.language));
    if (upstream.error) {
      respond(res, 503, { ok: false, reason: upstream.error });
      return;
    }
    const result = upstream.data;
    if (result?.status === "processing" || result?.status === "failed") {
      respond(res, 200, { ok: true, status: result.status });
      return;
    }
    if (result?.status !== "completed" || result.provider !== "natlas" ||
        result.language !== session.language || typeof result.transcript !== "string" ||
        !result.transcript.trim() || result.transcript.length > 1000 ||
        !/^NCAIR1\/[A-Za-z0-9-]+$/.test(result.model_id || "")) {
      respond(res, 503, { ok: false, reason: "natlas_result_invalid" });
      return;
    }
    // Provenance is checked again against a fixed model catalog, never a
    // model name supplied by the client or by an unverified LLM response.
    const expected = {
      "en-NG": "NCAIR1/NigerianAccentedEnglish",
      "yo-NG": "NCAIR1/Yoruba-ASR",
      "ha-NG": "NCAIR1/Hausa-ASR",
      "ig-NG": "NCAIR1/Igbo-ASR"
    };
    if (result.model_id !== expected[session.language]) {
      respond(res, 503, { ok: false, reason: "natlas_result_invalid" });
      return;
    }
    respond(res, 200, {
      ok: true, status: "completed", transcript: result.transcript,
      language: session.language, provider: "natlas", model_id: result.model_id,
      duration_ms: result.duration_ms
    }, VOICE_COOKIE + "=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
  } catch {
    respond(res, 503, { ok: false, reason: "voice_provider_unavailable" });
  }
}
