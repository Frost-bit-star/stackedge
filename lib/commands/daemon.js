const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { run, which, isRoot, isTermux, canSudo, hasSystemd } = require("../system");

const UNIT_NAME = "stackedge.service";
const SYSTEM_UNIT_PATH = `/etc/systemd/system/${UNIT_NAME}`;
const USER_UNIT_DIR = path.join(os.homedir(), ".config", "systemd", "user");
const USER_UNIT_PATH = path.join(USER_UNIT_DIR, UNIT_NAME);

const MARKER_START = "# >>> stackedge auto-resurrect >>>";
const MARKER_END = "# <<< stackedge auto-resurrect <<<";
const CRON_MARKER = "stackedge auto-resurrect";

const NODE = process.execPath;
const SCRIPT = path.resolve(__dirname, "..", "..", "bin", "stackedge.js");

/* =========================
   ENVIRONMENT DETECTION
========================= */

function hasCrontab() {
  if (isTermux()) return false;
  return Boolean(which("crontab"));
}

/* =========================
   BUILD ARTIFACTS
========================= */

function escapeEnv(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function unitContents(user) {
  const home = os.homedir();
  const pathEnv = process.env.PATH || "/usr/local/bin:/usr/bin:/bin";
  const user_ = (os.userInfo && os.userInfo().username) || process.env.USER || "root";

  const env = [
    `Environment="HOME=${escapeEnv(home)}"`,
    `Environment="PATH=${escapeEnv(pathEnv)}"`,
    `Environment="USER=${escapeEnv(user_)}"`,
    `Environment="LOGNAME=${escapeEnv(user_)}"`
  ];
  if (process.env.STACKEDGE_HOME) {
    env.push(`Environment="STACKEDGE_HOME=${escapeEnv(process.env.STACKEDGE_HOME)}"`);
  }

  return [
    "[Unit]",
    "Description=Stackedge - restore hosted apps and onion services after boot",
    "Wants=network-online.target",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=oneshot",
    "RemainAfterExit=yes",
    `WorkingDirectory=${escapeEnv(home)}`,
    ...env,
    `ExecStart=${NODE} ${SCRIPT} resurrect`,
    "TimeoutStartSec=0",
    "",
    "[Install]",
    `WantedBy=${user ? "default.target" : "multi-user.target"}`,
    ""
  ].join("\n");
}

function rcHook() {
  return [
    MARKER_START,
    `"${NODE}" "${SCRIPT}" resurrect >/dev/null 2>&1 &`,
    MARKER_END,
    ""
  ].join("\n");
}

function cronLine() {
  return `@reboot "${NODE}" "${SCRIPT}" resurrect >/dev/null 2>&1  # ${CRON_MARKER}`;
}

/* =========================
   WRITE / REMOVE HELPERS
========================= */

function writeFile(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function privilegedWrite(target, content) {
  if (isRoot()) {
    writeFile(target, content);
    return true;
  }
  if (canSudo()) {
    const res = spawnSync("sudo", ["tee", target], { input: content, encoding: "utf8" });
    return res.status === 0;
  }
  return false;
}

function removeFileElevated(target) {
  try {
    if (!fs.existsSync(target)) return true;
    if (isRoot()) {
      fs.rmSync(target);
      return true;
    }
    if (canSudo()) {
      return spawnSync("sudo", ["rm", "-f", target], { stdio: "ignore" }).status === 0;
    }
    return false;
  } catch {
    return false;
  }
}

function sudoArgs(args) {
  return isRoot() ? args : ["sudo", ...args];
}

function rcFiles() {
  const home = os.homedir();
  const candidates = [".bashrc", ".zshrc", ".profile"].map(f => path.join(home, f));
  const existing = candidates.filter(f => fs.existsSync(f));
  return existing.length ? existing : [path.join(home, ".bashrc")];
}

function stripBlock(text) {
  const lines = text.split("\n");
  const out = [];
  let skipping = false;
  for (const line of lines) {
    if (line.trim() === MARKER_START) {
      skipping = true;
      continue;
    }
    if (line.trim() === MARKER_END) {
      skipping = false;
      continue;
    }
    if (!skipping) out.push(line);
  }
  return out.join("\n");
}

function cronList() {
  const res = run("crontab", ["-l"]);
  return res.ok ? res.stdout : "";
}

function setCrontab(content) {
  const res = spawnSync("crontab", ["-"], { input: content, encoding: "utf8" });
  return res.status === 0;
}

/* =========================
   STATUS HELPERS
========================= */

function systemdStatus(user) {
  const args = user ? ["--user"] : [];
  const enabled = run("systemctl", [...args, "is-enabled", UNIT_NAME]);
  const active = run("systemctl", [...args, "is-active", UNIT_NAME]);
  return {
    exists: fs.existsSync(user ? USER_UNIT_PATH : SYSTEM_UNIT_PATH),
    enabled: enabled.ok ? enabled.stdout : enabled.stdout || "unknown",
    active: active.stdout || "unknown"
  };
}

function installedAnywhere() {
  if (fs.existsSync(SYSTEM_UNIT_PATH) || fs.existsSync(USER_UNIT_PATH)) return true;
  if (rcFiles().some(f => readSafe(f).includes(MARKER_START))) return true;
  if (cronList().includes(CRON_MARKER)) return true;
  return false;
}

function readSafe(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/* =========================
   ACTIONS
========================= */

function installSystemd() {
  const useSystem = isRoot() || canSudo();

  if (useSystem) {
    const content = unitContents(false);
    if (!privilegedWrite(SYSTEM_UNIT_PATH, content)) {
      console.log(`Could not write ${SYSTEM_UNIT_PATH} (no root and no passwordless sudo).`);
      return false;
    }

    let ok = run("systemctl", sudoArgs(["daemon-reload"])).ok;
    ok = run("systemctl", sudoArgs(["enable", UNIT_NAME])).ok && ok;

    if (!ok) {
      console.log("Wrote the unit file but 'systemctl enable' failed.");
      console.log(`  Try: sudo systemctl daemon-reload && sudo systemctl enable ${UNIT_NAME}`);
      return false;
    }

    console.log(`✔ Systemd service installed: ${SYSTEM_UNIT_PATH}`);
    console.log("  Enabled - the server will start your apps on every boot.");
    console.log(`  Check it with: systemctl status ${UNIT_NAME}`);
    return true;
  }

  // No root/sudo: fall back to a per-user service.
  writeFile(USER_UNIT_PATH, unitContents(true));
  const reload = run("systemctl", ["--user", "daemon-reload"]);
  const enable = run("systemctl", ["--user", "enable", UNIT_NAME]);

  if (!reload.ok || !enable.ok) {
    console.log(`Wrote ${USER_UNIT_PATH}, but 'systemctl --user' failed here.`);
    console.log("  Run these once on the server:");
    console.log(`    systemctl --user daemon-reload && systemctl --user enable ${UNIT_NAME}`);
    return false;
  }

  console.log(`✔ User service installed: ${USER_UNIT_PATH}`);

  const linger = run("loginctl", ["enable-linger", os.userInfo().username]);
  if (linger.ok) {
    console.log("  Login linger enabled - apps start on boot without a login session.");
  } else {
    console.log("  Enable linger so it also runs after a reboot:");
    console.log(`    sudo loginctl enable-linger ${os.userInfo().username}`);
  }
  console.log(`  Check it with: systemctl --user status ${UNIT_NAME}`);
  return true;
}

function installCron() {
  const existing = cronList()
    .split("\n")
    .filter(line => !line.includes(CRON_MARKER));
  if (existing.length && existing[existing.length - 1] !== "") existing.push("");
  existing.push(cronLine());

  if (!setCrontab(existing.join("\n").replace(/\n{3,}/g, "\n\n"))) {
    console.log("Could not install the cron @reboot entry.");
    return false;
  }

  console.log("✔ Cron @reboot entry installed.");
  console.log("  Your apps will start again after a server reboot.");
  return true;
}

function installRc() {
  let installed = 0;
  for (const file of rcFiles()) {
    const current = readSafe(file);
    if (current.includes(MARKER_START)) continue;
    const suffix = current && !current.endsWith("\n") ? "\n" : "";
    fs.writeFileSync(file, `${current}${suffix}\n${rcHook()}`);
    installed++;
    console.log(`  hook added to ${file}`);
  }
  console.log(
    installed
      ? "✔ Shell auto-resurrect hook installed (runs when you open a shell)."
      : "✔ Shell auto-resurrect hook already installed."
  );
  return true;
}

function daemonInstall() {
  if (hasSystemd()) return installSystemd();
  if (hasCrontab()) return installCron();
  return installRc();
}

function daemonUninstall() {
  let removed = 0;

  if (fs.existsSync(SYSTEM_UNIT_PATH)) {
    run("systemctl", sudoArgs(["disable", "--now", UNIT_NAME]));
    if (removeFileElevated(SYSTEM_UNIT_PATH)) removed++;
    run("systemctl", sudoArgs(["daemon-reload"]));
  }

  if (fs.existsSync(USER_UNIT_PATH)) {
    run("systemctl", ["--user", "disable", "--now", UNIT_NAME]);
    try {
      fs.rmSync(USER_UNIT_PATH);
      removed++;
    } catch {}
    run("systemctl", ["--user", "daemon-reload"]);
  }

  for (const file of rcFiles()) {
    const current = readSafe(file);
    if (!current.includes(MARKER_START)) continue;
    fs.writeFileSync(file, stripBlock(current));
    removed++;
    console.log(`  hook removed from ${file}`);
  }

  const cron = cronList();
  if (cron.includes(CRON_MARKER)) {
    const kept = cron
      .split("\n")
      .filter(line => !line.includes(CRON_MARKER))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n");
    if (setCrontab(kept)) removed++;
  }

  console.log(
    removed
      ? "✔ Boot integration removed. Your apps and data were left untouched."
      : "Nothing to remove - no boot integration was found."
  );
  return true;
}

function daemonStatus() {
  console.log("Boot integration");

  const system = systemdStatus(false);
  const user = systemdStatus(true);
  const cron = cronList();
  const rcHit = rcFiles().filter(f => readSafe(f).includes(MARKER_START));

  if (system.exists || user.exists) {
    const s = system.exists ? system : user;
    const kind = system.exists ? "systemd (system)" : "systemd (user)";
    console.log(`  method: ${kind}`);
    console.log(`  unit:   ${system.exists ? SYSTEM_UNIT_PATH : USER_UNIT_PATH}`);
    console.log(`  enable: ${s.enabled}`);
    console.log(`  active: ${s.active}`);
  } else if (cron.includes(CRON_MARKER)) {
    console.log("  method: cron @reboot");
    console.log(`  entry:  ${cron.split("\n").find(l => l.includes(CRON_MARKER))}`);
  } else if (rcHit.length) {
    console.log("  method: shell startup hook");
    rcHit.forEach(f => console.log(`  file:   ${f}`));
  } else {
    console.log("  not installed - run 'stackedge daemon install'");
  }
  return true;
}

function daemon(action) {
  switch (action) {
    case "install":
      return daemonInstall();
    case "uninstall":
    case "remove":
      return daemonUninstall();
    case "status":
      return daemonStatus();
    default:
      console.log("Usage: stackedge daemon <install|uninstall|status>");
      return false;
  }
}

module.exports = {
  daemon,
  hasSystemd,
  installedAnywhere
};
