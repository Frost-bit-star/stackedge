const fs = require("fs-extra");
const path = require("path");
const { spawn } = require("child_process");

const TOR_BIN = "/data/data/com.termux/files/usr/bin/tor"; // Termux Tor binary
const TOR_DIR = path.join(process.env.HOME, ".tor");
const TORRC = path.join(TOR_DIR, "torrc");

async function ensureTorConfig() {
  await fs.ensureDir(TOR_DIR);
  const torrc = `
DataDirectory ${TOR_DIR}
ControlPort 9051
CookieAuthentication 1
AvoidDiskWrites 1
  `.trim();
  await fs.writeFile(TORRC, torrc);
}

async function startTor(appName, appPort) {
  await ensureTorConfig();

  // Hidden service for this app
  const hiddenServiceDir = path.join(TOR_DIR, `hidden_service_${appName}`);
  await fs.ensureDir(hiddenServiceDir);

  // Append hidden service config to torrc
  const hiddenServiceConfig = `
HiddenServiceDir ${hiddenServiceDir}
HiddenServicePort ${appPort} 127.0.0.1:${appPort}
  `.trim();
  await fs.appendFile(TORRC, "\n" + hiddenServiceConfig);

  return new Promise((resolve, reject) => {
    const tor = spawn(TOR_BIN, ["-f", TORRC], {
      cwd: TOR_DIR,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"]
    });

    tor.stdout.on("data", (data) => {
      const text = data.toString();
      process.stdout.write(text);

      if (text.includes("Bootstrapped 100%")) {
        // Tor fully online
        resolve(hiddenServiceDir);
      }
    });

    tor.stderr.on("data", (data) => process.stderr.write(data.toString()));
    tor.on("error", (err) => reject(err));

    tor.unref();
  });
}

module.exports = { ensureTorConfig, startTor, TOR_DIR, TORRC };
