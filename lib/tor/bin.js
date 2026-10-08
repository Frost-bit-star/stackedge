const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const TERMUX_BIN = "/data/data/com.termux/files/usr/bin/tor";

const COMMON_PATHS = [
  TERMUX_BIN,
  "/usr/bin/tor",
  "/usr/local/bin/tor",
  "/bin/tor",
  "/opt/homebrew/bin/tor",
  "/usr/pkg/bin/tor"
];

let cached = undefined;

function which(cmd) {
  try {
    const out =
      process.platform === "win32"
        ? execFileSync("where", [cmd], { encoding: "utf8" })
        : execFileSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" });
    const found = out
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(Boolean)[0];
    if (found && fs.existsSync(found)) return found;
  } catch {}
  return null;
}

function resolveTorBin() {
  if (cached !== undefined) return cached;

  const candidates = [];
  if (process.env.TOR_BIN) candidates.push(process.env.TOR_BIN);
  if (process.env.PREFIX) candidates.push(path.join(process.env.PREFIX, "bin", "tor"));
  candidates.push(...COMMON_PATHS);

  let found = candidates.find(p => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
  if (!found) found = which("tor");

  cached = found || null;
  return cached;
}

function requireTorBin() {
  const bin = resolveTorBin();
  if (!bin) {
    throw new Error(
      "Tor binary not found.\n" +
        "  Termux: pkg install tor\n" +
        "  Debian/Ubuntu: sudo apt install tor\n" +
        "  Fedora: sudo dnf install tor\n" +
        "  macOS: brew install tor\n" +
        "Or point stackedge at it: export TOR_BIN=/path/to/tor"
    );
  }
  return bin;
}

function resetCache() {
  cached = undefined;
}

module.exports = { resolveTorBin, requireTorBin, resetCache };
