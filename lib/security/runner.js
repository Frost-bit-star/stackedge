const cluster = require("cluster");
const { createProxy } = require("./proxy");
const { createLimiter } = require("./ratelimit");
const { loadSecurity, resolveWorkers } = require("./config");
const { loadApps } = require("../registry");

async function proxyOptions() {
  const [appName, listenPort, targetPort, targetHost] = process.argv.slice(2);
  if (!appName || !listenPort || !targetPort) {
    console.error("Usage: runner.js <app> <listen-port> <target-port> [target-host]");
    process.exit(1);
  }

  const security = await loadSecurity();
  const apps = await loadApps();

  return {
    appName,
    listenPort: Number(listenPort),
    targetPort: Number(targetPort),
    targetHost: targetHost || "127.0.0.1",
    security,
    allowedHosts: [...(security.allowedHosts || []), ...apps.map(a => a.onion).filter(Boolean)],
    workers: resolveWorkers(security)
  };
}

function startWorker(options, rateCheck, connectionLimit) {
  const settings = options.security;
  let server;

  try {
    server = createProxy({
      appName: options.appName,
      targetPort: options.targetPort,
      targetHost: options.targetHost,
      security: settings,
      allowedHosts: options.allowedHosts,
      rateCheck,
      connectionLimit
    });
  } catch (err) {
    console.error(`TLS setup failed, falling back to HTTP: ${err.message}`);
    server = createProxy({
      appName: options.appName,
      targetPort: options.targetPort,
      targetHost: options.targetHost,
      security: { ...settings, tls: { ...settings.tls, enabled: false } },
      allowedHosts: options.allowedHosts,
      rateCheck,
      connectionLimit
    });
  }

  server.on("error", err => {
    console.error(`Security proxy error: ${err.message}`);
    process.exit(1);
  });

  server.listen(options.listenPort, "127.0.0.1");

  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

function workerRateCheck(settings) {
  const local = createLimiter(settings);
  const pending = new Map();
  let nextId = 0;

  process.on("message", msg => {
    if (!msg || msg.type !== "rateResult") return;
    const resolve = pending.get(msg.id);
    if (!resolve) return;
    clearTimeout(resolve.timer);
    pending.delete(msg.id);
    resolve.done(Boolean(msg.allowed));
  });

  return key =>
    new Promise(resolve => {
      if (!process.send || !process.connected) {
        resolve(local(key));
        return;
      }
      const id = ++nextId;
      const entry = { done: resolve };
      entry.timer = setTimeout(() => {
        pending.delete(id);
        resolve(local(key));
      }, 2000);
      pending.set(id, entry);
      process.send({ type: "rateCheck", id, key });
    });
}

async function main() {
  const options = await proxyOptions();

  if (cluster.isPrimary && options.workers > 1) {
    const limiter = createLimiter(options.security);
    let shuttingDown = false;
    let announced = false;

    cluster.setupPrimary({ args: process.argv.slice(2) });
    cluster.on("message", (worker, msg) => {
      if (!msg || msg.type !== "rateCheck") return;
      try {
        worker.send({ type: "rateResult", id: msg.id, allowed: limiter(msg.key) });
      } catch {}
    });

    cluster.on("online", () => {
      if (announced) return;
      announced = true;
      console.log(
        `Security proxy for '${options.appName}' listening on 127.0.0.1:${options.listenPort} -> ` +
          `${options.targetHost}:${options.targetPort} (${options.workers} CPU workers)`
      );
    });

    cluster.on("exit", () => {
      if (!shuttingDown) cluster.fork();
    });

    for (let i = 0; i < options.workers; i++) cluster.fork();

    const shutdown = () => {
      shuttingDown = true;
      cluster.disconnect(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    return;
  }

  const rateCheck =
    options.workers > 1 ? workerRateCheck(options.security) : createLimiter(options.security);
  const connectionLimit = Math.max(1, Math.floor(options.security.connectionLimit / options.workers));
  startWorker(options, rateCheck, connectionLimit);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
