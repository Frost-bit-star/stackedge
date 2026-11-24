const fs = require("fs");
const { isTorRunning } = require("../tor/tor");
const { primaryPort } = require("../ports");
const { loadApps } = require("../registry");
const { loadSecurity, securityEnabled, parseSize } = require("./config");
const { proxyHealthy } = require("./manager");

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "0:0:0:0:0:0:0:1"]);

function readListeners() {
  if (!fs.existsSync("/proc/net/tcp")) return null;
  const listeners = new Set();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, "utf8").split("\n").slice(1);
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4 || parts[3] !== "0A") continue;
      const [address, portHex] = parts[1].split(":");
      listeners.add({ address, port: parseInt(portHex, 16) });
    }
  }
  return listeners;
}

function check(name, weight, status, detail, recommendation) {
  return { name, weight, status, detail, recommendation };
}

async function runAudit() {
  const apps = await loadApps();
  const security = await loadSecurity();
  const checks = [];
  const enabled = securityEnabled(security);

  const torUp = await isTorRunning();
  checks.push(
    check(
      "Tor service running",
      8,
      torUp ? "pass" : "warn",
      torUp ? "control port is open" : "control port is closed",
      "Run 'stackedge setup' to install and start Tor."
    )
  );

  const publicBindings = apps.filter(a => {
    const host = String(a.host || "127.0.0.1").toLowerCase();
    return !LOOPBACK_HOSTS.has(host);
  });
  checks.push(
    check(
      "Application bound to localhost",
      12,
      publicBindings.length ? "fail" : apps.length ? "pass" : "warn",
      publicBindings.length
        ? `${publicBindings.map(a => `${a.name} (${a.host})`).join(", ")}`
        : apps.length
          ? `${apps.length} app(s) bound to loopback`
          : "no apps registered",
      "Start apps with --host 127.0.0.1 and run 'stackedge security fix'."
    )
  );

  const listeners = readListeners();
  const exposed = listeners
    ? apps
        .map(a => ({ app: a.name, port: primaryPort(a) }))
        .filter(({ port }) =>
          listeners.some(l => l.port === port && /^0+$/.test(l.address))
        )
    : [];
  checks.push(
    check(
      "Backend port not publicly exposed",
      12,
      exposed.length ? "fail" : listeners ? "pass" : "warn",
      exposed.length
        ? exposed.map(e => `${e.app}:${e.port}`).join(", ")
        : listeners
          ? "no wildcard listeners on backend ports"
          : "cannot inspect listening sockets on this platform",
      "Bind backends to 127.0.0.1 and keep Tor pointed at the security proxy."
    )
  );

  const requiredHeaders = [
    "x-frame-options",
    "x-content-type-options",
    "content-security-policy"
  ];
  const missingHeaders = requiredHeaders.filter(h => !security.headers[h]);
  checks.push(
    check(
      "Security headers enabled",
      12,
      enabled && !missingHeaders.length ? "pass" : enabled ? "warn" : "fail",
      enabled && !missingHeaders.length
        ? `${Object.keys(security.headers).length} headers active`
        : missingHeaders.length
          ? `missing: ${missingHeaders.join(", ")}`
          : "security engine is disabled",
      "Run 'stackedge security fix' to restore the default headers."
    )
  );

  const limitsOk =
    parseSize(security.requestLimits.maxBodySize, "maxBodySize") > 0 &&
    parseSize(security.requestLimits.maxHeaderSize, "maxHeaderSize") > 0;
  checks.push(
    check(
      "Request size limits configured",
      10,
      limitsOk ? "pass" : "fail",
      `${security.requestLimits.maxBodySize} body / ${security.requestLimits.maxHeaderSize} headers`,
      "Set security.requestLimits.maxBodySize and maxHeaderSize."
    )
  );

  checks.push(
    check(
      "Rate limiting enabled",
      10,
      enabled && security.rateLimit.enabled ? "pass" : "fail",
      enabled && security.rateLimit.enabled
        ? `${security.rateLimit.requests} requests / ${security.rateLimit.window}s`
        : "rate limiting is disabled",
      "Run 'stackedge security enable' or enable security.rateLimit."
    )
  );

  checks.push(
    check(
      "Directory listing disabled",
      6,
      security.directoryListing === false ? "pass" : "fail",
      security.directoryListing === false ? "autoindex requests blocked" : "autoindex requests allowed",
      "Set security.directoryListing to false."
    )
  );

  checks.push(
    check(
      "Path traversal protection",
      10,
      security.pathTraversalProtection ? "pass" : "fail",
      security.pathTraversalProtection ? "enabled" : "disabled",
      "Set security.pathTraversalProtection to true."
    )
  );

  checks.push(
    check(
      "Host header validation",
      8,
      security.hostValidation ? "pass" : "fail",
      security.hostValidation ? "enabled" : "disabled",
      "Set security.hostValidation to true or add hosts to allowedHosts."
    )
  );

  checks.push(
    check(
      "Security access log",
      6,
      security.accessLog ? "pass" : "warn",
      security.accessLog ? "enabled" : "disabled",
      "Enable security.accessLog to record rejected requests."
    )
  );

  checks.push(
    check(
      "TLS for local connections",
      6,
      security.tls.enabled ? "pass" : "warn",
      security.tls.enabled ? "enabled" : "not configured",
      "Provide a cert/key in security.tls if other devices reach this host."
    )
  );

  const missingProxies = [];
  for (const app of apps) {
    if (primaryPort(app) && !(await proxyHealthy(app))) missingProxies.push(app.name);
  }
  checks.push(
    check(
      "Security proxy running",
      0,
      !enabled ? "warn" : missingProxies.length ? "warn" : apps.length ? "pass" : "warn",
      missingProxies.length ? `not running for: ${missingProxies.join(", ")}` : `${apps.length} app(s) protected`,
      "Restart the affected apps with 'stackedge restart <name>'."
    )
  );

  const elevated = typeof process.getuid === "function" && process.getuid() === 0;
  checks.push(
    check(
      "Least-privilege process",
      0,
      elevated ? "warn" : "pass",
      elevated ? "running as root" : "running as an unprivileged user",
      "Run Stackedge as a dedicated unprivileged user."
    )
  );

  checks.push(
    check(
      "Application health checks",
      0,
      apps.some(a => a.healthCheck) ? "pass" : "warn",
      apps.some(a => a.healthCheck) ? "configured" : "not configured",
      "Add a healthCheck command to each app record for automatic recovery."
    )
  );

  const score = Math.round(
    checks.reduce((sum, item) => {
      if (item.status === "pass") return sum + item.weight;
      if (item.status === "warn") return sum + item.weight / 2;
      return sum;
    }, 0)
  );

  return {
    checks,
    score,
    recommendations: checks.filter(c => c.status !== "pass").map(c => c.recommendation)
  };
}

module.exports = { runAudit, readListeners };
