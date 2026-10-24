// Vercel server-side function; only a sanitized public availability check.
// PayPal secrets and private developer access keys never enter this function.
export default async function handler(request, response) {
  const send = (status, payload) => {
    response.statusCode = status;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.end(JSON.stringify(payload));
  };
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    send(405, { connected: false, reason: "method_not_allowed" });
    return;
  }
  const configured = process.env.BACKEND_URL;
  if (!configured) {
    send(503, { connected: false, reason: "not_configured" });
    return;
  }
  let url;
  try {
    url = new URL(configured);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) {
      throw new Error("Invalid cloud backend URL");
    }
  } catch (_) {
    send(503, { connected: false, reason: "not_configured" });
    return;
  }
  try {
    const upstream = await fetch(new URL("/health", url), {
      method: "GET", redirect: "error", cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000)
    });
    if (!upstream.ok) {
      send(503, { connected: false, reason: "unavailable" });
      return;
    }
    const body = await upstream.json();
    if (body?.status !== "ok" || body?.mode !== "sandbox") {
      send(503, { connected: false, reason: "unavailable" });
      return;
    }
    send(200, { connected: true, backend: "online" });
  } catch (_) {
    send(503, { connected: false, reason: "unavailable" });
  }
}
