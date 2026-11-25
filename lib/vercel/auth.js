const crypto = require("crypto");

function generateToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

function generateServiceId() {
  return `svc_${crypto.randomBytes(12).toString("hex")}`;
}

function safeEqual(expected, received) {
  const a = Buffer.from(String(expected || ""));
  const b = Buffer.from(String(received || ""));
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { generateToken, generateServiceId, safeEqual };
