const fs = require("fs");
const {
  VERCEL_LOG,
  VERCEL_DIR,
  LOG_DIR,
  loadDeployment,
  readJson,
  connectionFile
} = require("../vercel/config");
const { initDeployment, setDeploymentUrl, removeDeployment } = require("../vercel/setup");
const { probeDeployment } = require("../vercel/probe");
const {
  startTunnel,
  stopTunnel,
  runTunnel,
  reconnectTunnel,
  isPidAlive
} = require("../vercel/manager");

function printSetup(name, result) {
  console.log("STACKEDGE VERCEL SETUP");
  console.log(`Project generated: ${result.project}`);
  console.log(`Service ID: ${result.serviceId}`);
  console.log("");
  console.log("config.json is generated with the service ID and token, so no Vercel environment variables are required.");
  console.log("Deploy this directory to Vercel, then run:");
  console.log(`  stackedge vercel deploy ${name} <url>`);
}

async function vercelInit(name, opts = {}) {
  const result = initDeployment(name, opts);
  printSetup(name, result);
  return result;
}

async function vercelDeploy(name, url) {
  const deployment = setDeploymentUrl(name, url);
  console.log(`Deployment URL: ${deployment.url}`);
  console.log(`WebSocket endpoint: ${deployment.wsUrl}`);
  console.log("Verify with: stackedge vercel probe " + name);
  return deployment;
}

async function vercelConnect(name, opts = {}) {
  if (opts.foreground) return runTunnel(name);
  const pid = startTunnel(name);
  console.log(`FRPC for '${name}' started in background (pid ${pid}).`);
  console.log(`Logs: ${require("path").join(LOG_DIR, `vercel-${name}.log`)}`);
  return pid;
}

async function vercelDisconnect(name) {
  stopTunnel(name);
  console.log(`Tunnel for '${name}' disconnected.`);
}

async function vercelReconnect(name) {
  const pid = reconnectTunnel(name);
  console.log(`Tunnel for '${name}' restarted (pid ${pid}).`);
  return pid;
}

async function vercelStatus(name) {
  const apps = name ? [name] : fs.existsSync(VERCEL_DIR) ? fs.readdirSync(VERCEL_DIR) : [];
  if (!apps.length) {
    console.log("No Vercel deployments. Run 'stackedge vercel init <app>' first.");
    return;
  }

  for (const app of apps) {
    const deployment = loadDeployment(app);
    const connection = readJson(connectionFile(app)) || {};
    const pid = connection.pid && isPidAlive(connection.pid) ? ` pid ${connection.pid}` : "";
    console.log(`${app}: ${deployment ? deployment.url || "no URL" : "no deployment"}`);
    console.log(
      `  tunnel: ${connection.connected ? "connected" : "disconnected"}${pid}` +
        (connection.lastError ? ` (${connection.lastError})` : "")
    );
  }
}

async function vercelProbe(name) {
  const result = await probeDeployment(name);
  console.log(`health:       ${result.health.status}`);
  console.log(`verification: ${result.verification.status}`);
  console.log(`websocket:    ${result.websocket.status}`);
  console.log(`routing:      ${result.routing}`);
  console.log(
    result.usable
      ? "Deployment is usable as a reverse proxy."
      : "Deployment is NOT usable as a transparent reverse proxy."
  );
  return result;
}

async function vercelLogs(name, lines = 100) {
  const files = [VERCEL_LOG, require("path").join(LOG_DIR, `vercel-${name}.log`)];
  const rows = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (line.includes(name)) rows.push(line);
    }
  }
  console.log(rows.slice(-lines).join("\n") || `No logs for ${name}`);
}

async function vercelRemove(name) {
  stopTunnel(name);
  removeDeployment(name);
  console.log(`Vercel deployment for '${name}' removed.`);
}

module.exports = {
  vercelInit,
  vercelDeploy,
  vercelConnect,
  vercelDisconnect,
  vercelReconnect,
  vercelStatus,
  vercelProbe,
  vercelLogs,
  vercelRemove,
  printSetup
};
