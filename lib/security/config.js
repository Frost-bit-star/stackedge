const fs = require("fs-extra");
const path = require("path");
const { BASE_DIR, SECURITY_FILE } = require("../config");

const DEFAULT_SECURITY = {
  enabled: true,
  headers: {
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "x-xss-protection": "0",
    "content-security-policy": "default-src 'self'"
  },
  rateLimit: {
    enabled: true,
    requests: 100,
    window: 60,
    blockDuration: 300
  },
  requestLimits: {
    maxBodySize: "10mb",
    maxHeaderSize: "16kb",
    timeout: 30000
  },
  methods: ["GET", "POST", "HEAD", "OPTIONS"],
  directoryListing: false,
  pathTraversalProtection: true,
  hostValidation: true,
  allowedHosts: [],
  accessLog: true,
  connectionLimit: 100,
  tls: {
    enabled: false,
    cert: "",
    key: ""
  }
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function merge(base, saved) {
  if (!isPlainObject(saved)) return base;
  const result = clone(base);
  for (const [key, value] of Object.entries(saved)) {
    if (!(key in result)) continue;
    if (isPlainObject(result[key]) && isPlainObject(value)) {
      result[key] = merge(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function parseSize(value, label) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  const match = String(value == null ? "" : value)
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i);
  if (!match) throw new Error(`Invalid ${label}: '${value}'`);
  const units = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };
  const bytes = Math.floor(Number(match[1]) * units[(match[2] || "b").toLowerCase()]);
  if (!Number.isFinite(bytes) || bytes < 0) throw new Error(`Invalid ${label}: '${value}'`);
  return bytes;
}

function integer(value, label, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Invalid ${label}: '${value}' (expected ${min}-${max})`);
  }
  return n;
}

function boolean(value, label) {
  if (typeof value !== "boolean") throw new Error(`Invalid ${label}: expected true or false`);
  return value;
}

function validateSecurity(input) {
  const cfg = merge(DEFAULT_SECURITY, input);
  const errors = [];

  cfg.enabled = boolean(cfg.enabled, "security.enabled");
  cfg.directoryListing = boolean(cfg.directoryListing, "security.directoryListing");
  cfg.pathTraversalProtection = boolean(
    cfg.pathTraversalProtection,
    "security.pathTraversalProtection"
  );
  cfg.accessLog = boolean(cfg.accessLog, "security.accessLog");

  if (isPlainObject(cfg.hostValidation)) {
    cfg.allowedHosts = Array.isArray(cfg.hostValidation.allowed)
      ? cfg.hostValidation.allowed
      : cfg.allowedHosts;
    cfg.hostValidation = cfg.hostValidation.enabled !== false;
  }
  cfg.hostValidation = boolean(cfg.hostValidation, "security.hostValidation");

  if (!isPlainObject(cfg.headers)) errors.push("security.headers must be an object");
  else {
    for (const [name, value] of Object.entries(cfg.headers)) {
      if (typeof value !== "string") errors.push(`security.headers.${name} must be a string`);
    }
  }

  cfg.rateLimit.enabled = boolean(cfg.rateLimit.enabled, "security.rateLimit.enabled");
  cfg.rateLimit.requests = integer(cfg.rateLimit.requests, "security.rateLimit.requests", 1, 1000000);
  cfg.rateLimit.window = integer(cfg.rateLimit.window, "security.rateLimit.window", 1, 86400);
  cfg.rateLimit.blockDuration = integer(
    cfg.rateLimit.blockDuration,
    "security.rateLimit.blockDuration",
    0,
    86400
  );

  try {
    parseSize(cfg.requestLimits.maxBodySize, "security.requestLimits.maxBodySize");
    parseSize(cfg.requestLimits.maxHeaderSize, "security.requestLimits.maxHeaderSize");
  } catch (err) {
    errors.push(err.message);
  }
  cfg.requestLimits.timeout = integer(
    cfg.requestLimits.timeout,
    "security.requestLimits.timeout",
    100,
    600000
  );

  if (!Array.isArray(cfg.methods) || !cfg.methods.length) {
    errors.push("security.methods must be a non-empty array");
  } else {
    cfg.methods = cfg.methods.map(m => String(m).toUpperCase());
  }

  if (!Array.isArray(cfg.allowedHosts)) {
    errors.push("security.allowedHosts must be an array");
  } else {
    cfg.allowedHosts = cfg.allowedHosts.map(String);
  }

  cfg.connectionLimit = integer(cfg.connectionLimit, "security.connectionLimit", 1, 100000);
  cfg.tls.enabled = boolean(cfg.tls.enabled, "security.tls.enabled");
  cfg.tls.cert = String(cfg.tls.cert || "");
  cfg.tls.key = String(cfg.tls.key || "");

  if (errors.length) throw new Error(errors.join("; "));
  return cfg;
}

async function loadSecurity({ create = false } = {}) {
  if (!(await fs.pathExists(SECURITY_FILE))) {
    const cfg = clone(DEFAULT_SECURITY);
    if (create) await saveSecurity(cfg);
    return cfg;
  }

  let parsed;
  try {
    parsed = await fs.readJson(SECURITY_FILE);
  } catch (err) {
    throw new Error(`Cannot read ${SECURITY_FILE}: ${err.message}`);
  }

  const root = isPlainObject(parsed) && isPlainObject(parsed.security) ? parsed.security : parsed;
  return validateSecurity(root);
}

async function saveSecurity(cfg) {
  const normalized = validateSecurity(cfg || {});
  await fs.ensureDir(BASE_DIR);
  try {
    await fs.chmod(BASE_DIR, 0o700);
  } catch {}
  await fs.writeJson(SECURITY_FILE, { security: normalized }, { spaces: 2 });
  try {
    await fs.chmod(SECURITY_FILE, 0o600);
  } catch {}
  return normalized;
}

async function resetSecurity() {
  return saveSecurity(clone(DEFAULT_SECURITY));
}

function securityEnabled(cfg) {
  return Boolean(cfg && cfg.enabled);
}

module.exports = {
  DEFAULT_SECURITY,
  SECURITY_FILE,
  loadSecurity,
  saveSecurity,
  resetSecurity,
  validateSecurity,
  securityEnabled,
  parseSize,
  clone
};
