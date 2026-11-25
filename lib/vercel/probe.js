const WebSocket = require("ws");
const { loadDeployment, loadCredentials } = require("./config");
const { register, heartbeat, decodeFrame, encodeJson } = require("./protocol");

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("Probe timed out")), ms));
}

async function probeDeployment(name, { timeoutMs = 15000 } = {}) {
  const deployment = loadDeployment(name);
  const credentials = loadCredentials(name);
  if (!deployment || !credentials) throw new Error(`No Vercel deployment for '${name}'`);
  if (!deployment.url || !deployment.wsUrl) {
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

  const websocket = await Promise.race([
    new Promise((resolve, reject) => {
      const socket = new WebSocket(deployment.wsUrl, { handshakeTimeout: timeoutMs });
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error("WebSocket registration timed out"));
      }, timeoutMs);

      socket.on("open", () => {
        socket.send(encodeJson(register(deployment.serviceId, credentials.token, name)));
      });

      socket.on("message", data => {
        try {
          const frame = decodeFrame(data);
          if (frame.kind !== "json") return;
          if (frame.message.type === "registered") {
            socket.send(encodeJson(heartbeat()));
            clearTimeout(timer);
            socket.close();
            resolve({ status: "registered", serviceId: frame.message.serviceId });
          } else if (frame.message.type === "error") {
            clearTimeout(timer);
            socket.close();
            reject(new Error(frame.message.message || "Registration rejected"));
          }
        } catch (err) {
          clearTimeout(timer);
          socket.terminate();
          reject(err);
        }
      });

      socket.on("error", err => {
        clearTimeout(timer);
        reject(err);
      });
    }),
    timeout(timeoutMs)
  ]);

  const after = await Promise.race([
    fetch(new URL("/_health", deployment.url)),
    timeout(timeoutMs)
  ]);
  const afterHealth = await after.json();
  const routing = afterHealth.tunnel === "connected" ? "same-instance" : "cross-instance";

  return {
    health,
    verification,
    websocket,
    routing,
    usable: health.status === "ok" && verification.status === "verified" && routing === "same-instance"
  };
}

module.exports = { probeDeployment };
