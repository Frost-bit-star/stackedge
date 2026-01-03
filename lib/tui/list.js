// lib/tui/list.js

const chalkModule = require("chalk");
const chalk = chalkModule.default ? chalkModule.default : chalkModule;

const net = require("net");
const { loadApps, saveApps } = require("../registry");

// Check if a TCP port is accepting connections
async function isPortAlive(port) {
  return new Promise((resolve) => {
    const s = net.createConnection(port, "127.0.0.1");
    s.once("connect", () => {
      s.end();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}

// Pad or trim helper
function col(text, width) {
  text = String(text);
  return text.length > width
    ? text.slice(0, width - 1) + "…"
    : text.padEnd(width);
}

async function listApps() {
  const apps = await loadApps();
  let changed = false;

  const widths = {
    name: 10,
    app: 12,
    ports: 14,
    tor: 11,
    onion: 56
  };

  const line =
    "┌" +
    "─".repeat(widths.name) + "┬" +
    "─".repeat(widths.app) + "┬" +
    "─".repeat(widths.ports) + "┬" +
    "─".repeat(widths.tor) + "┬" +
    "─".repeat(widths.onion) +
    "┐";

  const sep =
    "├" +
    "─".repeat(widths.name) + "┼" +
    "─".repeat(widths.app) + "┼" +
    "─".repeat(widths.ports) + "┼" +
    "─".repeat(widths.tor) + "┼" +
    "─".repeat(widths.onion) +
    "┤";

  const bottom =
    "└" +
    "─".repeat(widths.name) + "┴" +
    "─".repeat(widths.app) + "┴" +
    "─".repeat(widths.ports) + "┴" +
    "─".repeat(widths.tor) + "┴" +
    "─".repeat(widths.onion) +
    "┘";

  console.log(chalk.gray(line));
  console.log(
    chalk.gray("│") +
    chalk.bold(col(" NAME", widths.name)) +
    chalk.gray("│") +
    chalk.bold(col(" APP", widths.app)) +
    chalk.gray("│") +
    chalk.bold(col(" PORTS", widths.ports)) +
    chalk.gray("│") +
    chalk.bold(col(" TOR", widths.tor)) +
    chalk.gray("│") +
    chalk.bold(col(" ONION URL", widths.onion)) +
    chalk.gray("│")
  );
  console.log(chalk.gray(sep));

  for (const a of apps) {
    const targets = Array.isArray(a.ports) ? a.ports.map(p => p.target) : [];

    // App is running if ANY target port is alive
    let running = false;
    for (const p of targets) {
      if (await isPortAlive(p)) {
        running = true;
        break;
      }
    }

    const appState = running ? "running" : "stopped";
    const torState = running && a.onion ? "online" : "offline";

    const appColor = running ? chalk.green : chalk.red;
    const torColor = torState === "online" ? chalk.green : chalk.yellow;

    const portLabel = targets.length ? targets.join(",") : "-";
    const onionLabel = a.onion ? `https://${a.onion}` : "-";

    console.log(
      chalk.gray("│") +
      chalk.cyan(col(" " + a.name, widths.name)) +
      chalk.gray("│") +
      appColor(col(" " + appState, widths.app)) +
      chalk.gray("│") +
      chalk.blue(col(" " + portLabel, widths.ports)) +
      chalk.gray("│") +
      torColor(col(" " + torState, widths.tor)) +
      chalk.gray("│") +
      chalk.magenta(col(" " + onionLabel, widths.onion)) +
      chalk.gray("│")
    );

    // Heal registry
    if (a.appState !== appState || a.torState !== torState) {
      a.appState = appState;
      a.torState = torState;
      changed = true;
    }
  }

  console.log(chalk.gray(bottom));

  if (changed) {
    await saveApps(apps);
  }
}

module.exports = { listApps };
