const { loadApps, saveApps } = require("../registry");
const { stopProcess } = require("../process");

async function stopApp(name) {
  const apps = await loadApps();
  const app = apps.find(a => a.name === name);
  if (!app) return console.log("App not found");
  stopProcess(app);
  await saveApps(apps);
  console.log(`Stopped ${name}`);
}

module.exports = { stopApp };
