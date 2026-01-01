const fs = require("fs-extra");
const { spawn } = require("child_process");
const { TORRC, TOR_DIR } = require("../config");

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

function startTor() {
  return spawn("tor", ["-f", TORRC], {
    detached: true,
    stdio: "ignore"
  });
}

module.exports = { ensureTorConfig, startTor };
