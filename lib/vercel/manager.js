const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const {
  LOG_DIR,
  VERCEL_LOG,
  VERCEL_DIR,
  connectionFile,
  readJson,
  saveConnection,
  loadDeployment,
  loadCredentials
} = require("./config");
const { FrpcClient, loadTunnelConfig } = require("./frpc");
const { loadApps } = require("../registry");
const { normalizeProviders, usesVercel } = require("../hosting");

const CLI = path.resolve(__dirname, "..", "..", "bin", "stackedge.js");

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function killTree(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (err) {
    if (err.code === "ESRCH") return false;
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function updateConnection(name, patch) {
  const previous = readJson(connectionFile(name)) || { name };
  saveConnection(name, { ...previous, ...patch });
}

function logFile(name) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  return path.join(LOG_DIR, `vercel-${name}.log`);
}

function startTunnel(name) {
  const config = loadTunnelConfig(name);
  const file = logFile(name);
  const fd = fs.openSync(file, "a");

  fs.writeSync(
    fd,
    `\n--- [${new Date().toISOString()}] stackedge vercel connect ${name}\n`
  );

  const child = spawn(process.execPath, [CLI, "__frpc", name], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", fd, fd],
    detached: true
  });

  fs.closeSync(fd);

  updateConnection(name, {
    name,
    serviceId: config.serviceId,
    target: config.target,
    pid: child.pid,
    connected: false,
    manualDisconnect: false,
    lastError: null
  });

  child.unref();
  return child.pid;
}

function stopTunnel(name) {
  const connection = readJson(connectionFile(name)) || {};
  const pid = connection.pid;
  if (pid && isPidAlive(pid)) killTree(pid, "SIGTERM");
  updateConnection(name, {
    connected: false,
    pid: null,
    manualDisconnect: true,
    lastError: "manual disconnect"
  });
  return Boolean(pid && isPidAlive(pid));
}

function runTunnel(name) {
  const config = loadTunnelConfig(name);
  const client = new FrpcClient(config);

  const log = line => {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(VERCEL_LOG, `${new Date().toISOString()} ${name}: ${line}\n`);
  };

  client.on("connected", () => {
    const current = readJson(connectionFile(name)) || {};
    if (current.manualDisconnect) {
      client.stop();
      process.exit(0);
      return;
    }
    updateConnection(name, {
      name,
      serviceId: config.serviceId,
      target: config.target,
      connected: true,
      lastConnectedAt: new Date().toISOString(),
      lastError: null
    });
    log(`connected to ${config.url} -> ${config.target}`);
  });

  client.on("disconnected", () => {
    updateConnection(name, { connected: false, lastError: "disconnected" });
    log("disconnected - retrying with backoff");
  });

  client.on("error", err => {
    updateConnection(name, { connected: false, lastError: err.message });
    log(`error: ${err.message}`);
  });

  client.on("request", info => log(`${info.status} ${info.requestId}`));

  const shutdown = () => {
    client.stop();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  client.start();
  return client;
}

function reconnectTunnel(name) {
  stopTunnel(name);
  return startTunnel(name);
}

function allTunnels() {
  if (!fs.existsSync(VERCEL_DIR)) return [];
  return fs.readdirSync(VERCEL_DIR).filter(app => fs.existsSync(connectionFile(app)));
}

async function resurrectTunnels() {
  const started = [];
  const apps = await loadApps();
  for (const app of allTunnels()) {
    try {
      const record = apps.find(item => item.name === app);
      if (record && !usesVercel(normalizeProviders(record))) continue;
      const connection = readJson(connectionFile(app)) || {};
      const deployment = loadDeployment(app);
      const credentials = loadCredentials(app);
      if (!deployment || !credentials || !deployment.url) continue;
      if (connection.manualDisconnect) continue;
      started.push({ app, pid: startTunnel(app) });
    } catch (err) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      fs.appendFileSync(VERCEL_LOG, `${new Date().toISOString()} ${app}: resurrect failed: ${err.message}\n`);
    }
  }
  return started;
}

module.exports = {
  isPidAlive,
  startTunnel,
  stopTunnel,
  runTunnel,
  reconnectTunnel,
  resurrectTunnels,
  updateConnection
};
