const { spawnSync } = require("child_process");

function run(cmd, args, opts = {}) {
  try {
    const res = spawnSync(cmd, args, { encoding: "utf8", ...opts });
    return {
      ok: !res.error && res.status === 0,
      status: res.status,
      stdout: (res.stdout || "").trim(),
      stderr: (res.stderr || "").trim(),
      error: res.error,
      elevated: false
    };
  } catch (err) {
    return { ok: false, status: null, stdout: "", stderr: err.message, error: err, elevated: false };
  }
}

function which(cmd) {
  try {
    const out = spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" });
    const found = (out.stdout || "").trim().split("\n")[0];
    return found || null;
  } catch {
    return null;
  }
}

function isRoot() {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

function isTermux() {
  return Boolean(process.env.PREFIX && process.env.PREFIX.includes("com.termux"));
}

function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function canSudo() {
  return run("sudo", ["-n", "true"]).ok;
}

function hasSystemd() {
  try {
    return require("fs").existsSync("/run/systemd/system");
  } catch {
    return false;
  }
}

/**
 * Run a command that may need root privileges.
 * Never hangs waiting for a password: only prompts when we have a real TTY.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {Object} opts - { elevate: bool, ...spawnSync options }
 */
function runElevated(cmd, args, opts = {}) {
  const { elevate = true, ...spawnOpts } = opts;

  if (isRoot() || !elevate) return run(cmd, args, spawnOpts);
  if (canSudo()) return { ...run("sudo", ["-n", cmd, ...args], spawnOpts), elevated: true };
  if (isInteractive()) {
    return { ...run("sudo", [cmd, ...args], { ...spawnOpts, stdio: "inherit" }), elevated: true };
  }
  return {
    ok: false,
    status: null,
    stdout: "",
    stderr: `root is required to run: ${cmd} ${args.join(" ")}`,
    error: null,
    elevated: true,
    needsRoot: true
  };
}

module.exports = {
  run,
  runElevated,
  which,
  isRoot,
  isTermux,
  isInteractive,
  canSudo,
  hasSystemd
};
