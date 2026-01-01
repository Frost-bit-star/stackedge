const { loadApps, saveApps } = require("../registry");
const { startProcess, stopProcess } = require("../process");

/**
 * Restart an app by stopping it and starting it again.
 * @param {string} name - App name
 */
async function restartApp(name) {
  const apps = await loadApps();
  const app = apps.find(a => a.name === name);

  if (!app) {
    console.log(`App '${name}' not found`);
    return;
  }

  // Stop the app
  stopProcess(app);

  // Reset port and state
  app.port = null;
  app.appState = "starting";
  app.torState = "pending";

  // Start it again
  startProcess(app);

  // Save updated apps registry
  const index = apps.findIndex(a => a.name === name);
  if (index !== -1) {
    apps[index] = app;
    await saveApps(apps);
  }

  console.log(`Restarted '${name}' successfully`);
}

module.exports = { restartApp };
