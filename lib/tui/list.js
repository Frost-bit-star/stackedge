// lib/tui/list.js

const chalkModule = require("chalk");
const chalk = chalkModule.default ? chalkModule.default : chalkModule;

const { loadApps, saveApps } = require("../registry");
const { isPortAlive } = require("../ports");
const { readOnion } = require("../tor/tor");

// Pad or trim helper
function col(text, width) {
  text = String(text);
  return text.length > width
    ? text.slice(0, width - 1) + "…"
    : text.padEnd(width);
}

async function collectRows() {
  const apps = await loadApps();
  let changed = false;
  const rows = [];

  for (const a of apps) {
    // Pick up an onion address that Tor created after the app was registered
    if (!a.onion) {
      const onion = readOnion(a.name);
      if (onion) {
        a.onion = onion;
        changed = true;
      }
    }

    let targets = Array.isArray(a.ports) ? a.ports.map(p => p.target) : [];
    if (!targets.length && a.port) targets = [a.port];

    // App is running if ANY target port is alive
    let running = false;
    for (const p of targets) {
      if (await isPortAlive(p)) {
        running = true;
        break;
      }
    }

    const appState = running ? "running" : "stopped";
    const torState = a.onion ? "online" : "pending";

    // Heal registry
    if (a.appState !== appState || a.torState !== torState) {
      a.appState = appState;
      a.torState = torState;
      changed = true;
    }

    rows.push({
      app: a,
      appState,
      torState,
      portLabel: targets.length ? targets.join(",") : "-",
      onionLabel: a.onion ? `https://${a.onion}` : "-"
    });
  }

  if (changed) await saveApps(apps);
  return rows;
}

async function listApps({ full = false } = {}) {
  const rows = await collectRows();

  // --full: plain text, never truncated, easy to copy on a phone or in a pipe
  if (full) {
    for (const r of rows) {
      console.log(
        `${r.app.name}\t${r.appState}\t${r.portLabel}\t${r.torState}\t${r.onionLabel}`
      );
    }
    return;
  }

  const widths = {
    name: 10,
    app: 12,
    ports: 14,
    tor: 11,
    onion: 56
  };

  // Use the whole terminal width so a full onion URL fits when there is room
  const columns = process.stdout.columns || 80;
  const fixed = widths.name + widths.app + widths.ports + widths.tor + 6;
  widths.onion = Math.max(widths.onion, columns - fixed);

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

  let truncated = false;

  for (const r of rows) {
    if (r.onionLabel.length + 1 > widths.onion) truncated = true;

    const appColor = r.appState === "running" ? chalk.green : chalk.red;
    const torColor = r.torState === "online" ? chalk.green : chalk.yellow;

    console.log(
      chalk.gray("│") +
      chalk.cyan(col(" " + r.app.name, widths.name)) +
      chalk.gray("│") +
      appColor(col(" " + r.appState, widths.app)) +
      chalk.gray("│") +
      chalk.blue(col(" " + r.portLabel, widths.ports)) +
      chalk.gray("│") +
      torColor(col(" " + r.torState, widths.tor)) +
      chalk.gray("│") +
      chalk.magenta(col(" " + r.onionLabel, widths.onion)) +
      chalk.gray("│")
    );
  }

  console.log(chalk.gray(bottom));

  if (truncated) {
    console.log(
      chalk.gray("URL cut off? Run 'stackedge onion <name>' or 'stackedge list --full'.")
    );
  }
}

module.exports = { listApps };
