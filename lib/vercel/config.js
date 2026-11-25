const fs = require("fs");
const path = require("path");
const { BASE_DIR, APPS_FILE, LOG_DIR, APP_HOST } = require("../config");

const VERCEL_DIR = path.join(BASE_DIR, "vercel");
const VERCEL_LOG = path.join(LOG_DIR, "vercel.log");

function appDir(name) {
  return path.join(VERCEL_DIR, name);
}

function deploymentFile(name) {
  return path.join(appDir(name), "deployment.json");
}

function credentialsFile(name) {
  return path.join(appDir(name), "credentials.json");
}

function connectionFile(name) {
  return path.join(appDir(name), "connection.json");
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode });
  try {
    fs.chmodSync(file, mode);
  } catch {}
}

function loadDeployment(name) {
  return readJson(deploymentFile(name));
}

function loadCredentials(name) {
  return readJson(credentialsFile(name));
}

function saveDeployment(name, value) {
  writeJson(deploymentFile(name), value);
}

function saveCredentials(name, value) {
  writeJson(credentialsFile(name), value, 0o600);
}

function saveConnection(name, value) {
  writeJson(connectionFile(name), value);
}

function resolveStackedgeTarget(name) {
  const apps = readJson(APPS_FILE);
  if (!Array.isArray(apps)) {
    throw new Error(`Stackedge registry not found: ${APPS_FILE}`);
  }

  const app = apps.find(a => a.name === name);
  if (!app) throw new Error(`App '${name}' is not in ${APPS_FILE}`);

  const http = Array.isArray(app.ports) ? app.ports.find(p => p.virtual === 80) : null;
  const backendPort = http ? http.target : null;
  const securityPort = app.securityPort || null;

  if (!securityPort && !backendPort) {
    throw new Error(`App '${name}' has no listening port in the Stackedge registry`);
  }

  const port = securityPort || backendPort;
  return {
    app,
    port,
    target: `http://${APP_HOST}:${port}`,
    securityPort,
    backendPort,
    protected: Boolean(securityPort)
  };
}

function log(line) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(VERCEL_LOG, `${new Date().toISOString()} ${line}\n`);
}

module.exports = {
  BASE_DIR,
  APPS_FILE,
  LOG_DIR,
  VERCEL_DIR,
  VERCEL_LOG,
  appDir,
  deploymentFile,
  credentialsFile,
  connectionFile,
  readJson,
  writeJson,
  loadDeployment,
  loadCredentials,
  saveDeployment,
  saveCredentials,
  saveConnection,
  resolveStackedgeTarget,
  log
};
