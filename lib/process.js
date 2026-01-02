const { spawn } = require("child_process");
const { loadApps, saveApps } = require("./registry");

/**
 * Start an application process
 * @param {Object} app
 */
async function startProcess(app) {
  if (!app || !app.command) {
    throw new Error("App command is required to start a process.");
  }

  const child = spawn("sh", ["-c", app.command], {
    cwd: app.cwd || process.cwd(),
    env: { ...process.env, ...app.env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true
  });

  app.pid = child.pid;
  app.appState = "running";

  // Persist state immediately
  const apps = await loadApps();
  const idx = apps.findIndex(a => a.name === app.name);
  if (idx !== -1) {
    apps[idx] = app;
  } else {
    apps.push(app);
  }
  await saveApps(apps);

  // Forward logs
  child.stdout.on("data", data => {
    process.stdout.write(`[${app.name}] ${data}`);
  });

  child.stderr.on("data", data => {
    process.stderr.write(`[${app.name} ERROR] ${data}`);
  });

  child.on("exit", async (code, signal) => {
    const apps = await loadApps();
    const idx = apps.findIndex(a => a.name === app.name);
    if (idx !== -1) {
      apps[idx].appState = "stopped";
      apps[idx].pid = null;
      await saveApps(apps);
    }
    console.log(`${app.name} exited (${signal || code})`);
  });

  child.unref();
}

/**
 * Stop a running application
 * @param {Object} app
 */
async function stopProcess(app) {
  if (!app || !app.pid) return;

  try {
    process.kill(app.pid, "SIGTERM");

    // fallback kill after 3s
    setTimeout(() => {
      try {
        process.kill(app.pid, "SIGKILL");
      } catch {}
    }, 3000);
  } catch (err) {
    console.error(`Failed to stop ${app.name}: ${err.message}`);
  }

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
  stopProcess
};
