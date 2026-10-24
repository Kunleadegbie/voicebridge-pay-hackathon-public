import test from "node:test";
import assert from "node:assert/strict";
import handler from "../api/checkout.js";

const ORIGIN = "https://voicebridge-pay-hackathon-web.vercel.app";
const ID = "2E2603450P696001B";
const APPROVE = "https://www.sandbox.paypal.com/checkoutnow?token=TEST-ORDER";
const saved = { ...process.env };
const originalFetch = globalThis.fetch;

function configure() {
  process.env.BACKEND_URL = "https://voicebridge-pay-hackathon-production.up.railway.app";
  process.env.ENABLE_PUBLIC_DEMO_CHECKOUT = "1";
  process.env.CHECKOUT_SERVICE_KEY = "k".repeat(64);
  process.env.CHECKOUT_SESSION_SECRET = "s".repeat(64);
}

function makeRequest(body, cookie = "") {
  return {
    method: "POST",
    headers: {
      "origin": ORIGIN,
      "host": new URL(ORIGIN).host,
      "content-type": "application/json",
      "x-requested-with": "VoiceBridgePay",
      "sec-fetch-site": "same-origin",
      "cookie": cookie
    },
    body
  };
}

function makeResponse() {
  const headers = new Map();
  return {
    statusCode: 200, headers, data: null,
    setHeader(k, v) { headers.set(k.toLowerCase(), v); },
    end(value) { this.data = JSON.parse(value); }
  };
}

function upstream(approved = false, orderStatus = "CREATED", approvalUrl = APPROVE) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const target = new URL(url);
    calls.push({
      path: target.pathname,
      method: opts.method,
      key: opts.headers["X-Checkout-Service-Key"],
      body: opts.body ? JSON.parse(opts.body) : null
    });
    if (target.pathname === "/api/internal/checkout/orders" && opts.method === "POST") {
      return new Response(JSON.stringify({
        order_id: ID, status: orderStatus, currency: "USD",
        amount: "5.00", approve_url: approvalUrl
      }), { status: 201 });
    }
    if (target.pathname.endsWith("/status")) {
      return new Response(JSON.stringify({
        order_id: ID, status: approved ? "APPROVED" : "CREATED",
        currency: "USD", amount: "5.00", capture_status: null, capture_id: null
      }), { status: 200 });
    }
    if (target.pathname.endsWith("/capture") && opts.method === "POST") {
      return new Response(JSON.stringify({
        order_id: ID, status: "COMPLETED", currency: "USD",
        amount: "5.00", capture_status: "COMPLETED", capture_id: "DEMO-CAPTURE-ID"
      }), { status: 200 });
    }
    throw new Error("Unexpected upstream request");
  };
  return calls;
}

test("feature disabled by default", async () => {
  delete process.env.ENABLE_PUBLIC_DEMO_CHECKOUT;
  const response = makeResponse();
  await handler(makeRequest({ action: "create", item_code: "financial-literacy-demo", confirm: true }), response);
  assert.equal(response.statusCode, 503);
  assert.equal(response.data.reason, "checkout_not_configured");
});

test("rejects cross-origin and missing deliberate click header", async () => {
  configure();
  let request = makeRequest({ action: "create", item_code: "financial-literacy-demo", confirm: true });
  request.headers.origin = "https://attacker.example";
  let response = makeResponse();
  await handler(request, response);
  assert.equal(response.statusCode, 403);
  request = makeRequest({ action: "create", item_code: "financial-literacy-demo", confirm: true });
  delete request.headers["x-requested-with"];
  response = makeResponse();
  await handler(request, response);
  assert.equal(response.statusCode, 403);
});

test("explicit confirmation and fixed catalog item mandatory", async () => {
  configure();
  let response = makeResponse();
  await handler(makeRequest({ action: "create", item_code: "financial-literacy-demo", confirm: false }), response);
  assert.equal(response.statusCode, 422);
  response = makeResponse();
  await handler(makeRequest({ action: "create", item_code: "evil-price", confirm: true }), response);
  assert.equal(response.statusCode, 422);
});

test("create signed cookie, verify payment, block premature capture", async () => {
  configure();
  const calls = upstream(false);
  const created = makeResponse();
  await handler(makeRequest({ action: "create", item_code: "financial-literacy-demo", confirm: true }), created);
  assert.equal(created.statusCode, 201);
  assert.equal(created.data.approve_url, APPROVE);
  const cookie = created.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly; Secure; SameSite=Lax; Path=\//);
  const cookieValue = cookie.split(";")[0];
  const verified = makeResponse();
  await handler(makeRequest({ action: "status" }, cookieValue), verified);
  assert.equal(verified.statusCode, 200);
  assert.equal(verified.data.status, "CREATED");
  const premature = makeResponse();
  await handler(makeRequest({ action: "capture", confirm: true }, cookieValue), premature);
  assert.equal(premature.statusCode, 409);
  assert.equal(premature.data.reason, "buyer_approval_required");
  assert.equal(calls.some((x) => x.path.endsWith("/capture")), false);
  assert.equal(calls.every((x) => x.key === "k".repeat(64)), true);
  assert.equal(calls.find(x => x.path === "/api/internal/checkout/orders").body.checkout_origin, ORIGIN);
});

