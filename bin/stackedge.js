#!/usr/bin/env node

const { program } = require("commander");
const { loadApps, saveApps } = require("../lib/registry");
const { startProcess } = require("../lib/process");
const { listApps } = require("../lib/tui/list");
const { resurrect } = require("../lib/resurrect");
const { stopApp } = require("../lib/commands/stop");
const { restartApp } = require("../lib/commands/restart");

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

    startProcess(app);
    apps.push(app);
    await saveApps(apps);

    console.log(`App '${name}' started in folder ${cwd}`);
    console.log("Tor is setting up...");
  });

program.command("stop <name>").action(stopApp);
program.command("restart <name>").action(restartApp);
program.command("list").action(listApps);
program.command("resurrect").action(resurrect);

// Fallback / default command
program.action(async () => {
  console.log("stackedge status:");
  await listApps();
  console.log("\nCommands:\n  start <name> -- <cmd>\n  stop <name>\n  restart <name>\n  list\n  resurrect");
});

program.parse(process.argv);
