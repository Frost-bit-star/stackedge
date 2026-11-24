const { createProxy } = require("./proxy");
const { loadSecurity } = require("./config");
const { loadApps } = require("../registry");

async function main() {
  const [appName, listenPort, targetPort, targetHost] = process.argv.slice(2);
  if (!appName || !listenPort || !targetPort) {
    console.error("Usage: runner.js <app> <listen-port> <target-port> [target-host]");
    process.exit(1);
  }

  const security = await loadSecurity();
  const apps = await loadApps();
  const app = apps.find(a => a.name === appName);
  const allowedHosts = [
    ...(security.allowedHosts || []),
    ...apps.map(a => a.onion).filter(Boolean)
  ];

  const options = {
    appName,
    targetPort: Number(targetPort),
    targetHost: targetHost || "127.0.0.1",
    security,
    allowedHosts
  };

  let server;
  try {
    server = createProxy(options);
  } catch (err) {
    console.error(`TLS setup failed, falling back to HTTP: ${err.message}`);
    server = createProxy({ ...options, security: { ...security, tls: { ...security.tls, enabled: false } } });
  }

  server.on("error", err => {
    console.error(`Security proxy error: ${err.message}`);
    process.exit(1);
  });

  server.listen(Number(listenPort), "127.0.0.1", () => {
    console.log(
      `Security proxy for '${appName}' listening on 127.0.0.1:${listenPort} -> ` +
        `${options.targetHost}:${options.targetPort}`
    );
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
