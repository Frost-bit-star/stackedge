const { loadApps, saveApps } = require("../registry");
const { stopProcess } = require("../process");
const { publishApps } = require("../tor/tor");
const { stopProxy } = require("../security/manager");
const { normalizeProviders, usesTor } = require("../hosting");

/**
 * Delete an app from the registry and stop it if running.
 * @param {string} name - App name to delete
 */
async function deleteApp(name) {
  const apps = await loadApps();
  const index = apps.findIndex(a => a.name === name);

  if (index === -1) {
    console.log(`App '${name}' not found`);
    return;
  }

  const app = apps[index];
  const providers = normalizeProviders(app);

  await stopProxy(app);
  if (app.pid) {
    await stopProcess(app);
    console.log(`Stopped '${name}'`);
  }

  apps.splice(index, 1);
  await saveApps(apps);
  console.log(`Deleted '${name}' from registry`);

  if (usesTor(providers)) {
    try {
      await publishApps(apps.filter(item => usesTor(normalizeProviders(item))));
    } catch (err) {
      console.log(`Warning: could not update Tor config: ${err.message}`);
    }
  }
}

module.exports = { deleteApp };
