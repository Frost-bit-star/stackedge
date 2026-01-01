const { spawn } = require("child_process");
const { loadApps, saveApps } = require("./registry");

/**
 * Start an app and detect its port dynamically from stdout.
 * @param {Object} app - App object from registry
 * @param {Function} onPortDetected - Optional callback when port is detected
 */
function startProcess(app, onPortDetected) {
  // Spawn the app command in Termux
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
    process.stdout.write(text); // print logs

    // Detect port: look for localhost:<port> or 127.0.0.1:<port>
    const match = text.match(/(?:localhost|127\.0\.0\.1):(\d+)/);
    if (match) {
      const port = match[1];
      if (app.port !== port) {
        app.port = port;
        app.appState = "running";

        // Save updated app info
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

  child.unref();
}

/**
 * Stop an app by killing its PID
 * @param {Object} app
 */
function stopProcess(app) {
  if (!app.pid) return;
  try {
    process.kill(app.pid);
    app.appState = "stopped";
    app.pid = null;
  } catch {
    app.appState = "stopped";
    app.pid = null;
  }
}

module.exports = { startProcess, stopProcess };
