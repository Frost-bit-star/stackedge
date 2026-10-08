const os = require("os");
const path = require("path");

const HOME = process.env.HOME || os.homedir() || "";
const BASE_DIR = process.env.STACKEDGE_HOME || path.join(HOME, ".stackedge");

function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

module.exports = {
  HOME,
  BASE_DIR,
  APPS_FILE: path.join(BASE_DIR, "apps.json"),
  LOG_DIR: path.join(BASE_DIR, "logs"),
  TOR_DIR: path.join(BASE_DIR, "tor"),
  TORRC: path.join(BASE_DIR, "tor", "torrc"),
  TOR_HS_DIR: path.join(BASE_DIR, "tor", "hidden"),

  // Tor control port. Override when another Tor already owns the default one.
  TOR_CONTROL_PORT: int(
    process.env.STACKEDGE_TOR_CONTROL_PORT,
    int(process.env.TOR_CONTROL_PORT, 9051)
  ),

  // 0 disables the SOCKS listener (avoids clashing with a system Tor daemon).
  TOR_SOCKS_PORT: int(process.env.STACKEDGE_TOR_SOCKS_PORT, 0),

  // Address stackedge forwards onion traffic to (per-app override: --host).
  APP_HOST: process.env.STACKEDGE_APP_HOST || "127.0.0.1",

  // How long to wait for Tor to bootstrap before giving up (ms).
  BOOTSTRAP_TIMEOUT: int(process.env.STACKEDGE_BOOTSTRAP_TIMEOUT, 180000)
};
