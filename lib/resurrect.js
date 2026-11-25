const { loadApps, saveApps } = require("./registry");
const { startProcess, isPidAlive } = require("./process");
const { isPortAlive, primaryPort } = require("./ports");
const { publishApps, waitForHostname } = require("./tor/tor");
const { ensureProxy } = require("./security/manager");
const { normalizeProviders, usesTor, hostingKey } = require("./hosting");

async function resurrect() {
  const apps = await loadApps();
  if (!apps.length) {
    console.log("No apps to resurrect");
    return;
  }

  for (const app of apps) {
    app.providers = normalizeProviders(app);
    app.hosting = hostingKey(app.providers);
  }
  const torApps = apps.filter(app => usesTor(app.providers));

  for (const app of apps) {
    const port = primaryPort(app);
    const alreadyRunning =
      isPidAlive(app.pid) && port ? await isPortAlive(port) : false;

    if (alreadyRunning) {
      app.appState = "running";
      app.torState = usesTor(app.providers) ? app.onion ? "online" : "pending" : "disabled";
      if (!usesTor(app.providers)) app.onion = null;
      try {
        await ensureProxy(app);
      } catch (err) {
        console.log(`Warning: security proxy for '${app.name}' failed: ${err.message}`);
      }
      continue;
    }

    try {
      await startProcess(app);
      app.appState = "running";
    } catch (err) {
      app.appState = "stopped";
      console.log(`Failed to start '${app.name}': ${err.message}`);
    }

    try {
      await ensureProxy(app);
    } catch (err) {
      console.log(`Warning: security proxy for '${app.name}' failed: ${err.message}`);
    }
    app.torState = usesTor(app.providers) ? "pending" : "disabled";
    if (!usesTor(app.providers)) app.onion = null;
  }

  if (torApps.length) {
    try {
      await publishApps(torApps);
    } catch (err) {
      console.log(`Tor is not ready yet: ${err.message}`);
      console.log("Run 'stackedge list' later to pick up the onion URLs.");
      await saveApps(apps);
      return;
    }

    for (const app of torApps) {
      try {
        app.onion = await waitForHostname(app.name, 30000);
        app.torState = "online";
      } catch {
        app.torState = "pending";
      }
    }
  }

  await saveApps(apps);
  console.log("All apps resurrected");
}

module.exports = { resurrect };
