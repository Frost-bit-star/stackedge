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

// Termux Tor binary & data directory
const TOR_BIN = "/data/data/com.termux/files/usr/bin/tor";
const TOR_DIR = path.join(process.env.HOME, ".tor");
const TORRC = path.join(TOR_DIR, "torrc");

// Ensure Tor config directory exists
async function ensureTorConfig() {
  await fs.ensureDir(TOR_DIR);

  const baseConfig = `
DataDirectory ${TOR_DIR}
ControlPort 9051
CookieAuthentication 1
AvoidDiskWrites 1
`.trim();

  await fs.writeFile(TORRC, baseConfig, "utf-8");
}

// Start Tor in background and wait until bootstrap
async function startTor() {
  await ensureTorConfig();

  return new Promise((resolve, reject) => {
    const tor = spawn(TOR_BIN, ["-f", TORRC], {
      cwd: TOR_DIR,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"]
    });

    tor.stdout.on("data", (data) => {
      const text = data.toString();
      process.stdout.write(text);

      if (text.includes("Bootstrapped 100%")) {
        resolve();
      }
    });

    tor.stderr.on("data", (data) => process.stderr.write(data.toString()));
    tor.on("error", (err) => reject(err));

    tor.unref();
  });
}

// Start command
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
      port: null,
      appState: "starting",
      torState: "pending",
      onion: null,
      pid: null,
      autorestart: true
    };

    // Start the app immediately
    startProcess(app); // make sure startProcess updates app.pid

    // Detect port if your app exposes PORT env or fixed port
    const detectedPort = process.env.PORT || 3000; // fallback if unknown
    app.port = detectedPort;

    // Save app info immediately
    apps.push(app);
    await saveApps(apps);

    console.log(`App '${name}' started in folder ${cwd}`);
    console.log("Starting Tor in background...");

    try {
      await startTor();

      // Setup hidden service for this app
      const hiddenServiceDir = path.join(TOR_DIR, "hidden_service_" + app.name);
      await fs.ensureDir(hiddenServiceDir);

      const hiddenServiceConfig = `
HiddenServiceDir ${hiddenServiceDir}
HiddenServicePort ${detectedPort} 127.0.0.1:${detectedPort}
      `.trim();

      await fs.appendFile(TORRC, "\n" + hiddenServiceConfig);

      // Wait for hostname file to appear
      const hostnameFile = path.join(hiddenServiceDir, "hostname");
      const checkHostname = setInterval(async () => {
        if (fs.existsSync(hostnameFile)) {
          app.onion = (await fs.readFile(hostnameFile, "utf-8")).trim();
          app.torState = "online";

          // Update registry
          const savedApps = await loadApps();
          const index = savedApps.findIndex(a => a.name === app.name);
          if (index !== -1) {
            savedApps[index] = app;
            await saveApps(savedApps);
          }

          console.log(`Tor service for ${name} is online: ${app.onion}`);
          clearInterval(checkHostname);
        }
      }, 1000);
    } catch (err) {
      console.error("Failed to start Tor:", err);
    }
  });

// Other commands
program.command("stop <name>").action(stopApp);
program.command("restart <name>").action(restartApp);
program.command("list").action(listApps);
program.command("resurrect").action(resurrect);

// Default fallback
program.action(async () => {
  console.log("stackedge status:");
  await listApps();
  console.log("\nCommands:\n  start <name> -- <cmd>\n  stop <name>\n  restart <name>\n  list\n  resurrect");
});

program.parse(process.argv);
