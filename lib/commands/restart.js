const { loadApps, saveApps } = require("../registry");
const { startProcess, stopProcess } = require("../process");
const { primaryPort } = require("../ports");
const { publishApps, readOnion } = require("../tor/tor");
const { ensureProxy, stopProxy } = require("../security/manager");
const { normalizeProviders, usesTor, usesVercel, hostingKey } = require("../hosting");
const { loadDeployment } = require("../vercel/config");
const { startTunnel, stopTunnel } = require("../vercel/manager");

/**
 * Restart an app by stopping it and starting it again on the same ports.
 * @param {string} name - App name
 */
async function restartApp(name) {
  const apps = await loadApps();
  const app = apps.find(a => a.name === name);

  if (!app) {
    console.log(`App '${name}' not found`);
    return;
  }

  await stopProxy(app);
  await stopProcess(app);

  const current = (await loadApps()).find(a => a.name === name) || app;
  const providers = normalizeProviders(current);
  const torEnabled = usesTor(providers);
  current.appState = "starting";
  current.providers = providers;
  current.hosting = hostingKey(providers);
  current.torState = torEnabled ? "pending" : "disabled";
  if (!torEnabled) current.onion = null;
  await startProcess(current);

  try {
    await ensureProxy(current);
  } catch (err) {
    console.log(`Warning: security proxy could not start: ${err.message}`);
  }

  if (torEnabled) {
    try {
      await publishApps(await loadApps());
    } catch (err) {
      console.log(`Warning: could not publish to Tor yet: ${err.message}`);
    }
  }

  if (torEnabled && !current.onion) {
    const onion = readOnion(name);
    if (onion) {
      current.onion = onion;
      const latest = await loadApps();
      const record = latest.find(a => a.name === name);
      if (record) {
        record.onion = onion;
        await saveApps(latest);
      }
    }
  }

  if (usesVercel(providers)) {
    stopTunnel(name);
    const deployment = loadDeployment(name);
    if (deployment && deployment.url) {
      const pid = startTunnel(name);
      console.log(`Vercel tunnel for '${name}' reconnected (pid ${pid}).`);
    } else {
      console.log(`Vercel tunnel not started: run 'stackedge vercel init ${name}' first.`);
    }
  }

  console.log(
    `Restarted '${name}' on port ${primaryPort(current) || "auto"} ` +
      `(logs: ~/.stackedge/logs/${name}.log)`
  );
}

module.exports = { restartApp };
