const fs = require("fs");
const path = require("path");

const TEMPLATE_FILE = path.resolve(__dirname, "..", "errorpagetempdesign.html");
const TEMPLATE = fs.readFileSync(TEMPLATE_FILE, "utf8");

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function clientIp(headers = {}, socket = {}) {
  const forwarded = headers["x-forwarded-for"];
  if (forwarded) return String(forwarded).split(",")[0].trim();
  return socket.remoteAddress || "unknown";
}

function renderErrorPage({
  code = 500,
  title = "Internal server error",
  message = "The gateway could not complete this request.",
  requestId = "0000000000000000",
  host = "unknown",
  ip = "unknown",
  edge = "vercel",
  timestamp = new Date().toISOString().slice(0, 19).replace("T", " ")
} = {}) {
  const values = {
    ERROR_CODE: escapeHtml(code),
    ERROR_TITLE: escapeHtml(title),
    MESSAGE: escapeHtml(message),
    RAY_ID: escapeHtml(String(requestId).replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64) || "0000000000000000"),
    TIMESTAMP: escapeHtml(timestamp),
    HOST: escapeHtml(host),
    CLIENT_IP: escapeHtml(ip),
    EDGE: escapeHtml(edge)
  };

  return TEMPLATE.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => values[key] || "");
}

module.exports = { renderErrorPage, escapeHtml, clientIp };
