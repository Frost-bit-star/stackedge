const { loadApps } = require("../registry");
const { readOnion } = require("../tor/tor");

function onionOf(app) {
  return app.onion || readOnion(app.name);
}

/**
 * Print the full onion URL(s) - plain text, nothing truncated,
 * so it can be copied easily (Termux long-press, pipes, scripts).
 * @param {string} [name] - app name; omit for every app
 */
async function onionCommand(name) {
  const apps = await loadApps();

  if (name) {
    const app = apps.find(a => a.name === name);
    if (!app) {
      console.log(`App '${name}' not found`);
      process.exitCode = 1;
      return;
    }

    const onion = onionOf(app);
    if (!onion) {
      console.log(`No onion URL for '${name}' yet - give Tor a moment, then retry.`);
      process.exitCode = 1;
      return;
    }

    console.log(`https://${onion}`);
    return;
  }

  if (!apps.length) {
    console.log("No apps yet - start one with: stackedge start <name> -- <cmd>");
    return;
  }

  for (const app of apps) {
    const onion = onionOf(app);
    console.log(`${app.name} ${onion ? `https://${onion}` : "-"}`);
  }
}

module.exports = { onionCommand, onionOf };
