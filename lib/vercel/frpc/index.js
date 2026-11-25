const {
  loadDeployment,
  loadCredentials,
  resolveStackedgeTarget
} = require("../config");
const { FrpcClient } = require("./client");

function loadTunnelConfig(name, { target: override } = {}) {
  const deployment = loadDeployment(name);
  const credentials = loadCredentials(name);
  if (!deployment || !credentials) throw new Error(`No Vercel deployment for '${name}'`);
  if (!deployment.url || !deployment.serviceId) {
    throw new Error(`Deployment '${name}' is not ready. Run 'stackedge vercel deploy ${name} <url>' first.`);
  }

  const resolved = resolveStackedgeTarget(name);
  const target = override || resolved.target;

  return {
    url: deployment.url,
    serviceId: deployment.serviceId,
    token: credentials.token,
    application: name,
    target,
    securityPort: resolved.securityPort,
    backendPort: resolved.backendPort,
    protected: resolved.protected
  };
}

module.exports = { FrpcClient, loadTunnelConfig };
