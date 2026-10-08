#!/usr/bin/env node

const { program } = require("commander");
const path = require("path");

const { loadApps, saveApps } = require("../lib/registry");
const { startProcess } = require("../lib/process");
const { listApps } = require("../lib/tui/list");
const { resurrect } = require("../lib/resurrect");
const { stopApp } = require("../lib/commands/stop");
const { restartApp } = require("../lib/commands/restart");
const { deleteApp } = require("../lib/commands/delete");
const { logsApp } = require("../lib/commands/logs");
const { daemon, hasSystemd, installedAnywhere } = require("../lib/commands/daemon");
const {
  getFreePort,
  isPortFree,
  detectPortInCommand,
  parsePort,
  waitForPort
} = require("../lib/ports");
const { publishApps, waitForHostname } = require("../lib/tor/tor");
const { ensureTorInstalled } = require("../lib/tor/install");
const { LOG_DIR } = require("../lib/config");

program
  .name("stackedge")
  .description("Decentralized app hosting with Tor - Termux and any Linux server")
  .version(require("../package.json").version)
  .showHelpAfterError();

/* =========================
   START COMMAND
========================= */

program
  .command("start <name>")
  .description("start an app in the background and expose it as an onion service")
  .allowUnknownOption(true)
  .option("-p, --port <port>", "port your app listens on (default: auto-detected)")
  .option("--ssl-port <port>", "SSL/TLS port your app listens on (optional)")
  .option("--host <host>", "address the app listens on (default: 127.0.0.1)")
  .action(async (name, opts) => {
    const idx = process.argv.indexOf("--");
    if (idx === -1) {
      console.log("Usage: stackedge start <name> [--port <port>] -- <cmd>");
      process.exit(1);
    }

    const command = process.argv.slice(idx + 1).join(" ").trim();
    if (!command) {
      console.log("Usage: stackedge start <name> [--port <port>] -- <cmd>");
      process.exit(1);
    }

    const apps = await loadApps();
    if (apps.some(a => a.name === name)) {
      console.log(`App '${name}' already exists. Use 'stackedge restart ${name}' or another name.`);
      process.exit(1);
    }

    // Any port works: --port beats a port found in the command, which beats
    // $PORT, which beats "let the OS hand out a free one".
    let httpPort;
    try {
      const chosen =
        opts.port || detectPortInCommand(command) || process.env.PORT || (await getFreePort());
      httpPort = parsePort(chosen, "--port");
    } catch (err) {
      console.log(err.message);
      process.exit(1);
    }

    let sslPort = null;
    if (opts.sslPort || process.env.SSL_PORT) {
      try {
        sslPort = parsePort(opts.sslPort || process.env.SSL_PORT, "--ssl-port");
      } catch (err) {
        console.log(err.message);
        process.exit(1);
      }
    }

    if (httpPort < 1024) {
      console.log(`Note: ports below 1024 usually need root privileges (port ${httpPort}).`);
    }
    if (!(await isPortFree(httpPort, opts.host || "127.0.0.1"))) {
      console.log(`Warning: port ${httpPort} is already in use - '${name}' may fail to bind.`);
    }

    const ports = [{ virtual: 80, target: httpPort }];
    if (sslPort) ports.push({ virtual: 443, target: sslPort });

    const app = {
      name,
      command,
      cwd: process.cwd(),
      ports,
      host: opts.host || null,
      onion: null,
      appState: "starting",
      torState: "pending",
      autorestart: true
    };

    apps.push(app);
    await saveApps(apps);

    await startProcess(app);
    console.log(
      `✔ ${name} running in background on port ${httpPort}` +
        (sslPort ? ` (+${sslPort})` : "") +
        `\n  logs: ${path.join(LOG_DIR, `${name}.log`)}`
    );

    try {
      await waitForPort(httpPort, { timeout: 30000, host: opts.host });
    } catch {
      console.log(`✖ '${name}' never started listening on port ${httpPort}.`);
      console.log(`  command: ${command}`);
      console.log(`  logs:    ${path.join(LOG_DIR, `${name}.log`)}`);
      process.exit(1);
    }

    const tor = ensureTorInstalled();
    if (tor.ok) {
      try {
        await publishApps(await loadApps());
        const onion = await waitForHostname(name);
        await setOnion(name, onion, "online");
        console.log(`🌐 http${sslPort ? "s" : ""}://${onion}`);
      } catch (err) {
        console.log(`⏳ '${name}' is up, but Tor is not ready: ${err.message}`);
        console.log("  Run 'stackedge list' in a moment to get the onion URL.");
      }
    } else {
      console.log(`⏳ '${name}' is up, but Tor is missing - run 'stackedge setup'.`);
    }

    if (hasSystemd() && !installedAnywhere()) {
      console.log(
        "Tip: run 'stackedge daemon install' so your apps come back after a server reboot."
      );
    }
  });

async function setOnion(name, onion, torState) {
  const apps = await loadApps();
  const app = apps.find(a => a.name === name);
  if (!app) return;
  app.onion = onion;
  app.torState = torState;
  app.appState = app.pid ? "running" : app.appState;
  await saveApps(apps);
}

/* =========================
   OTHER COMMANDS
========================= */

program.command("stop <name>").description("stop a running app").action(stopApp);
program.command("restart <name>").description("restart an app on its existing ports").action(restartApp);
program.command("delete <name>").description("remove an app and its onion service").action(deleteApp);
program.command("list").description("list apps, ports and onion URLs").action(listApps);
program.command("resurrect").description("restore all apps (after reboot / Termux restart)").action(resurrect);
program
  .command("logs <name>")
  .description("show recent logs for an app")
  .option("-n, --lines <n>", "number of trailing lines", "100")
  .action((name, opts) => logsApp(name, parseInt(opts.lines, 10) || 100));

program
  .command("daemon <action>")
  .description("boot integration: install | uninstall | status (systemd, cron or shell hook)")
  .action(daemon);

program
  .command("setup")
  .description("one-shot server setup: install Tor (if missing) + start apps on boot")
  .action(() => {
    const tor = ensureTorInstalled();
    if (!tor.ok) {
      console.log("\nFix the Tor installation, then run 'stackedge setup' again.");
      process.exit(1);
    }
    console.log("");
    daemon("install");
    console.log("\nDone. Host something with: stackedge start <name> -- <cmd>");
  });

if (process.argv.length <= 2) {
  program.help();
}

program.parse(process.argv);
