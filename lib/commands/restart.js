const { loadApps, saveApps } = require("../registry");
const { startProcess, stopProcess } = require("../process");
const { primaryPort } = require("../ports");
const { publishApps, readOnion } = require("../tor/tor");

/**
 * Restart an app by stopping it and starting it again on the same ports.
 * @param {string} name - App name
 */
async function restartApp(name) {
  const apps = await loadApps();
  const app = apps.find(a => a.name === name);

  if (!app) {
    console.log(`App '${name}' not found`);
    return;
  }

  await stopProcess(app);

  const current = (await loadApps()).find(a => a.name === name) || app;
  current.appState = "starting";
  current.torState = current.onion ? "online" : "pending";
  await startProcess(current);

  try {
    await publishApps(await loadApps());
  } catch (err) {
    console.log(`Warning: could not publish to Tor yet: ${err.message}`);
  }

  if (!current.onion) {
    const onion = readOnion(name);
    if (onion) {
      current.onion = onion;
      const latest = await loadApps();
      const record = latest.find(a => a.name === name);
      if (record) {
        record.onion = onion;
        await saveApps(latest);
      }
    }
  }

  console.log(
    `Restarted '${name}' on port ${primaryPort(current) || "auto"} ` +
      `(logs: ~/.stackedge/logs/${name}.log)`
  );
}

module.exports = { restartApp };
