const fs = require("fs");
const path = require("path");
const {
  appDir,
  deploymentFile,
  saveDeployment,
  saveCredentials,
  saveConnection,
  loadDeployment,
  writeJson
} = require("./config");
const { generateServiceId, generateToken } = require("./auth");

const TEMPLATE_DIR = path.resolve(__dirname, "template");

function initDeployment(name, { force = false, cwd = null } = {}) {
  if (!name || !/^[a-zA-Z0-9._-]+$/.test(name)) {
    throw new Error("App name may only contain letters, numbers, dot, underscore and dash");
  }

  const dir = appDir(name);
  if (fs.existsSync(dir) && !force) {
    throw new Error(`Vercel deployment for '${name}' already exists at ${dir} (use --force to replace)`);
  }

  const exportDir = cwd ? path.join(cwd, "stackedge-vercel") : null;
  if (exportDir && fs.existsSync(exportDir) && !force) {
    throw new Error(`Vercel project already exists at ${exportDir} (use --force to replace)`);
  }

  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const serviceId = generateServiceId();
  const token = generateToken();

  saveDeployment(name, {
    name,
    serviceId,
    protocol: 1,
    url: null,
    application: name,
    generatedAt: new Date().toISOString()
  });
  saveCredentials(name, { token });
  saveConnection(name, {
    name,
    serviceId,
    connected: false,
    lastConnectedAt: null,
    lastError: null
  });

  const project = path.join(dir, "project");
  fs.cpSync(TEMPLATE_DIR, project, { recursive: true });
  writeJson(
    path.join(project, "config.json"),
    {
      serviceId,
      token,
      application: name,
      protocol: 1,
      maxBodySize: 16 * 1024 * 1024
    },
    0o600
  );

  if (exportDir) {
    fs.rmSync(exportDir, { recursive: true, force: true });
    fs.cpSync(project, exportDir, { recursive: true });
  }

  return { dir, project, exportDir, serviceId };
}

function setDeploymentUrl(name, url) {
  const deployment = loadDeployment(name);
  if (!deployment) throw new Error(`No Vercel deployment for '${name}'`);

  const value = new URL(url);
  if (!["http:", "https:"].includes(value.protocol)) throw new Error("Deployment URL must be http(s)");

  deployment.url = value.toString().replace(/\/$/, "");
  writeJson(deploymentFile(name), deployment);
  return deployment;
}

function removeDeployment(name) {
  const dir = appDir(name);
  if (!fs.existsSync(dir)) throw new Error(`No Vercel deployment for '${name}'`);
  fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = { initDeployment, setDeploymentUrl, removeDeployment };
