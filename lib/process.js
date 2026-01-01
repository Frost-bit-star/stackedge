const { spawn } = require("child_process");
const { loadApps, saveApps } = require("./registry");

/**
 * Start an app and detect its port dynamically from stdout.
 * @param {Object} app - App object from registry
 * @param {Function} onPortDetected - Optional callback when port is detected
 */
async function startProcess(app, onPortDetected) {
  if (!app || !app.command) {
    throw new Error("App command is required to start a process.");
  }

  // Spawn the app command in Termux or any POSIX shell
  const child = spawn("sh", ["-c", app.command], {
    cwd: app.cwd,
    shell: true,
    stdio: ["pipe", "pipe", "pipe"], // capture stdout/stderr
    detached: true
  });

  app.pid = child.pid;
  app.appState = "starting";

  // Listen for stdout to detect port
  child.stdout.on("data", async (data) => {
    const text = data.toString();
    process.stdout.write(text); // print logs to console

    // Detect port: look for localhost:<port> or 127.0.0.1:<port>
    const match = text.match(/(?:localhost|127\.0\.0\.1):(\d+)/);
    if (match) {
      const port = match[1];
      if (app.port !== port) {
        app.port = port;
        app.appState = "running";

        // Update registry
        const apps = await loadApps();
        const index = apps.findIndex(a => a.name === app.name);
        if (index !== -1) {
          apps[index] = app;
          await saveApps(apps);
        }

        if (onPortDetected) onPortDetected(port);
      }
    }
  });

  // Forward stderr
  child.stderr.on("data", (data) => {
    process.stderr.write(data.toString());
  });

  // Handle app exit
  child.on("exit", async (code) => {
    app.appState = "stopped";
    app.port = null;
    const apps = await loadApps();
    const index = apps.findIndex(a => a.name === app.name);
    if (index !== -1) {
      apps[index] = app;
      await saveApps(apps);
    }
    console.log(`${app.name} exited with code ${code}`);
  });

  // Detach from parent process so it keeps running
  child.unref();
}

/**
 * Stop an app by killing its PID
 * @param {Object} app
 */
function stopProcess(app) {
  if (!app || !app.pid) return;
  try {
    process.kill(app.pid);
    app.appState = "stopped";
    app.pid = null;
  } catch (err) {
    app.appState = "stopped";
    app.pid = null;
    console.error(`Failed to stop ${app.name}:`, err.message);
  }
}

module.exports = { startProcess, stopProcess };
