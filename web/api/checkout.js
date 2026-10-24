// Public browser -> Vercel function -> private Railway sandbox service.
// NEVER put CHECKOUT_SERVICE_KEY / CHECKOUT_SESSION_SECRET in browser assets.
// This pilot uses a signed, HttpOnly, short-lived browser order capability.
// Production use requires a durable ledger, abuse controls and webhook review.
import { createHmac, timingSafeEqual } from "node:crypto";

const ALLOWED_ORIGINS = new Set([
  "https://voicebridge-pay-hackathon-web.vercel.app",
  "https://voicebridgepay.chumcred.com"
]);
const COOKIE_NAME = "__Host-vbpay_checkout";
const ORDER_RE = /^[A-Z0-9]{8,36}$/;
const TTL = 45 * 60;

function header(req, name) {
  const value = req.headers?.[name];
  return Array.isArray(value) ? value[0] : (value || "");
}

function respond(res, status, payload, cookie) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (cookie) res.setHeader("Set-Cookie", cookie);
  res.end(JSON.stringify(payload));
}

function sign(orderId, secret, now = Date.now()) {
  const encoded = Buffer.from(JSON.stringify({
    order_id: orderId, exp: now + TTL * 1000
  })).toString("base64url");
  return encoded + "." + createHmac("sha256", secret).update(encoded).digest("base64url");
}

function extractSession(req, secret) {
  const cookie = header(req, "cookie").split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(COOKIE_NAME + "="));
  if (!cookie) return null;
  const token = cookie.slice(COOKIE_NAME.length + 1);
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [encoded, provided] = parts;
  const correct = createHmac("sha256", secret).update(encoded).digest();
  let supplied;
  try { supplied = Buffer.from(provided, "base64url"); }
  catch { return null; }
  if (supplied.length !== correct.length || !timingSafeEqual(supplied, correct)) return null;
  try {
    const data = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!ORDER_RE.test(data.order_id) || !Number.isSafeInteger(data.exp) || data.exp < Date.now()) {
      return null;
    }
    return data;
  } catch { return null; }
}

function configuration() {
  if (process.env.ENABLE_PUBLIC_DEMO_CHECKOUT !== "1") return null;
  const key = process.env.CHECKOUT_SERVICE_KEY || "";
  const secret = process.env.CHECKOUT_SESSION_SECRET || "";
  const backend = process.env.BACKEND_URL || "";
  if (key.length < 48 || secret.length < 48) return null;
  let url;
  try {
    url = new URL(backend);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash) return null;
  } catch { return null; }
  return { key, secret, url };
}

