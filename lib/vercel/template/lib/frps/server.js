const crypto = require("crypto");
const http = require("http");
const { createSharedTunnelState } = require("./shared-state");
const { safeEqual } = require("../shared/auth");
const { renderErrorPage, clientIp } = require("../error-page");
const { PROTOCOL_VERSION } = require("../shared/protocol");

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);
const MAX_SHARED_BODY = 6 * 1024 * 1024;

function safeHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (HOP_BY_HOP.has(name.toLowerCase()) || value === undefined) continue;
    out[name] = value;
  }
  return out;
}

function sendJson(res, status, value, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": body.length,
    "cache-control": "no-store",
    ...extraHeaders
  });
  res.end(body);
}

function sendError(req, res, code, title, message, requestId) {
  const body = Buffer.from(
    renderErrorPage({
      code,
      title,
      message,
      requestId,
      host: req.headers["x-forwarded-host"] || req.headers.host || "unknown",
      ip: clientIp(req.headers, req.socket)
    })
  );
  res.writeHead(code, {
    "content-type": "text/html; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store"
  });
  res.end(body);
}

function errorFor(err) {
  const text = String(err && err.message || err);
  if (/No FRPC tunnel connected|Shared tunnel state is not configured/.test(text)) {
    return {
      code: 522,
      title: "Connection timed out",
      message: "The Stackedge app behind this gateway is offline or its FRPC worker is not connected. Start the app and run 'stackedge vercel connect <app>' on the device."
    };
  }
  if (/timed out/i.test(text)) {
    return {
      code: 504,
      title: "Gateway timeout",
      message: "The gateway did not receive a response from the Stackedge app in time."
    };
  }
  if (/too large|backpressure/i.test(text)) {
    return {
      code: 503,
      title: "Service unavailable",
      message: "The request or response exceeded the tunnel limit. Try again with a smaller request."
    };
  }
  return {
    code: 502,
    title: "Bad gateway",
    message: `The gateway could not complete the request: ${text}`
  };
}

function authorized(req, url, token) {
  const provided = req.headers["x-stackfrp-token"] || url.searchParams.get("token");
  return safeEqual(token, provided);
}

function readBody(req, maxBodySize) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    req.on("data", chunk => {
      received += chunk.length;
      if (received > maxBodySize) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("aborted", () => reject(new Error("Request aborted")));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createRequestHandler({ serviceId, token, application = "app", maxBodySize, shared }) {
  const sharedLimit = Math.min(maxBodySize, MAX_SHARED_BODY);

  return async (req, res) => {
    const url = new URL(req.url, "http://localhost");

    if (url.pathname === "/_health") {
      const connected = await shared.isOnline();
      return sendJson(res, 200, {
        status: "ok",
        serviceId,
        application,
        tunnel: connected ? "connected" : "disconnected",
        relay: shared.backend === "memory" ? "memory" : "redis",
        shared: "enabled",
        mode: "pull"
      });
    }

    if (url.pathname === "/_verify") {
      if (!authorized(req, url, token)) {
        return sendJson(res, 401, { status: "unauthorized" });
      }
      return sendJson(res, 200, {
        status: "verified",
        serviceId,
        protocol: PROTOCOL_VERSION,
        mode: "pull"
      });
    }

    if (url.pathname === "/_frpc/hello") {
      if (!authorized(req, url, token)) {
        return sendJson(res, 401, { status: "unauthorized" });
      }
      await shared.touch();
      return sendJson(res, 200, {
        type: "connected",
        instanceId: shared.instanceId,
        serviceId,
        mode: "pull"
      });
    }

    if (url.pathname === "/_frpc/poll") {
      if (!authorized(req, url, token)) {
        return sendJson(res, 401, { status: "unauthorized" });
      }
      await shared.touch();
      const wait = Math.max(100, Math.min(20000, Number(url.searchParams.get("wait")) || 20000));
      const deadline = Date.now() + wait;
      while (Date.now() < deadline) {
        const request = await shared.dequeueRequest();
        if (request) {
          return sendJson(res, 200, {
            type: "request",
            instanceId: shared.instanceId,
            ...request
          });
        }
        await sleep(200);
      }
      return sendJson(res, 200, {
        type: "heartbeat",
        instanceId: shared.instanceId,
        serviceId
      });
    }

    if (url.pathname === "/_frpc/result") {
      if (!authorized(req, url, token)) {
        return sendJson(res, 401, { status: "unauthorized" });
      }
      if (req.method !== "POST") {
        return sendJson(res, 405, { status: "method-not-allowed" });
      }
      try {
        const raw = await readBody(req, sharedLimit);
        const payload = JSON.parse(raw.toString("utf8"));
        if (!payload || !payload.requestId) throw new Error("requestId is required");
        const body = Buffer.from(payload.body || "", "base64");
        if (body.length > sharedLimit) throw new Error("Response too large");
        await shared.setResult(payload.requestId, {
          status: payload.status || 502,
          headers: safeHeaders(payload.headers || {}),
          body: body.toString("base64")
        });
        return sendJson(res, 200, { status: "ok" });
      } catch (err) {
        return sendJson(res, 400, { status: "error", message: String(err && err.message || err) });
      }
    }

    let body;
    try {
      body = await readBody(req, maxBodySize);
    } catch (err) {
      if (String(err && err.message || err) === "Request body too large") {
        return sendError(req, res, 413, "Payload too large", "The request body exceeded the tunnel limit.", crypto.randomUUID());
      }
      return;
    }

    const requestId = crypto.randomUUID();
    try {
      const result = await shared.relay({
        requestId,
        method: req.method,
        path: req.url,
        headers: safeHeaders(req.headers),
        body
      });
      const headers = safeHeaders(result.headers);
      delete headers["content-length"];
      delete headers["transfer-encoding"];
      res.writeHead(result.status || 502, { ...headers, "content-length": result.body.length });
      res.end(result.body);
    } catch (err) {
      const error = errorFor(err);
      sendError(req, res, error.code, error.title, error.message, requestId);
    }
  };
}

function createGateway({
  serviceId,
  token,
  application = "app",
  maxBodySize = 16 * 1024 * 1024,
  requestTimeout = 30000,
  env = process.env,
  fetchImpl
} = {}) {
  if (!serviceId || !token) throw new Error("serviceId and token are required");

  const instanceId = crypto.randomUUID();
  const shared = createSharedTunnelState({
    serviceId,
    instanceId,
    env,
    fetchImpl,
    requestTimeout,
    maxBodySize: Math.min(maxBodySize, MAX_SHARED_BODY)
  });
  const handle = createRequestHandler({ serviceId, token, application, maxBodySize, shared });
  const server = http.createServer(handle);

  return {
    server,
    shared,
    handle,
    close: () => shared.close()
  };
}

module.exports = {
  createGateway,
  createRequestHandler,
  safeHeaders,
  sendError,
  errorFor
};
