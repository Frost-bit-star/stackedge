const { run, runElevated, which, isTermux } = require("../system");
const { resolveTorBin, resetCache } = require("./bin");

function manualInstructions() {
  console.log("  Install Tor manually, then run stackedge again:");
  console.log("    Termux:        pkg install tor");
  console.log("    Debian/Ubuntu: sudo apt install tor");
  console.log("    Fedora/RHEL:   sudo dnf install tor");
  console.log("    Arch:          sudo pacman -S tor");
  console.log("    Alpine:        sudo apk add tor");
  console.log("    macOS:         brew install tor");
}

function detectPackageManager() {
  if (isTermux() && which("pkg")) {
    return {
      name: "pkg",
      install: ["pkg", "install", "-y", "tor"],
      update: ["pkg", "update", "-y"],
      elevate: false
    };
  }

  const table = [
    { probe: "apt-get", install: ["apt-get", "install", "-y", "tor"], update: ["apt-get", "update"], elevate: true },
    { probe: "dnf", install: ["dnf", "install", "-y", "tor"], elevate: true },
    { probe: "yum", install: ["yum", "install", "-y", "tor"], elevate: true },
    { probe: "pacman", install: ["pacman", "-S", "--noconfirm", "tor"], update: ["pacman", "-Sy"], elevate: true },
    { probe: "apk", install: ["apk", "add", "tor"], elevate: true },
    { probe: "zypper", install: ["zypper", "--non-interactive", "install", "tor"], elevate: true },
    { probe: "brew", install: ["brew", "install", "tor"], elevate: false }
  ];

  for (const entry of table) {
    if (which(entry.probe)) return { name: entry.probe, ...entry };
  }
  return null;
}

/**
 * Make sure a usable Tor binary exists, installing it through the system
 * package manager when it does not.
 *
 * @returns {{ok: boolean, installed: boolean, bin: string|null}}
 */
function ensureTorInstalled() {
  const existing = resolveTorBin();
  if (existing) return { ok: true, installed: false, bin: existing };

  const pm = detectPackageManager();
  if (!pm) {
    console.log("✖ Tor is not installed and no supported package manager was found.");
    manualInstructions();
    return { ok: false, installed: false, bin: null };
  }

  console.log(`Tor is not installed - installing it with ${pm.name}...`);
  const cmd = pm.install[0];
  const args = pm.install.slice(1);

  let res = runElevated(cmd, args, { elevate: pm.elevate });
  if (!res.ok && pm.update) {
    console.log(`  refreshing ${pm.name} package lists first...`);
    runElevated(pm.update[0], pm.update.slice(1), { elevate: pm.elevate });
    res = runElevated(cmd, args, { elevate: pm.elevate });
  }

  resetCache();
  const bin = resolveTorBin();

  if (!bin) {
    console.log("✖ Could not install Tor automatically.");
    if (res.needsRoot) {
      console.log(`  root is required: sudo ${cmd} ${args.join(" ")}`);
    } else if (res.stderr) {
      console.log(`  ${res.stderr.split("\n").slice(0, 5).join("\n  ")}`);
    }
    manualInstructions();
    return { ok: false, installed: false, bin: null };
  }

  console.log(`✔ Tor installed: ${bin}`);
  return { ok: true, installed: true, bin };
}

module.exports = { ensureTorInstalled, detectPackageManager, manualInstructions };
