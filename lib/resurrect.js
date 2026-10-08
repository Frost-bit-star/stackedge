const { loadApps, saveApps } = require("./registry");
const { startProcess, isPidAlive } = require("./process");
const { isPortAlive, primaryPort } = require("./ports");
const { publishApps, waitForHostname } = require("./tor/tor");

async function resurrect() {
  const apps = await loadApps();
  if (!apps.length) {
    console.log("No apps to resurrect");
    return;
  }

  for (const app of apps) {
    const port = primaryPort(app);
    const alreadyRunning =
      isPidAlive(app.pid) && port ? await isPortAlive(port) : false;

    if (alreadyRunning) {
      app.appState = "running";
      continue;
    }

    try {
      await startProcess(app);
      app.appState = "running";
    } catch (err) {
      app.appState = "stopped";
      console.log(`Failed to start '${app.name}': ${err.message}`);
    }
    app.torState = "pending";
  }

  try {
    await publishApps(apps);
  } catch (err) {
    console.log(`Tor is not ready yet: ${err.message}`);
    console.log("Run 'stackedge list' later to pick up the onion URLs.");
    await saveApps(apps);
    return;
  }

  for (const app of apps) {
    try {
      app.onion = await waitForHostname(app.name, 30000);
      app.torState = "online";
    } catch {
      app.torState = "pending";
    }
  }

  await saveApps(apps);
  console.log("All apps resurrected");
}

module.exports = { resurrect };
