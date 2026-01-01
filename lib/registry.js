const fs = require("fs-extra");
const { APPS_FILE } = require("./config");

async function loadApps() {
  if (!(await fs.pathExists(APPS_FILE))) return [];
  return fs.readJson(APPS_FILE);
}

async function saveApps(apps) {
  await fs.ensureDir(APPS_FILE.replace(/\/apps\.json$/, ""));
  await fs.writeJson(APPS_FILE, apps, { spaces: 2 });
}

module.exports = { loadApps, saveApps };
