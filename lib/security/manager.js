const { spawn } = require("child_process");
const path = require("path");
const { isPidAlive, killTree } = require("../process");
const { getFreePort, isPortFree, isPortAlive, primaryPort, waitForPort } = require("../ports");
const { loadApps, saveApps } = require("../registry");
const { loadSecurity, securityEnabled } = require("./config");

const RUNNER = path.resolve(__dirname, "runner.js");

async function persist(app) {
  const apps = await loadApps();
  const index = apps.findIndex(a => a.name === app.name);
  if (index === -1) return;
  apps[index].securityPort = app.securityPort || null;
  apps[index].securityPid = app.securityPid || null;
  await saveApps(apps);
}

async function proxyHealthy(app) {
  if (!app || !app.securityPort || !app.securityPid) return false;
  if (!isPidAlive(app.securityPid)) return false;
  return isPortAlive(app.securityPort, "127.0.0.1");
}

async function ensureProxy(app, { save = true } = {}) {
  const security = await loadSecurity();
  const targetPort = primaryPort(app);

  if (!securityEnabled(security) || !targetPort) {
    await stopProxy(app, { save: false });
    if (save) await persist(app);
    return false;
  }

  if (await proxyHealthy(app)) return true;

  const port =
    app.securityPort && (await isPortFree(app.securityPort)) ? app.securityPort : await getFreePort();

  const child = spawn(
    process.execPath,
    [RUNNER, app.name, String(port), String(targetPort), app.host || "127.0.0.1"],
    {
      cwd: app.cwd || process.cwd(),
      detached: true,
      stdio: "ignore"
    }
  );
  child.unref();

  app.securityPort = port;
  app.securityPid = child.pid;

  try {
    await waitForPort(port, { timeout: 8000, host: "127.0.0.1" });
  } catch (err) {
    await stopProxy(app, { save: false });
    throw new Error(`Security proxy did not start for '${app.name}': ${err.message}`);
  }

  if (save) await persist(app);
  return true;
}

async function stopProxy(app, { save = true } = {}) {
  if (!app) return;
  if (app.securityPid) killTree(app.securityPid, "SIGTERM");
  app.securityPid = null;
  app.securityPort = null;
  if (save) await persist(app);
}

async function statusFor(app, security) {
  const settings = security || (await loadSecurity());
  const running = await proxyHealthy(app);
  return {
    app: app.name,
    enabled: securityEnabled(settings),
    running,
    port: app.securityPort || null,
    target: primaryPort(app)
  };
}

module.exports = {
  ensureProxy,
  stopProxy,
  proxyHealthy,
  statusFor
};
