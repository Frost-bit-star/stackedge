const { loadApps } = require("../registry");
const { stopProcess } = require("../process");
const { stopProxy } = require("../security/manager");

async function stopApp(name) {
  const apps = await loadApps();
  const app = apps.find(a => a.name === name);
  if (!app) return console.log("App not found");
  if (!app.pid) return console.log(`${name} is not running`);

  await stopProxy(app);
  await stopProcess(app);
  console.log(`Stopped ${name}`);
}

module.exports = { stopApp };
