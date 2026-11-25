const crypto = require("crypto");
const http = require("http");
const { WebSocketServer } = require("ws");
const { TunnelConnection } = require("./connection-manager");
const { safeEqual } = require("../shared/auth");
const { renderErrorPage, clientIp } = require("../error-page");
const {
  PROTOCOL_VERSION,
  decodeFrame,
  encodeJson,
  registered,
  protocolError
} = require("../shared/protocol");

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

function safeHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (HOP_BY_HOP.has(name.toLowerCase()) || value === undefined) continue;
    out[name] = value;
  }
  return out;
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
  if (/No FRPC tunnel connected/.test(text)) {
    return {
      code: 522,
      title: "Connection timed out",
      message: "The Stackedge app behind this gateway is offline or its FRPC tunnel is not connected. Start the app and run 'stackedge vercel connect <app>' on the device."
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

function createRequestHandler({ serviceId, token, application = "app", maxBodySize, tunnel }) {
  return (req, res) => {
    const url = new URL(req.url, "http://localhost");

    if (url.pathname === "/_health") {
      const body = JSON.stringify({
        status: "ok",
        serviceId,
        application,
        tunnel: tunnel.isConnected() ? "connected" : "disconnected"
      });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body)
      });
      res.end(body);
      return;
    }

    if (url.pathname === "/_verify") {
      const provided = req.headers["x-stackfrp-token"] || url.searchParams.get("token");
      if (!safeEqual(token, provided)) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "unauthorized" }));
        return;
      }
      const body = JSON.stringify({ status: "verified", serviceId, protocol: PROTOCOL_VERSION });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body)
      });
      res.end(body);
      return;
    }

    const chunks = [];
    let received = 0;
    let tooLarge = false;

    req.on("data", chunk => {
      received += chunk.length;
      if (received > maxBodySize) {
        tooLarge = true;
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("aborted", () => {
      tooLarge = true;
    });

    req.on("end", async () => {
      const requestId = crypto.randomUUID();
      if (tooLarge) {
        if (!res.headersSent) {
          sendError(req, res, 413, "Payload too large", "The request body exceeded the tunnel limit.", requestId);
        }
        return;
      }

      try {
        const result = await tunnel.relay({
          requestId,
          method: req.method,
          path: req.url,
          headers: safeHeaders(req.headers),
          body: Buffer.concat(chunks)
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
    });
  };
}

function createWebSocketServer({ serviceId, token, tunnel, maxBodySize, authTimeout = 10000 }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxBodySize + 4096 });

  wss.on("connection", socket => {
    let authenticated = false;
    const timer = setTimeout(() => {
      if (!authenticated) {
        socket.send(encodeJson(protocolError("auth_timeout", "Registration timed out")));
        socket.close();
      }
    }, authTimeout);

    socket.once("message", data => {
      clearTimeout(timer);
      let frame;
      try {
        frame = decodeFrame(data);
      } catch (err) {
        socket.send(encodeJson(protocolError("bad_frame", err.message)));
        socket.close();
        return;
      }

      const message = frame.kind === "json" ? frame.message : {};
      const valid =
        frame.kind === "json" &&
        message.type === "register" &&
        message.protocol === PROTOCOL_VERSION &&
        message.serviceId === serviceId &&
        safeEqual(token, message.token);

      if (!valid) {
        socket.send(encodeJson(protocolError("unauthorized", "Invalid service credentials")));
        socket.close();
        return;
      }

      authenticated = true;
      socket.send(encodeJson(registered(serviceId)));
      tunnel.attach(socket);
    });
  });

  return wss;
}

function createGateway({
  serviceId,
  token,
  application = "app",
  maxBodySize = 16 * 1024 * 1024,
  requestTimeout = 30000,
  authTimeout = 10000
} = {}) {
  if (!serviceId || !token) throw new Error("serviceId and token are required");

  const tunnel = new TunnelConnection({ serviceId, requestTimeout, maxBodySize });
  const wss = createWebSocketServer({ serviceId, token, tunnel, maxBodySize, authTimeout });
  const handle = createRequestHandler({ serviceId, token, application, maxBodySize, tunnel });
  const server = http.createServer(handle);

  server.on("upgrade", (req, socket, head) => {
    if (req.url.split("?")[0] !== "/_frpc") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
  });

  return {
    server,
    tunnel,
    wss,
    handle,
    close: () => new Promise(resolve => wss.close(() => server.close(resolve)))
  };
}

module.exports = {
  createGateway,
  createRequestHandler,
  createWebSocketServer,
  safeHeaders,
  sendError,
  errorFor
};
