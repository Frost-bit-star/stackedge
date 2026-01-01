// lib/tui/list.js

// For Chalk v5+, handle default export
const chalkModule = require("chalk");
const chalk = chalkModule.default ? chalkModule.default : chalkModule;

const { loadApps, saveApps } = require("../registry");

// Check if a PID is alive (works on Termux / Linux / Node)
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0); // signal 0 just tests for existence
    return true;
  } catch {
    return false;
  }
}

async function listApps() {
  const apps = await loadApps();

  console.log(chalk.bold("NAME     APP STATE   PORT   TOR STATE   ONION"));

  for (const a of apps) {
    // Real-time check if the app is actually running
    const alive = a.pid && isProcessAlive(a.pid);
    const appState = alive ? (a.appState || "running") : "stopped";

    console.log(
      `${a.name.padEnd(8)} ` +
      `${(appState || "").padEnd(11)} ` +
      `${String(a.port || "-").padEnd(6)} ` +
      `${(a.torState || "").padEnd(10)} ` +
      `${a.onion || "setting up"}`
    );

    // Update registry if state has changed
    if (appState !== a.appState) {
      a.appState = appState;
      const allApps = await loadApps();
      const index = allApps.findIndex(x => x.name === a.name);
      if (index !== -1) {
        allApps[index] = a;
        await saveApps(allApps);
      }
    }
  }
}

module.exports = { listApps };
