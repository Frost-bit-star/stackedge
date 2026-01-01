#!/usr/bin/env node

const { program } = require("commander");
const { loadApps, saveApps } = require("../lib/registry");
const { startProcess } = require("../lib/process");
const { listApps } = require("../lib/tui/list");
const { resurrect } = require("../lib/resurrect");
const { stopApp } = require("../lib/commands/stop");
const { restartApp } = require("../lib/commands/restart");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs-extra");
const net = require("net");

// Termux Tor binary & data directory
const TOR_BIN = "/data/data/com.termux/files/usr/bin/tor";
const TOR_DIR = path.join(process.env.HOME, ".tor");
const TORRC = path.join(TOR_DIR, "torrc");

// Ensure Tor config exists
async function ensureTorConfig() {
  await fs.ensureDir(TOR_DIR);

  const baseConfig = `
DataDirectory ${TOR_DIR}
ControlPort 9051
CookieAuthentication 1
AvoidDiskWrites 1
`.trim();

  if (!fs.existsSync(TORRC)) {
    await fs.writeFile(TORRC, baseConfig, "utf-8");
  }
}

// Start Tor fully detached
async function startTorBackground() {
  await ensureTorConfig();

  const tor = spawn(TOR_BIN, ["-f", TORRC], {
    cwd: TOR_DIR,
    detached: true,
    stdio: "ignore",
  });

  tor.unref();
  console.log("Tor is running in the background...");
}

// Detect first free TCP port between 3000–9000
async function detectPort() {
  for (let port = 3000; port <= 9000; port++) {
    if (!(await isPortOpen(port))) return port;
  }
  return null;
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(200);
    socket
      .once("connect", () => {
        socket.destroy();
        resolve(true);
      })
      .once("timeout", () => {
        socket.destroy();
        resolve(false);
      })
      .once("error", () => {
        socket.destroy();
        resolve(false);
      })
      .connect(port, "127.0.0.1");
  });
}

// START COMMAND
program
  .command("start <name>")
  .allowUnknownOption(true)
  .action(async (name) => {
    const argsIndex = process.argv.indexOf("--");
    if (argsIndex === -1) {
      console.log("Usage: stackedge start <name> -- <command>");
      return;
    }
    const cmd = process.argv.slice(argsIndex + 1).join(" ");
    if (!cmd) return console.log("No command provided");

    const apps = await loadApps();
    const cwd = process.cwd();

    const app = {
      name,
      cwd,
      command: cmd,
      port: process.env.PORT || null,
      appState: "starting",
      torState: "pending",
      onion: null,
      pid: null,
      autorestart: true,
    };

    // Start the user command
    startProcess(app);

    // Detect port if not set
    if (!app.port) {
      console.log("Detecting port...");
      const detectedPort = await detectPort();
      if (detectedPort) {
        app.port = detectedPort;
        console.log(`Detected port: ${detectedPort}`);
      } else {
        console.log(
          "No port detected. Set PORT env variable to expose via Tor."
        );
      }
    }

    apps.push(app);
    await saveApps(apps);

    console.log(`App '${name}' started in folder ${cwd}`);

    // Start Tor in background
    startTorBackground().catch((err) => console.error("Failed to start Tor:", err));

    // Setup Tor hidden service if port is known
    if (app.port) {
      const hiddenServiceDir = path.join(TOR_DIR, "hidden_service_" + app.name);
      await fs.ensureDir(hiddenServiceDir);

      const hiddenServiceConfig = `
HiddenServiceDir ${hiddenServiceDir}
HiddenServicePort ${app.port} 127.0.0.1:${app.port}
`.trim();

      await fs.appendFile(TORRC, "\n" + hiddenServiceConfig);

      // Wait for hostname to appear
      const hostnameFile = path.join(hiddenServiceDir, "hostname");
      const checkHostname = setInterval(async () => {
        if (fs.existsSync(hostnameFile)) {
          app.onion = (await fs.readFile(hostnameFile, "utf-8")).trim();
          app.torState = "online";

          // Update registry
          const savedApps = await loadApps();
          const index = savedApps.findIndex((a) => a.name === app.name);
          if (index !== -1) {
            savedApps[index] = app;
            await saveApps(savedApps);
          }

          console.log(`Tor service for '${name}' is online: ${app.onion}`);
          clearInterval(checkHostname);
        }
      }, 1000);
    } else {
      app.torState = "error";
      await saveApps(apps);
    }
  });

// OTHER COMMANDS
program.command("stop <name>").action(stopApp);
program.command("restart <name>").action(restartApp);
program.command("list").action(listApps);
program.command("resurrect").action(resurrect);

// DEFAULT FALLBACK
program.action(async () => {
  console.log("stackedge status:");
  await listApps();
  console.log(
    "\nCommands:\n  start <name> -- <cmd>\n  stop <name>\n  restart <name>\n  list\n  resurrect"
  );
});

program.parse(process.argv);