test("PayPal wallet PAYER_ACTION_REQUIRED is a valid new buyer approval state", async () => {
  configure();
  // Official PayPal Orders v2 documents PAYER_ACTION_REQUIRED when a
  // payment_source.paypal is supplied in the create-order payload.
  const calls = upstream(false, "PAYER_ACTION_REQUIRED");
  const created = makeResponse();
  await handler(makeRequest({
    action: "create", item_code: "financial-literacy-demo", confirm: true
  }), created);
  assert.equal(created.statusCode, 201);
  assert.equal(created.data.status, "PAYER_ACTION_REQUIRED");
  assert.equal(created.data.currency, "USD");
  assert.equal(created.data.amount, "5.00");
  assert.equal(created.data.approve_url, APPROVE);
  const signed = created.headers.get("set-cookie");
  assert.match(signed, /HttpOnly; Secure; SameSite=Lax/);
  const premature = makeResponse();
  await handler(makeRequest({
    action: "capture", confirm: true
  }, signed.split(";")[0]), premature);
  assert.equal(premature.statusCode, 409);
  assert.equal(premature.data.reason, "buyer_approval_required");
  assert.equal(calls.some(x => x.path.endsWith("/capture")), false);
});

test("unexpected order status fails closed with sanitized reason", async () => {
  configure();
  upstream(false, "FAILED");
  const result = makeResponse();
  await handler(makeRequest({
    action: "create", item_code: "financial-literacy-demo", confirm: true
  }), result);
  assert.equal(result.statusCode, 503);
  assert.equal(result.data.reason, "sandbox_order_status_unexpected");
  assert.equal(result.headers.has("set-cookie"), false);
});

test("untrusted PayPal approval link is rejected without a signed session", async () => {
  configure();
  upstream(false, "PAYER_ACTION_REQUIRED", "https://fake-paypal.example/checkoutnow?token=attacker");
  const result = makeResponse();
  await handler(makeRequest({
    action: "create", item_code: "financial-literacy-demo", confirm: true
  }), result);
  assert.equal(result.statusCode, 503);
  assert.equal(result.data.reason, "sandbox_approval_link_invalid");
  assert.equal(result.headers.has("set-cookie"), false);
});

test("missing PayPal approval link fails closed with no session cookie", async () => {
  configure();
  upstream(false, "PAYER_ACTION_REQUIRED", null);
  const result = makeResponse();
  await handler(makeRequest({
    action: "create", item_code: "financial-literacy-demo", confirm: true
  }), result);
  assert.equal(result.statusCode, 503);
  assert.equal(result.data.reason, "sandbox_approval_link_invalid");
  assert.equal(result.headers.has("set-cookie"), false);
});

test("approved order captured only with explicit independent confirmation", async () => {
  configure();
  const calls = upstream(true);
  const created = makeResponse();
  await handler(makeRequest({ action: "create", item_code: "financial-literacy-demo", confirm: true }), created);
  const cookie = created.headers.get("set-cookie").split(";")[0];
  const bad = makeResponse();
  await handler(makeRequest({ action: "capture", confirm: false }, cookie), bad);
  assert.equal(bad.statusCode, 422);
  assert.equal(calls.some((x) => x.path.endsWith("/capture")), false);
  const capture = makeResponse();
  await handler(makeRequest({ action: "capture", confirm: true }, cookie), capture);
  assert.equal(capture.statusCode, 200);
  assert.equal(capture.data.status, "COMPLETED");
  assert.equal(capture.data.capture_status, "COMPLETED");
  assert.equal(calls.filter((x) => x.path.endsWith("/capture")).length, 1);
});

test("tampered session cookie cannot approve or capture", async () => {
  configure();
  const calls = upstream(true);
  const created = makeResponse();
  await handler(makeRequest({ action: "create", item_code: "financial-literacy-demo", confirm: true }), created);
  const cookie = created.headers.get("set-cookie").split(";")[0];
  const tampered = cookie.slice(0, -4) + "XXXX";
  const response = makeResponse();
  await handler(makeRequest({ action: "capture", confirm: true }, tampered), response);
  assert.equal(response.statusCode, 401);
  assert.equal(calls.some((x) => x.path.endsWith("/capture")), false);
});


