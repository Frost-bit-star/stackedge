// lib/tui/list.js

// For Chalk v5+, handle default export
const chalkModule = require("chalk");
const chalk = chalkModule.default ? chalkModule.default : chalkModule;

const { loadApps } = require("../registry");

async function listApps() {
  const apps = await loadApps();

  console.log(chalk.bold("NAME     APP STATE   PORT   TOR STATE   ONION"));
  
  for (const a of apps) {
    console.log(
      `${a.name.padEnd(8)} ` +
      `${(a.appState || "").padEnd(11)} ` +
      `${String(a.port || "-").padEnd(6)} ` +
      `${(a.torState || "").padEnd(10)} ` +
      `${a.onion || "setting up"}`
    );
  }
}

module.exports = { listApps };
