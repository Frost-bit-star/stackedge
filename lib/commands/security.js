const fs = require("fs");
const { loadApps, saveApps } = require("../registry");
const { publishApps } = require("../tor/tor");
const { SECURITY_LOG_FILE } = require("../config");
const { ensureProxy, stopProxy } = require("../security/manager");
const {
  DEFAULT_SECURITY,
  SECURITY_FILE,
  loadSecurity,
  saveSecurity,
  resetSecurity,
  resolveWorkers,
  parseSize
} = require("../security/config");
const { runAudit } = require("../security/audit");

const REQUIRED_HEADERS = [
  "x-frame-options",
  "x-content-type-options",
  "content-security-policy"
];
const UNSAFE_METHODS = new Set(["TRACE", "CONNECT", "PUT", "PATCH", "DELETE"]);
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost", "0:0:0:0:0:0:0:1"]);

async function republish() {
  try {
    await publishApps(await loadApps());
  } catch (err) {
    console.log(`  Note: Tor config could not be refreshed: ${err.message}`);
  }
}

async function restartProxies() {
  const apps = await loadApps();
  for (const app of apps) {
    try {
      await ensureProxy(app);
    } catch (err) {
      console.log(`  Warning: ${err.message}`);
    }
  }
}

async function securityStatus() {
  const security = await loadSecurity();
  const apps = await loadApps();
  const audit = await runAudit();

  console.log("Stackedge Security Engine");
  console.log(`  status:   ${security.enabled ? "enabled" : "disabled"}`);
  console.log(`  config:   ${SECURITY_FILE}`);
  console.log(`  log:      ${security.accessLog ? SECURITY_LOG_FILE : "disabled"}`);
  console.log(`  apps:     ${apps.length}`);
  console.log(
    `  proxies:  ${apps.filter(a => a.securityPort).length} configured, ` +
      `${apps.filter(a => a.securityPort && a.securityPid).length} with a proxy pid`
  );
  console.log(`  score:    ${audit.score}/100`);
}

async function setEnabled(enabled) {
  const security = await loadSecurity();
  security.enabled = enabled;
  await saveSecurity(security);

  const apps = await loadApps();
  for (const app of apps) {
    if (enabled) {
      try {
        await ensureProxy(app);
      } catch (err) {
        console.log(`  Warning: ${err.message}`);
      }
    } else {
      await stopProxy(app);
    }
  }

  await republish();
  console.log(
    `Security engine ${enabled ? "enabled" : "disabled"}. ` +
      (enabled ? "Apps are now reached through the built-in proxy." : "Onion traffic goes directly to the apps again.")
  );
}

async function securityAudit() {
  const result = await runAudit();
  console.log("STACKEDGE SECURITY AUDIT\n");
  for (const item of result.checks) {
    const label = item.status.toUpperCase();
    console.log(`[${label}] ${item.name} - ${item.detail}`);
  }
  console.log(`\nSecurity Score: ${result.score}/100`);
  console.log(
    result.recommendations.length
      ? `${result.recommendations.length} recommendation${result.recommendations.length === 1 ? "" : "s"} available:\n` +
          result.recommendations.map(r => `  - ${r}`).join("\n")
      : "No recommendations. Configuration looks hardened."
  );
}

