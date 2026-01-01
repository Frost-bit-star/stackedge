const { spawn } = require("child_process");

function startProcess(app) {
  const child = spawn("sh", ["-c", app.command], {
    cwd: app.cwd,
    detached: true,
    stdio: "ignore"
  });
  app.pid = child.pid;
  app.appState = "running";
  child.unref();
}

function stopProcess(app) {
  if (!app.pid) return;
  try {
    process.kill(app.pid);
    app.appState = "stopped";
    app.pid = null;
  } catch {
    app.appState = "stopped";
  }
}

module.exports = { startProcess, stopProcess };
