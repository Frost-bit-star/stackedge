const { loadApps } = require("../registry");
const { stopProcess } = require("../process");

async function stopApp(name) {
  const apps = await loadApps();
  const app = apps.find(a => a.name === name);
  if (!app) return console.log("App not found");
  if (!app.pid) return console.log(`${name} is not running`);

  await stopProcess(app);
  console.log(`Stopped ${name}`);
}

module.exports = { stopApp };