async function securityFix() {
  const security = await loadSecurity();
  const changes = [];

  if (!security.enabled) {
    security.enabled = true;
    changes.push("enabled the security engine");
  }

  for (const name of REQUIRED_HEADERS) {
    if (!security.headers[name]) {
      security.headers[name] = DEFAULT_SECURITY.headers[name];
      changes.push(`restored header ${name}`);
    }
  }

  if (!security.rateLimit.enabled) {
    security.rateLimit.enabled = true;
    changes.push("enabled rate limiting");
  }

  for (const key of ["maxBodySize", "maxHeaderSize"]) {
    let bytes = 0;
    try {
      bytes = parseSize(security.requestLimits[key], key);
    } catch {}
    if (bytes <= 0) {
      security.requestLimits[key] = DEFAULT_SECURITY.requestLimits[key];
      changes.push(`restored request limit ${key}`);
    }
  }

  if (security.directoryListing !== false) {
    security.directoryListing = false;
    changes.push("disabled directory listing");
  }
  if (!security.pathTraversalProtection) {
    security.pathTraversalProtection = true;
    changes.push("enabled path traversal protection");
  }
  if (!security.hostValidation) {
    security.hostValidation = true;
    changes.push("enabled Host header validation");
  }
  if (!security.accessLog) {
    security.accessLog = true;
    changes.push("enabled the security access log");
  }

  const methods = security.methods.map(m => String(m).toUpperCase());
  const unsafe = methods.filter(m => UNSAFE_METHODS.has(m));
  if (unsafe.length) {
    security.methods = methods.filter(m => !UNSAFE_METHODS.has(m));
    changes.push(`removed unsafe methods: ${unsafe.join(", ")}`);
  }

  await saveSecurity(security);
  changes.push("locked security.json permissions to 0600");

  const apps = await loadApps();
  let appsChanged = false;
  for (const app of apps) {
    if (app.host && !LOOPBACK.has(String(app.host).toLowerCase())) {
      app.host = "127.0.0.1";
      appsChanged = true;
      changes.push(`bound '${app.name}' to 127.0.0.1`);
    }
  }
  if (appsChanged) await saveApps(apps);

  await restartProxies();
  await republish();

  console.log(changes.length ? "Applied fixes:" : "Nothing to fix.");
  for (const change of changes) console.log(`  - ${change}`);
}

async function securityHeaders() {
  const security = await loadSecurity();
  console.log("Active security headers");
  const entries = Object.entries(security.headers);
  if (!entries.length) {
    console.log("  none configured");
    return;
  }
  for (const [name, value] of entries) console.log(`  ${name}: ${value}`);
}

async function securityLogs(lines = 100) {
  if (!fs.existsSync(SECURITY_LOG_FILE)) {
    console.log(`No security events yet (${SECURITY_LOG_FILE})`);
    return;
  }
  const content = fs.readFileSync(SECURITY_LOG_FILE, "utf8").replace(/\s+$/, "");
  if (!content) {
    console.log("Security log is empty");
    return;
  }
  const all = content.split("\n");
  console.log(all.slice(Math.max(0, all.length - lines)).join("\n"));
}

async function securityRules() {
  const security = await loadSecurity();
  console.log("Active security rules");
  console.log(`  engine:                 ${security.enabled ? "enabled" : "disabled"}`);
  console.log(`  methods:                ${security.methods.join(", ")}`);
  console.log(`  rateLimit:              ${security.rateLimit.enabled ? `${security.rateLimit.requests}/${security.rateLimit.window}s, block ${security.rateLimit.blockDuration}s` : "disabled"}`);
  console.log(`  maxBodySize:            ${security.requestLimits.maxBodySize}`);
  console.log(`  maxHeaderSize:          ${security.requestLimits.maxHeaderSize}`);
  console.log(`  timeout:                ${security.requestLimits.timeout}ms`);
  console.log(`  connectionLimit:        ${security.connectionLimit}`);
  console.log(
    `  cluster:                ${security.cluster.enabled ? `${resolveWorkers(security)} workers per app (${security.cluster.workers})` : "disabled"}`
  );
  console.log(`  directoryListing:       ${security.directoryListing}`);
  console.log(`  pathTraversalProtection: ${security.pathTraversalProtection}`);
  console.log(`  hostValidation:         ${security.hostValidation}`);
  console.log(`  allowedHosts:           ${security.allowedHosts.length ? security.allowedHosts.join(", ") : "onion hostnames + localhost"}`);
  console.log(`  accessLog:              ${security.accessLog}`);
  console.log(`  tls:                    ${security.tls.enabled ? "enabled" : "disabled"}`);
}

async function securityReset() {
  await resetSecurity();
  await restartProxies();
  await republish();
  console.log(`Security configuration reset to defaults (${SECURITY_FILE})`);
}

module.exports = {
  securityStatus,
  setEnabled,
  securityAudit,
  securityFix,
  securityHeaders,
  securityLogs,
  securityRules,
  securityReset
};
