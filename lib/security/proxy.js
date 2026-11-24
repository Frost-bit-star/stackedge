const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const { SECURITY_LOG_FILE, BASE_DIR } = require("../config");
const { parseSize } = require("./config");

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

const SENSITIVE_PATH = /(^|\/)\.(?:git|svn|hg|env|ssh|aws|docker|npmrc|htpasswd|htaccess|gitignore|ds_store)(?:\/|$)/i;
const AUTOINDEX_QUERY = /(?:[?&](?:N|O|C|M|S|D|A|F|V|T)=[A-Z]|(?:^|[?&])C=N;O=D)/;

function clientKey(socket, localAddresses) {
  const address = socket.remoteAddress || "";
  if (localAddresses.has(address)) return "tor";
  return address;
}

function safePath(rawUrl) {
  const pathname = String(rawUrl || "/").split("?")[0].split("#")[0];
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

function traversalDetected(rawUrl) {
  let value = String(rawUrl || "").split("?")[0].split("#")[0];
  if (/[\x00\\]/.test(value)) return true;
  for (let i = 0; i < 3; i++) {
    let decoded;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      return true;
    }
    if (decoded === value) break;
    value = decoded;
  }
  if (/[\x00\\]/.test(value)) return true;
  return value.split("/").some(segment => segment === "..");
}

function headerBytes(req) {
  let bytes = 0;
  bytes += req.method.length + req.url.length + 9;
  for (const [name, values] of Object.entries(req.headers)) {
    for (const value of Array.isArray(values) ? values : [values]) {
      bytes += name.length + String(value).length + 4;
    }
  }
  return bytes;
}

function sanitizeHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(name.toLowerCase()) || value === undefined) continue;
    out[name] = value;
  }
  return out;
}

function logEvent(settings, appName, entry) {
  if (!settings.accessLog) return;
  const line = JSON.stringify({
    time: new Date().toISOString(),
    app: appName,
    method: entry.method,
    path: safePath(entry.url),
    status: entry.status,
    reason: entry.reason || null,
    client: entry.client === "tor" ? "tor" : "<client>"
  }) + "\n";
  fs.mkdirSync(path.dirname(SECURITY_LOG_FILE), { recursive: true });
  fs.appendFile(SECURITY_LOG_FILE, line, () => {});
}

