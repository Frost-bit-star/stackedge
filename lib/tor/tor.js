const fs = require("fs-extra");
const path = require("path");
const net = require("net");
const { spawn } = require("child_process");
const config = require("../config");
const { requireTorBin } = require("./bin");
const { getFreePort } = require("../ports");

const LEGACY_TOR_DIR = path.join(config.HOME, ".tor");
const CONTROL_STATE = path.join(config.TOR_DIR, "control-port");
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* =========================
   FILESYSTEM / CONFIG
========================= */

async function ensureTorFilesystem() {
  await fs.ensureDir(config.TOR_DIR);
  await fs.ensureDir(config.TOR_HS_DIR);
  try {
    await fs.chmod(config.TOR_DIR, 0o700);
    await fs.chmod(config.TOR_HS_DIR, 0o700);
  } catch {}

  // Older versions stored Tor data in ~/.tor - keep existing onion keys.
  if ((await fs.pathExists(LEGACY_TOR_DIR)) && !(await fs.pathExists(config.TORRC))) {
    try {
      await fs.copy(LEGACY_TOR_DIR, config.TOR_DIR, {
        overwrite: false,
        errorOnExist: false
      });
    } catch {}
  }
}

function hiddenServiceLines(app) {
  const ports = Array.isArray(app && app.ports) ? app.ports : [];
  if (!app || !app.name || !ports.length) return [];

  const host = app.host || config.APP_HOST;
  const dir = path.join(config.TOR_HS_DIR, app.name);

  return [
    `HiddenServiceDir ${dir}`,
    ...ports.map(p => `HiddenServicePort ${p.virtual} ${host}:${p.target}`)
  ];
}

/**
 * Rewrite torrc from the registry so config never goes stale
 * (no duplicate blocks, no leftovers from deleted apps).
 */
async function syncTorrc(apps = []) {
  await ensureTorFilesystem();

  const lines = [
    `DataDirectory ${config.TOR_DIR}`,
    `ControlPort ${config.TOR_CONTROL_PORT}`,
    `SocksPort ${config.TOR_SOCKS_PORT}`,
    "CookieAuthentication 1",
    "AvoidDiskWrites 1",
    "Log notice stdout"
  ];

  for (const app of apps) {
    const ports = Array.isArray(app.ports) ? app.ports : [];
    if (app.name && ports.length) {
      const hsDir = path.join(config.TOR_HS_DIR, app.name);
      await fs.ensureDir(hsDir);
      try {
        await fs.chmod(hsDir, 0o700);
      } catch {}
    }
    lines.push(...hiddenServiceLines(app));
  }

  await fs.writeFile(config.TORRC, lines.join("\n") + "\n");
  return config.TORRC;
}

/* =========================
   TOR PROCESS
========================= */

