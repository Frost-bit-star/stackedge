const { loadApps, saveApps } = require("./registry");
const { startProcess } = require("./process");
const { ensureTorConfig, startTor } = require("./tor/tor");
const { waitForBootstrap } = require("./tor/bootstrap");
const { createOnion } = require("./tor/control");

async function resurrect() {
  const apps = await loadApps();
  if (!apps.length) return;

  for (const app of apps) {
    startProcess(app);
    app.appState = "running";
    app.torState = "pending";
  }

  await ensureTorConfig();
  startTor();
  await waitForBootstrap();

  for (const app of apps) {
    if (!app.onion) app.onion = await createOnion(app.port || 8080);
    app.torState = "online";
  }

  await saveApps(apps);
  console.log("All apps resurrected");
}

module.exports = { resurrect };