function createProxy({ appName, targetPort, targetHost = "127.0.0.1", security, allowedHosts = [] }) {
  const localAddresses = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", ""]);
  const allowed = new Set([
    "localhost",
    "127.0.0.1",
    "::1",
    "[::1]",
    ...allowedHosts.map(h => String(h).toLowerCase().replace(/^\./, ""))
  ]);

  const settings = security;
  const maxBody = parseSize(settings.requestLimits.maxBodySize, "maxBodySize");
  const maxHeader = parseSize(settings.requestLimits.maxHeaderSize, "maxHeaderSize");
  const timeout = settings.requestLimits.timeout;
  const activeSockets = new Set();
  const hits = new Map();
  const blocked = new Map();

  function deny(req, res, status, reason, client) {
    const body = reason || "Request rejected";
    res.writeHead(status, {
      "content-type": "text/plain; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
      ...settings.headers
    });
    res.end(body);
    logEvent(settings, appName, { ...req, status, reason, client });
  }

  function rateLimited(key) {
    if (!settings.rateLimit.enabled) return false;
    const now = Date.now();
    const until = blocked.get(key) || 0;
    if (until > now) return true;
    if (until && until <= now) blocked.delete(key);

    const windowMs = settings.rateLimit.window * 1000;
    if (hits.size > 10000) {
      for (const [id, times] of hits) {
        if (!times.length || now - times[times.length - 1] >= windowMs) hits.delete(id);
      }
    }
    const recent = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (recent.length >= settings.rateLimit.requests) {
      if (settings.rateLimit.blockDuration > 0) {
        blocked.set(key, now + settings.rateLimit.blockDuration * 1000);
      }
      hits.set(key, recent);
      return true;
    }
    recent.push(now);
    hits.set(key, recent);
    return false;
  }

  function validate(req) {
    const method = String(req.method || "").toUpperCase();
    if (!settings.methods.includes(method)) return [405, `Method ${method} is not allowed`];

    if (settings.pathTraversalProtection && traversalDetected(req.url)) {
      return [403, "Path traversal attempt blocked"];
    }

    if (settings.directoryListing === false) {
      if (SENSITIVE_PATH.test(safePath(req.url))) return [404, "Not found"];
      if (AUTOINDEX_QUERY.test(String(req.url || ""))) return [403, "Directory listing blocked"];
    }

    if (settings.hostValidation) {
      const rawHost = String(req.headers.host || "");
      const host = rawHost.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
      const accepted =
        allowed.has(host) ||
        host.endsWith(".onion") ||
        [...allowed].some(name => name.startsWith(".") && host.endsWith(name));
      if (!host || !accepted) return [400, "Invalid Host header"];
    }

    const declared = Number(req.headers["content-length"] || 0);
    if (declared > maxBody) return [413, "Request body too large"];
    if (headerBytes(req) > maxHeader) return [431, "Request headers too large"];

    return null;
  }

  function forward(req, res, body, client) {
    const upstream = http.request(
      {
        host: targetHost,
        port: targetPort,
        method: req.method,
        path: req.url,
        headers: sanitizeHeaders(req.headers),
        agent: false,
        timeout
      },
      upstreamRes => {
        const headers = sanitizeHeaders(upstreamRes.headers);
        for (const name of ["server", "x-powered-by", "x-aspnet-version", "x-aspnetmvc-version"]) {
          delete headers[name];
        }
        res.writeHead(upstreamRes.statusCode || 502, { ...headers, ...settings.headers });
        upstreamRes.pipe(res);
        logEvent(settings, appName, {
          ...req,
          status: upstreamRes.statusCode || 502,
          client
        });
      }
    );

    const finish = (status, reason) => {
      if (!upstream.destroyed) upstream.destroy();
      if (!res.headersSent) deny(req, res, status, reason, client);
    };

    upstream.on("timeout", () => finish(504, "Upstream timed out"));
    upstream.on("error", () => finish(502, "Bad gateway"));
    if (body.length) upstream.write(body);
    upstream.end();
  }

  const handler = (req, res) => {
    const client = clientKey(req.socket, localAddresses);

    if (rateLimited(client)) {
      deny(req, res, 429, "Too many requests", client);
      return;
    }

    const problem = validate(req);
    if (problem) {
      deny(req, res, problem[0], problem[1], client);
      return;
    }

    const chunks = [];
    let received = 0;
    let failed = false;

    req.on("data", chunk => {
      received += chunk.length;
      if (received > maxBody) {
        if (!failed) {
          failed = true;
          deny(req, res, 413, "Request body too large", client);
          req.pause();
          res.once("finish", () => req.destroy());
        }
        return;
      }
      chunks.push(chunk);
    });

    req.on("aborted", () => {
      failed = true;
    });

    req.on("end", () => {
      if (failed) return;
      forward(req, res, Buffer.concat(chunks), client);
    });

    req.on("error", () => {
      failed = true;
    });
  };

  function tlsPath(file) {
    return path.isAbsolute(file) ? file : path.join(BASE_DIR, file);
  }

  const server = settings.tls.enabled
    ? https.createServer(
        {
          cert: fs.readFileSync(tlsPath(settings.tls.cert)),
          key: fs.readFileSync(tlsPath(settings.tls.key))
        },
        handler
      )
    : http.createServer(handler);

  server.requestTimeout = timeout;
  server.headersTimeout = timeout;
  server.keepAliveTimeout = Math.min(timeout, 5000);
  server.maxHeadersCount = Math.max(100, Math.floor(maxHeader / 100));

  server.on("connection", socket => {
    if (activeSockets.size >= settings.connectionLimit) {
      socket.destroy();
      return;
    }
    activeSockets.add(socket);
    socket.setTimeout(timeout, () => socket.destroy());
    socket.on("close", () => activeSockets.delete(socket));
  });

  return server;
}

module.exports = { createProxy };
