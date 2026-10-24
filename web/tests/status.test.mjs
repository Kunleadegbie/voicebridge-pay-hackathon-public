import { test } from "node:test";
import assert from "node:assert/strict";
import handler from "../api/status.js";

async function run(method = "GET") {
  const headers = {};
  const res = {
    statusCode: 200,
    setHeader(name, value) { headers[name] = value; },
    end(value) { this.body = JSON.parse(value); }
  };
  await handler({ method }, res);
  return { statusCode: res.statusCode, body: res.body, headers };
}

test("rejects non-GET methods", async () => {
  const result = await run("POST");
  assert.equal(result.statusCode, 405);
  assert.equal(result.headers.Allow, "GET");
});

test("requires a configured backend", async () => {
  const previous = process.env.BACKEND_URL;
  delete process.env.BACKEND_URL;
  try {
    const result = await run();
    assert.equal(result.statusCode, 503);
    assert.equal(result.body.reason, "not_configured");
  } finally {
    if (previous === undefined) delete process.env.BACKEND_URL;
    else process.env.BACKEND_URL = previous;
  }
});

test("rejects insecure backend URL", async () => {
  const previous = process.env.BACKEND_URL;
  process.env.BACKEND_URL = "http://example.com";
  try {
    const result = await run();
    assert.equal(result.statusCode, 503);
    assert.equal(result.body.reason, "not_configured");
  } finally {
    if (previous === undefined) delete process.env.BACKEND_URL;
    else process.env.BACKEND_URL = previous;
  }
});

test("returns a sanitized success status", async () => {
  const oldURL = process.env.BACKEND_URL;
  const oldFetch = globalThis.fetch;
  process.env.BACKEND_URL = "https://example.com";
  globalThis.fetch = async url => {
    assert.equal(url.pathname, "/health");
    return { ok: true, json: async () => ({ status: "ok", mode: "sandbox", secret: "do-not-expose" }) };
  };
  try {
    const result = await run();
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body, { connected: true, backend: "online" });
  } finally {
    globalThis.fetch = oldFetch;
    if (oldURL === undefined) delete process.env.BACKEND_URL;
    else process.env.BACKEND_URL = oldURL;
  }
});

test("sanitizes backend failures", async () => {
  const oldURL = process.env.BACKEND_URL;
  const oldFetch = globalThis.fetch;
  process.env.BACKEND_URL = "https://example.com";
  globalThis.fetch = async () => { throw new Error("Do not expose provider details"); };
  try {
    const result = await run();
    assert.equal(result.statusCode, 503);
    assert.deepEqual(result.body, { connected: false, reason: "unavailable" });
  } finally {
    globalThis.fetch = oldFetch;
    if (oldURL === undefined) delete process.env.BACKEND_URL;
    else process.env.BACKEND_URL = oldURL;
  }
});
