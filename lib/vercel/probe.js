const { loadDeployment, loadCredentials } = require("./config");

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("Probe timed out")), ms));
}

async function probeDeployment(name, { timeoutMs = 15000 } = {}) {
  const deployment = loadDeployment(name);
  const credentials = loadCredentials(name);
  if (!deployment || !credentials) throw new Error(`No Vercel deployment for '${name}'`);
  if (!deployment.url || !deployment.serviceId) {
    throw new Error(`Deployment '${name}' has no URL. Run 'stackedge vercel deploy ${name} <url>' first.`);
  }

  const healthResponse = await Promise.race([
    fetch(new URL("/_health", deployment.url)),
    timeout(timeoutMs)
  ]);
  const health = await healthResponse.json();

  const verifyResponse = await Promise.race([
    fetch(new URL("/_verify", deployment.url), {
      headers: { "x-stackfrp-token": credentials.token }
    }),
    timeout(timeoutMs)
  ]);
  const verification = await verifyResponse.json();

  const pollResponse = await Promise.race([
    fetch(new URL("/_frpc/hello", deployment.url), {
      headers: { "x-stackfrp-token": credentials.token }
    }),
    timeout(timeoutMs)
  ]);
  const pollMessage = await pollResponse.json();
  const poll = {
    status: pollResponse.ok && pollMessage.instanceId ? "polling" : "failed",
    instanceId: pollMessage.instanceId || null
  };

  const after = await Promise.race([
    fetch(new URL("/_health", deployment.url)),
    timeout(timeoutMs)
  ]);
  const afterHealth = await after.json();
  const routing =
    health.mode === "pull" && health.relay === "redis"
      ? "pull-redis"
      : health.mode === "pull"
        ? "pull-memory"
        : health.tunnel === "connected"
          ? "legacy"
          : "legacy";

  return {
    health,
    verification,
    poll,
    afterHealth,
    routing,
    usable:
      health.status === "ok" &&
      verification.status === "verified" &&
      poll.status === "polling" &&
      health.mode === "pull"
  };
}

module.exports = { probeDeployment };