test("custom Chumcred domain binds checkout to same custom-domain callback", async () => {
  configure();
  const calls = upstream(false);
  const request = makeRequest({ action: "create", item_code: "financial-literacy-demo", confirm: true });
  request.headers.origin = "https://voicebridgepay.chumcred.com";
  request.headers.host = "voicebridgepay.chumcred.com";
  const result = makeResponse();
  await handler(request, result);
  assert.equal(result.statusCode, 201);
  assert.equal(calls.find(x => x.path === "/api/internal/checkout/orders").body.checkout_origin,
    "https://voicebridgepay.chumcred.com");
  assert.match(result.headers.get("set-cookie"), /HttpOnly; Secure; SameSite=Lax/);
});

test("rejects legitimate-origin header with mismatched request host", async () => {
  configure();
  const request = makeRequest({ action: "create", item_code: "financial-literacy-demo", confirm: true });
  request.headers.origin = "https://voicebridgepay.chumcred.com";
  request.headers.host = "attacker.example";
  const res = makeResponse();
  await handler(request, res);
  assert.equal(res.statusCode, 403);
});

test("rejects forged custom-domain suffix, despite matching host", async () => {
  configure();
  const request = makeRequest({ action: "create", item_code: "financial-literacy-demo", confirm: true });
  request.headers.origin = "https://voicebridgepay.chumcred.com.attacker.example";
  request.headers.host = "voicebridgepay.chumcred.com.attacker.example";
  const res = makeResponse();
  await handler(request, res);
  assert.equal(res.statusCode, 403);
});

test("capture gateway 502 is recovered by authoritative read-only COMPLETED order", async () => {
  configure();
  let statusReads = 0;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: opts.method });
    if (path === "/api/internal/checkout/orders") {
      return new Response(JSON.stringify({
        order_id: ID, status: "PAYER_ACTION_REQUIRED", currency: "USD",
        amount: "5.00", approve_url: APPROVE
      }), { status: 201 });
    }
    if (path.endsWith("/status")) {
      statusReads++;
      const done = statusReads >= 2;
      return new Response(JSON.stringify({
        order_id: ID, status: done ? "COMPLETED" : "APPROVED",
        currency: "USD", amount: "5.00",
        capture_status: done ? "COMPLETED" : null,
        capture_id: done ? "CAPTURE-RECOVERED-01" : null
      }), { status: 200 });
    }
    if (path.endsWith("/capture")) {
      return new Response(JSON.stringify({ detail: "upstream capture response error" }), {
        status: 502
      });
    }
    throw Error("Unexpected test request");
  };
  const order = makeResponse();
  await handler(makeRequest({
    action: "create", item_code: "financial-literacy-demo", confirm: true
  }), order);
  assert.equal(order.statusCode, 201);
  const cookie = order.headers.get("set-cookie").split(";")[0];
  const captured = makeResponse();
  await handler(makeRequest({ action: "capture", confirm: true }, cookie), captured);
  assert.equal(captured.statusCode, 200);
  assert.equal(captured.data.status, "COMPLETED");
  assert.equal(captured.data.capture_status, "COMPLETED");
  assert.equal(captured.data.capture_id, "CAPTURE-RECOVERED-01");
  assert.equal(captured.data.recovered, true);
  assert.equal(calls.filter(x => x.method === "POST" && x.path.endsWith("/capture")).length, 1);
  assert.equal(statusReads, 2);
});

test("unconfirmed capture response remains uncertain and never causes second POST", async () => {
  configure();
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: opts.method });
    if (path === "/api/internal/checkout/orders") {
      return new Response(JSON.stringify({
        order_id: ID, status: "CREATED", currency: "USD",
        amount: "5.00", approve_url: APPROVE
      }), { status: 201 });
    }
    if (path.endsWith("/status")) {
      return new Response(JSON.stringify({
        order_id: ID, status: "APPROVED", currency: "USD",
        amount: "5.00", capture_status: null, capture_id: null
      }), { status: 200 });
    }
    if (path.endsWith("/capture")) throw new Error("simulated network drop");
    throw Error("Unexpected test request");
  };
  const order = makeResponse();
  await handler(makeRequest({
    action: "create", item_code: "financial-literacy-demo", confirm: true
  }), order);
  const cookie = order.headers.get("set-cookie").split(";")[0];
  const captured = makeResponse();
  await handler(makeRequest({ action: "capture", confirm: true }, cookie), captured);
  assert.equal(captured.statusCode, 503);
  assert.equal(captured.data.reason, "capture_status_uncertain");
  assert.equal(calls.filter(x => x.method === "POST" && x.path.endsWith("/capture")).length, 1);
  assert.equal(calls.filter(x => x.method === "GET" && x.path.endsWith("/status")).length, 2);
});

test.after(() => {
  globalThis.fetch = originalFetch;
  for (const key of ["BACKEND_URL", "ENABLE_PUBLIC_DEMO_CHECKOUT", "CHECKOUT_SERVICE_KEY", "CHECKOUT_SESSION_SECRET"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});
