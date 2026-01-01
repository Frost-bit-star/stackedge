// lib/registry.js
const fs = require("fs-extra");
const path = require("path");
const { APPS_FILE } = require("./config");

// Default fields for each app
const DEFAULT_APP = {
  name: "",
  cwd: "",
  command: "",
  port: null,
  pid: null,
  appState: "starting",
  torState: "pending",
  onion: null,
  autorestart: true
};

/**
 * Load apps from registry
 * @returns {Promise<Array>}
 */
async function loadApps() {
  try {
    if (!(await fs.pathExists(APPS_FILE))) return [];
    const apps = await fs.readJson(APPS_FILE);
    // Ensure all apps have default fields
    return apps.map(a => ({ ...DEFAULT_APP, ...a }));
  } catch (err) {
    console.error("Failed to load apps registry:", err);
    return [];
  }
}

/**
 * Save or update apps in registry
 * Merges by app name to avoid overwriting other apps
 * @param {Array} appsToSave
 */
async function saveApps(appsToSave) {
  try {
    // Ensure directory exists
    await fs.ensureDir(path.dirname(APPS_FILE));

    // Load existing apps
    const existingApps = await loadApps();

    // Merge apps by name
    const merged = [...existingApps.filter(e => !appsToSave.some(a => a.name === e.name)), ...appsToSave];

    // Write JSON to file
    await fs.writeJson(APPS_FILE, merged, { spaces: 2 });
  } catch (err) {
    console.error("Failed to save apps registry:", err);
  }
}

module.exports = { loadApps, saveApps };