async function isTorRunning() {
  return new Promise(resolve => {
    const socket = net.createConnection(config.TOR_CONTROL_PORT, "127.0.0.1");
    socket.once("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function ensureTorStarted() {
  if (await isTorRunning()) return false;

  if (!(await fs.pathExists(config.TORRC))) await syncTorrc([]);

  const bin = requireTorBin();
  let spawnError = null;

  const child = spawn(bin, ["-f", config.TORRC], {
    cwd: config.TOR_DIR,
    detached: true,
    stdio: "ignore"
  });
  child.once("error", err => {
    spawnError = err;
  });
  child.unref();

  for (let i = 0; i < 30; i++) {
    if (spawnError) {
      throw new Error(`Failed to run Tor (${bin}): ${spawnError.message}`);
    }
    if (await isTorRunning()) return true;
    await sleep(1000);
  }

  throw new Error(
    `Tor did not open control port ${config.TOR_CONTROL_PORT}. ` +
      `If another Tor instance owns that port, set STACKEDGE_TOR_CONTROL_PORT.`
  );
}

/* =========================
   CONTROL PORT SELECTION
========================= */

async function canAuthenticate() {
  try {
    await torControl("GETINFO version", { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function readControlState() {
  try {
    const value = parseInt(fs.readFileSync(CONTROL_STATE, "utf8").trim(), 10);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function writeControlState(port) {
  try {
    fs.writeFileSync(CONTROL_STATE, String(port));
  } catch {}
}

/**
 * Pick a control port that is actually ours.
 * A server may already run a system Tor daemon on 9051 - in that case
 * stackedge silently moves to a free port instead of failing.
 */
async function pickControlPort() {
  await ensureTorFilesystem();
  const wanted = config.TOR_CONTROL_PORT;
  const saved = readControlState();
  const explicit = process.env.STACKEDGE_TOR_CONTROL_PORT || process.env.TOR_CONTROL_PORT;

  const candidates = [];
  if (!explicit && saved && saved !== wanted) candidates.push(saved);
  candidates.push(wanted);

  for (const port of candidates) {
    config.TOR_CONTROL_PORT = port;
    if (await canAuthenticate()) {
      writeControlState(port);
      return port;
    }
  }

  if (!(await isTorRunning())) {
    config.TOR_CONTROL_PORT = wanted;
    writeControlState(wanted);
    return wanted;
  }

  const free = await getFreePort();
  config.TOR_CONTROL_PORT = free;
  writeControlState(free);
  console.log(
    `Note: control port ${wanted} belongs to another Tor instance - using port ${free} instead.`
  );
  return free;
}

/* =========================
   TOR CONTROL
========================= */

async function torControl(cmd, { timeout = 10000 } = {}) {
  const cookiePath = path.join(config.TOR_DIR, "control_auth_cookie");

  let cookieHex;
  try {
    cookieHex = (await fs.readFile(cookiePath)).toString("hex");
  } catch (err) {
    throw new Error(`Cannot read Tor control cookie (${cookiePath}): ${err.message}`);
  }

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(config.TOR_CONTROL_PORT, "127.0.0.1");
    let buffer = "";
    let phase = 0; // 0 = waiting for AUTHENTICATE reply, 1 = waiting for command reply
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };

    const timer = setTimeout(
      () => finish(new Error(`Tor control command timed out: ${cmd}`)),
      timeout
    );

    socket.on("error", err => {
      finish(
        new Error(
          `Cannot reach Tor control port ${config.TOR_CONTROL_PORT}: ${err.message}`
        )
      );
    });

    socket.on("close", () => {
      finish(new Error(`Tor closed the control connection while running: ${cmd}`));
    });

    socket.on("data", chunk => {
      buffer += chunk.toString();
      if (!buffer.endsWith("\n")) return;

      const lines = buffer.trim().split(/\r?\n/);
      const last = lines[lines.length - 1] || "";

      // Final line of a reply: "250 OK" / "515 ..."; "250-entry" keeps going.
      if (!/^(25\d|5\d\d)( |$)/.test(last)) return;

      if (/^5\d\d/.test(last)) {
        let message = `Tor control error: ${last}`;
        if (/^51[45]/.test(last)) {
          message += ` (port ${config.TOR_CONTROL_PORT} may belong to another Tor instance - set STACKEDGE_TOR_CONTROL_PORT)`;
        }
        return finish(new Error(message));
      }

      const reply = buffer;
      buffer = "";
      if (phase === 0) {
        phase = 1;
        socket.write(cmd + "\r\n");
      } else {
        finish(null, reply);
      }
    });

    socket.on("connect", () => {
      socket.write(`AUTHENTICATE ${cookieHex}\r\n`);
    });
  });
}

async function waitForTorBootstrap(timeout = config.BOOTSTRAP_TIMEOUT) {
  const start = Date.now();
  let lastError = null;

  for (;;) {
    try {
      const res = await torControl("GETINFO status/bootstrap-phase");
      if (res.includes("PROGRESS=100")) return;
      lastError = null;
    } catch (err) {
      lastError = err;
    }

    if (Date.now() - start > timeout) {
      throw new Error(
        lastError
          ? `Tor bootstrap failed: ${lastError.message}`
          : `Tor bootstrap timed out after ${Math.round(timeout / 1000)}s`
      );
    }
    await sleep(1000);
  }
}

async function reloadTor() {
  try {
    await torControl("SIGNAL RELOAD");
  } catch (err) {
    throw err;
  }
}

/**
 * Make the registry the source of truth for torrc, start Tor if needed,
 * apply the config and wait until Tor can carry traffic.
 */
async function publishApps(apps = []) {
  await pickControlPort();
  await syncTorrc(apps);
  await ensureTorStarted();
  await reloadTor();
  await cleanupOrphans(apps);
  await waitForTorBootstrap();
}

/* =========================
   HIDDEN SERVICES
========================= */

function readOnion(name) {
  try {
    const file = path.join(config.TOR_HS_DIR, name, "hostname");
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, "utf8").trim() || null;
  } catch {
    return null;
  }
}

async function waitForHostname(name, timeout = 60000) {
  const file = path.join(config.TOR_HS_DIR, name, "hostname");
  const start = Date.now();

  while (Date.now() - start < timeout) {
    if (await fs.pathExists(file)) {
      const onion = (await fs.readFile(file, "utf8")).trim();
      if (onion) return onion;
    }
    await sleep(500);
  }
  throw new Error(`Onion hostname for '${name}' was not created`);
}

async function cleanupOrphans(apps = []) {
  const active = new Set(apps.map(a => a.name));
  if (!(await fs.pathExists(config.TOR_HS_DIR))) return;

  for (const dir of await fs.readdir(config.TOR_HS_DIR)) {
    if (!active.has(dir)) {
      await fs.remove(path.join(config.TOR_HS_DIR, dir));
    }
  }
}

module.exports = {
  ensureTorFilesystem,
  syncTorrc,
  isTorRunning,
  ensureTorStarted,
  torControl,
  waitForTorBootstrap,
  reloadTor,
  publishApps,
  readOnion,
  waitForHostname,
  cleanupOrphans
};
