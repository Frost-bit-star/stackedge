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

async function waitForPort(port, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      await new Promise((res, rej) => {
        const s = net.createConnection(port, "127.0.0.1");
        s.once("connect", () => { s.end(); res(); });
        s.once("error", rej);
      });
      return;
    } catch {
      await sleep(300);
    }
  }
  throw new Error(`Port ${port} never opened`);
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
    socket.once("connect", () => { socket.end(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}

async function startTorOnce() {
  await ensureTorFilesystem();
  if (await isTorRunning()) return;

  spawn(TOR_BIN, ["-f", TORRC], {
    detached: true,
    stdio: "ignore"
  }).unref();

  for (let i = 0; i < 20; i++) {
    if (await isTorRunning()) return;
    await sleep(1000);
  }

  throw new Error("Tor failed to start");
}

/* =========================
   TOR CONTROL
========================= */

async function torControl(cmd) {
  const cookie = await fs.readFile(path.join(TOR_BASE, "control_auth_cookie"));

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(CONTROL_PORT, "127.0.0.1");

    socket.on("error", reject);
    socket.on("data", d => {
      if (d.toString().startsWith("250")) {
        resolve(d.toString());
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

async function waitForTorBootstrap() {
  for (;;) {
    const res = await torControl("GETINFO status/bootstrap-phase");
    if (res.includes("PROGRESS=100")) return;
    await sleep(1000);
  }
}

/* =========================
   HIDDEN SERVICE MANAGEMENT
========================= */

async function addHiddenService(name, ports) {
  const hsPath = path.join(TOR_HS_DIR, name);
  await fs.ensureDir(hsPath);
  await fs.chmod(hsPath, 0o700);

  const lines = [
    `HiddenServiceDir ${hsPath}`,
    ...ports.map(p => `HiddenServicePort ${p.virtual} 127.0.0.1:${p.target}`)
  ];

  await fs.appendFile(TORRC, "\n" + lines.join("\n") + "\n");
  await torControl("SIGNAL RELOAD");

  const hostnamePath = path.join(hsPath, "hostname");
  for (let i = 0; i < 30; i++) {
    if (await fs.pathExists(hostnamePath)) {
      return (await fs.readFile(hostnamePath, "utf8")).trim();
    }
    await sleep(500);
  }

  throw new Error("Hidden service hostname not created");
}

async function cleanupOrphans(apps) {
  const active = new Set(apps.map(a => a.name));
  if (!await fs.pathExists(TOR_HS_DIR)) return;

  for (const dir of await fs.readdir(TOR_HS_DIR)) {
    if (!active.has(dir)) {
      await fs.remove(path.join(TOR_HS_DIR, dir));
    }
  }
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

    // Use custom ports if provided via env, otherwise allocate dynamically
    const httpPort = Number(process.env.PORT || await getFreePort());
    const sslPort = process.env.SSL_PORT ? Number(process.env.SSL_PORT) : null;

    const ports = [{ virtual: 80, target: httpPort }];
    if (sslPort) ports.push({ virtual: 443, target: sslPort });

    await startTorOnce();
    await waitForTorBootstrap();

    startProcess({
      name,
      command,
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      env: { ...process.env, PORT: String(httpPort), SSL_PORT: sslPort ? String(sslPort) : undefined }
    });

    // Wait for all mapped ports
    for (const p of ports) await waitForPort(p.target);

    const onion = await addHiddenService(name, ports);
    await cleanupOrphans(apps);

    apps.push({
      name,
      ports,
      onion,
      command,
      appState: "online",
      torState: "online",
      autorestart: true
    });

    await saveApps(apps);

    console.log(`✔ ${name} running in background`);
    console.log(`🌐 http${sslPort ? "s" : ""}://${onion}`);
  });

/* =========================
   OTHER COMMANDS
========================= */

program.command("stop <name>").action(stopApp);
program.command("restart <name>").action(restartApp);
program.command("list").action(listApps);
program.command("resurrect").action(resurrect);

program.parse(process.argv);