async function upstream(config, method, path, body) {
  const response = await fetch(new URL(path, config.url), {
    method,
    redirect: "error",
    cache: "no-store",
    headers: {
      "X-Checkout-Service-Key": config.key,
      "Accept": "application/json",
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(25000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const e = new Error("checkout_upstream_error");
    e.status = response.status === 409 ? 409 : 503;
    e.reason = response.status === 409 ? "not_approved_or_invalid" : "sandbox_service_unavailable";
    throw e;
  }
  return data;
}

// Fixed diagnostic categories only; never log PayPal payloads, approval URLs,
// tokens, cookies, service keys or customer identifiers.
function checkoutResponseError(reason) {
  const error = new Error("sandbox_checkout_validation_failed");
  error.status = 503;
  error.reason = reason;
  return error;
}

function verified(data, orderId) {
  return data?.order_id === orderId &&
    data.currency === "USD" &&
    String(data.amount) === "5.00" &&
    ["CREATED", "SAVED", "PAYER_ACTION_REQUIRED", "APPROVED", "COMPLETED",
      "VOIDED"].includes(data.status);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    respond(res, 405, { ok: false, reason: "method_not_allowed" });
    return;
  }
  const checkoutOrigin = header(req, "origin");
  // Match the browser's Origin to the request hostname: a hostile website
  // cannot use another approved host as a cross-site order-creation proxy.
  let sameHost = false;
  try {
    sameHost = new URL(checkoutOrigin).host === header(req, "host");
  } catch { /* origin absent or malformed */ }
  if (!ALLOWED_ORIGINS.has(checkoutOrigin) || !sameHost ||
      header(req, "x-requested-with") !== "VoiceBridgePay" ||
      !header(req, "content-type").toLowerCase().startsWith("application/json") ||
      (header(req, "sec-fetch-site") && header(req, "sec-fetch-site") !== "same-origin")) {
    respond(res, 403, { ok: false, reason: "origin_rejected" });
    return;
  }

  const config = configuration();
  if (!config) {
    respond(res, 503, { ok: false, reason: "checkout_not_configured" });
    return;
  }

  try {
    let body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    if (!body || typeof body !== "object" ||
        JSON.stringify(body).length > 1500 || Array.isArray(body)) {
      respond(res, 400, { ok: false, reason: "invalid_request" });
      return;
    }

    const session = extractSession(req, config.secret);

    if (body.action === "create") {
      if (body.confirm !== true || body.item_code !== "financial-literacy-demo") {
        respond(res, 422, { ok: false, reason: "confirmation_required" });
        return;
      }
      // Do not open multiple orders for the same browser session.
      if (session) {
        const previous = await upstream(config, "GET",
          "/api/internal/checkout/orders/" + session.order_id + "/status");
        if (verified(previous, session.order_id) &&
            !["COMPLETED", "VOIDED"].includes(previous.status)) {
          respond(res, 409, { ok: false, reason: "order_already_in_progress" });
          return;
        }
      }
      const created = await upstream(config, "POST", "/api/internal/checkout/orders",
        {
          item_code: "financial-literacy-demo",
          checkout_origin: checkoutOrigin
        });
      // PayPal Orders v2 can create wallet orders in PAYER_ACTION_REQUIRED
      // (rather than CREATED) when payment_source.paypal is supplied.
      // The buyer must still approve on PayPal. Neither status allows capture.
      if (!ORDER_RE.test(created?.order_id) || created.currency !== "USD" ||
          String(created.amount) !== "5.00") {
        throw checkoutResponseError("sandbox_order_response_invalid");
      }
      if (!["CREATED", "PAYER_ACTION_REQUIRED"].includes(created.status)) {
        throw checkoutResponseError("sandbox_order_status_unexpected");
      }
      // Never redirect to an arbitrary URL, even if Railway or PayPal
      // returned an unexpected value. This also avoids leaking a token.
      let approve;
      try { approve = new URL(created.approve_url); }
      catch { throw checkoutResponseError("sandbox_approval_link_invalid"); }
      if (approve.origin !== "https://www.sandbox.paypal.com" ||
          approve.username || approve.password ||
          !approve.pathname.startsWith("/checkoutnow") ||
          !approve.searchParams.has("token")) {
        throw checkoutResponseError("sandbox_approval_link_invalid");
      }
      const cookie = COOKIE_NAME + "=" + sign(created.order_id, config.secret) +
        "; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=" + TTL;
      respond(res, 201, {
        ok: true, order_id: created.order_id, status: created.status,
        amount: "5.00", currency: "USD", approve_url: approve.toString()
      }, cookie);
      return;
    }

    if (!session) {
      respond(res, 401, { ok: false, reason: "session_expired" });
      return;
    }
    if (!["status", "capture"].includes(body.action)) {
      respond(res, 400, { ok: false, reason: "invalid_action" });
      return;
    }
    const status = await upstream(config, "GET",
      "/api/internal/checkout/orders/" + session.order_id + "/status");
    if (!verified(status, session.order_id)) {
      respond(res, 409, { ok: false, reason: "order_mismatch" });
      return;
    }
    if (body.action === "status") {
      respond(res, 200, { ok: true, ...status });
      return;
    }

    // Capture only from a separate deliberate browser click after PayPal
    // authorization; both this function and the Railway API recheck approval.
    if (body.confirm !== true) {
      respond(res, 422, { ok: false, reason: "confirmation_required" });
      return;
    }
    if (status.status === "COMPLETED" && status.capture_status === "COMPLETED") {
      respond(res, 200, { ok: true, ...status });
      return;
    }
    if (status.status !== "APPROVED") {
      respond(res, 409, { ok: false, reason: "buyer_approval_required" });
      return;
    }
    let captured;
    try {
      captured = await upstream(config, "POST",
        "/api/internal/checkout/orders/" + session.order_id + "/capture",
        { confirm: true });
      if (!verified(captured, session.order_id) ||
          captured.status !== "COMPLETED" || captured.capture_status !== "COMPLETED") {
        throw new Error("Sandbox capture response was not verifiably completed");
      }
    } catch {
      // Once a capture request has been attempted, do NOT issue another POST.
      // PayPal may have completed the operation despite a 502, transport
      // failure or missing response. Query the same signed order read-only.
      try {
        const reconciled = await upstream(config, "GET",
          "/api/internal/checkout/orders/" + session.order_id + "/status");
        if (verified(reconciled, session.order_id) &&
            reconciled.status === "COMPLETED" && reconciled.capture_status === "COMPLETED" &&
            typeof reconciled.capture_id === "string" && reconciled.capture_id.length > 0) {
          respond(res, 200, { ok: true, ...reconciled, recovered: true });
          return;
        }
      } catch {
        // Recovery failures remain ambiguous, never an instruction to retry capture.
      }
      respond(res, 503, { ok: false, reason: "capture_status_uncertain" });
      return;
    }
    respond(res, 200, { ok: true, ...captured });
  } catch (error) {
    // Log only a fixed internal failure category; never log raw exception,
    // upstream content, sandbox approval URLs, tokens, cookies or credentials.
    const safeFailures = [
      "sandbox_order_response_invalid",
      "sandbox_order_status_unexpected",
      "sandbox_approval_link_invalid"
    ];
    if (safeFailures.includes(error?.reason)) {
      console.error("stage3d_checkout_validation:", error.reason);
    }
    // Never echo PayPal error bodies, credentials or private headers.
    respond(res, error.status || 503, {
      ok: false, reason: error.reason || "sandbox_service_unavailable"
    });
  }
}
