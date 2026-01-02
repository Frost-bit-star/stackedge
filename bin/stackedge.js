#!/usr/bin/env node

const { program } = require("commander");
const { loadApps, saveApps } = require("../lib/registry");
const { startProcess } = require("../lib/process");
const { listApps } = require("../lib/tui/list");
const { resurrect } = require("../lib/resurrect");
const { stopApp } = require("../lib/commands/stop");
const { restartApp } = require("../lib/commands/restart");

const { spawn } = require("child_process");
const net = require("net");
const fs = require("fs-extra");
const path = require("path");

/* =========================
   TOR CONSTANTS
========================= */

const TOR_BIN = "/data/data/com.termux/files/usr/bin/tor";
const TOR_BASE = path.join(process.env.HOME, ".tor");
const TORRC = path.join(TOR_BASE, "torrc");
const TOR_HS_DIR = path.join(TOR_BASE, "hidden");
const CONTROL_PORT = 9051;

/* =========================
   UTILS
========================= */

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getFreePort(start = 3000, end = 9000) {
  for (let p = start; p <= end; p++) {
    try {
      await new Promise((res, rej) => {
        const s = net.createServer()
          .once("error", rej)
          .once("listening", () => s.close(res))
          .listen(p, "127.0.0.1");
      });
      return p;
    } catch {}
  }
  throw new Error("No free ports");
}

/* =========================
   TOR MANAGEMENT
========================= */

async function ensureTorFilesystem() {
  await fs.ensureDir(TOR_BASE);
  await fs.ensureDir(TOR_HS_DIR);

  await fs.chmod(TOR_BASE, 0o700);
  await fs.chmod(TOR_HS_DIR, 0o700);

  if (!await fs.pathExists(TORRC)) {
    await fs.writeFile(TORRC, `
DataDirectory ${TOR_BASE}
ControlPort ${CONTROL_PORT}
CookieAuthentication 1
AvoidDiskWrites 1
Log notice stdout
`.trim() + "\n");
  }
}

async function isTorRunning() {
  return new Promise((resolve) => {
    const socket = net.createConnection(CONTROL_PORT, "127.0.0.1");
    socket.once("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function startTorOnce() {
  await ensureTorFilesystem();

  if (await isTorRunning()) return;

  spawn(TOR_BIN, ["-f", TORRC], {
    detached: true,
    stdio: "ignore",
  }).unref();

  // wait for control port
  for (let i = 0; i < 15; i++) {
    if (await isTorRunning()) return;
    await sleep(1000);
  }

  throw new Error("Tor failed to start");
}

/* =========================
   TOR CONTROL PORT
========================= */

async function torControl(cmd) {
  const cookie = await fs.readFile(
    path.join(TOR_BASE, "control_auth_cookie")
  );

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(CONTROL_PORT, "127.0.0.1");

    socket.on("error", reject);

    socket.on("data", (data) => {
      if (data.toString().startsWith("250")) {
        resolve(data.toString());
        socket.end();
      }
    });

    socket.once("connect", () => {
      socket.write(`AUTHENTICATE ${cookie.toString("hex")}\r\n`);
      socket.write(cmd + "\r\n");
      socket.write("QUIT\r\n");
    });
  });
}

async function addHiddenService(name, port) {
  const dir = path.join(TOR_HS_DIR, name);
  await fs.ensureDir(dir);
  await fs.chmod(dir, 0o700);

  const res = await torControl(
    `ADD_ONION NEW:ED25519-V3 Port=${port},127.0.0.1:${port}`
  );

  return res.match(/ServiceID=(\S+)/)[1] + ".onion";
}

/* =========================
   START COMMAND
========================= */

program.command("start <name>")
  .allowUnknownOption(true)
  .action(async (name) => {

    const idx = process.argv.indexOf("--");
    if (idx === -1) {
      console.log("Usage: stackedge start <name> -- <cmd>");
      process.exit(1);
    }

    const command = process.argv.slice(idx + 1).join(" ");
    const apps = await loadApps();

    const port = process.env.PORT || await getFreePort();

    await startTorOnce();

    const onion = await addHiddenService(name, port);

    startProcess({
      name,
      command,
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(port) }
    });

    apps.push({
      name,
      port,
      onion,
      command,
      appState: "online",
      torState: "online",
      autorestart: true
    });

    await saveApps(apps);

    console.log(`✔ ${name} running`);
    console.log(`🌐 ${onion}`);
  });

/* =========================
   OTHER COMMANDS
========================= */

program.command("stop <name>").action(stopApp);
program.command("restart <name>").action(restartApp);
program.command("list").action(listApps);
program.command("resurrect").action(resurrect);

program.parse(process.argv);
