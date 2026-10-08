const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { loadApps, saveApps } = require("./registry");
const { LOG_DIR } = require("./config");

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function buildEnv(app) {
  const ports = Array.isArray(app.ports) ? app.ports : [];
  const http = ports.find(p => p.virtual === 80) || ports[0];
  const ssl = ports.find(p => p.virtual === 443);

  const env = { ...process.env };
  if (http) env.PORT = String(http.target);
  if (ssl) env.SSL_PORT = String(ssl.target);
  return env;
}

function logFile(name) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  return path.join(LOG_DIR, `${name}.log`);
}

/**
 * Start an application process (detached, logs to ~/.stackedge/logs/<name>.log)
 * @param {Object} app
 */
async function startProcess(app) {
  if (!app || !app.command) {
    throw new Error("App command is required to start a process.");
  }

  const logPath = logFile(app.name);
  let fd = null;
  try {
    fd = fs.openSync(logPath, "a");
    fs.writeSync(
      fd,
      `\n--- [${new Date().toISOString()}] stackedge start: ${app.command}\n`
    );
  } catch {}

  const child = spawn("sh", ["-c", app.command], {
    cwd: app.cwd || process.cwd(),
    env: buildEnv(app),
    stdio: fd !== null ? ["ignore", fd, fd] : "ignore",
    detached: true
  });

  if (fd !== null) {
    try {
      fs.closeSync(fd);
    } catch {}
  }

  app.pid = child.pid;
  app.appState = "running";

  const apps = await loadApps();
  const idx = apps.findIndex(a => a.name === app.name);
  if (idx !== -1) {
    apps[idx] = app;
  } else {
    apps.push(app);
  }
  await saveApps(apps);

  child.on("exit", async (code, signal) => {
    const current = await loadApps();
    const record = current.find(a => a.name === app.name);
    if (record && record.pid === child.pid) {
      record.appState = "stopped";
      record.pid = null;
      await saveApps(current);
    }
    console.log(`${app.name} exited (${signal || code})`);
  });

  child.unref();
}

function killTree(pid, signal) {
  // The process was spawned detached, so it leads its own process group.
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

/**
 * Stop a running application (kills the whole process group)
 * @param {Object} app
 */
async function stopProcess(app) {
  if (!app || !app.pid) return;

  const pid = app.pid;
  killTree(pid, "SIGTERM");

  setTimeout(() => {
    if (isPidAlive(pid)) killTree(pid, "SIGKILL");
  }, 3000).unref();

  const apps = await loadApps();
  const idx = apps.findIndex(a => a.name === app.name);
  if (idx !== -1) {
    apps[idx].appState = "stopped";
    apps[idx].pid = null;
    await saveApps(apps);
  }
}

module.exports = {
  startProcess,
  stopProcess,
  isPidAlive,
  buildEnv,
  logFile
};
