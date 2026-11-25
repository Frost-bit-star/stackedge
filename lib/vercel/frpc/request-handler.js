const http = require("http");
const https = require("https");

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

function forwardToTarget(target, request, { maxBodySize, requestTimeout }) {
  return new Promise((resolve, reject) => {
    const url = new URL(target);
    const headers = safeHeaders(request.headers);
    const originalHost = headers["x-forwarded-host"] || headers.host || "";

    headers.host = url.host;
    if (originalHost) headers["x-original-host"] = originalHost;
    headers["x-stackedge-vercel"] = "1";

    const transport = url.protocol === "https:" ? https : http;
    const upstream = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        method: request.method,
        path: request.path,
        headers,
        timeout: requestTimeout,
        agent: false
      },
      res => {
        const chunks = [];
        let received = 0;
        let tooLarge = false;

        res.on("data", chunk => {
          received += chunk.length;
          if (received > maxBodySize) {
            tooLarge = true;
            upstream.destroy();
            return;
          }
          chunks.push(chunk);
        });

        res.on("end", () => {
          if (tooLarge) {
            reject(new Error("Upstream response too large"));
            return;
          }
          resolve({
            status: res.statusCode || 502,
            headers: safeHeaders(res.headers),
            body: Buffer.concat(chunks)
          });
        });
      }
    );

    upstream.on("timeout", () => upstream.destroy(new Error("Upstream timed out")));
    upstream.on("error", reject);
    if (request.body && request.body.length) upstream.write(request.body);
    upstream.end();
  });
}

module.exports = { forwardToTarget, safeHeaders };
