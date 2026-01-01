const { loadApps, saveApps } = require("../registry");
const { stopProcess } = require("../process");
const fs = require("fs-extra");
const path = require("path");

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

  // Stop the app if running
  if (app.pid) {
    stopProcess(app);
    console.log(`Stopped '${name}'`);
  }

  // Remove app from registry
  apps.splice(index, 1);
  await saveApps(apps);
  console.log(`Deleted '${name}' from registry`);

  // Optional: delete app folder if you want
  // await fs.remove(app.cwd);
  // console.log(`Deleted folder: ${app.cwd}`);

  // Optional: delete Tor hidden service if exists
  // const hiddenServiceDir = path.join(process.env.HOME, ".tor", "hidden_service_" + name);
  // if (await fs.pathExists(hiddenServiceDir)) {
  //   await fs.remove(hiddenServiceDir);
  //   console.log(`Deleted Tor hidden service: ${hiddenServiceDir}`);
  // }
}

module.exports = { deleteApp };
