const { loadApps, saveApps } = require("../registry");
const { startProcess, stopProcess } = require("../process");

async function restartApp(name) {
  const apps = await loadApps();
  const app = apps.find(a => a.name === name);
  if (!app) return console.log("App not found");
  stopProcess(app);
  startProcess(app);
  await saveApps(apps);
  console.log(`Restarted ${name}`);
}

module.exports = { restartApp };
