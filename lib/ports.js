const net = require("net");

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Ask the OS for any free port (no fixed range, no 3000/3001/3002 ...).
 */
function getFreePort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const { port } = server.address();
      server.close(err => (err ? reject(err) : resolve(port)));
    });
  });
}

function isPortFree(port, host = "127.0.0.1") {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

function isPortAlive(port, host) {
  const hosts = Array.isArray(host)
    ? host
    : host
      ? [host]
      : ["127.0.0.1", "::1"];

  return new Promise(resolve => {
    if (!hosts.length) return resolve(false);

    let pending = hosts.length;
    let alive = false;

    const settle = () => {
      if (--pending === 0) resolve(alive);
    };

    for (const h of hosts) {
      const socket = net.createConnection({ port, host: h });
      socket.once("connect", () => {
        socket.end();
        alive = true;
        settle();
      });
      socket.once("error", settle);
    }
  });
}

/**
 * Best-effort port detection from a start command, e.g.
 *   "127.0.0.1:8000", "http://localhost:3000", "--port 4000",
 *   "python3 -m http.server 8080", "npm start" with PORT handled elsewhere.
 */
function detectPortInCommand(command) {
  if (!command) return null;

  const patterns = [
    /(?:\d{1,3}\.){3}\d{1,3}:(\d{2,5})/, // 127.0.0.1:8000
    /(?:^|\s)--?port[= ](\d{2,5})/i, // --port 4000 / -p 4000 / --port=4000
    /:(\d{2,5})/, // localhost:3000
    /\s(\d{2,5})(?:\s|$)/ // standalone argument, e.g. http.server 8080
  ];

  for (const re of patterns) {
    const m = command.match(re);
    if (m) {
      const port = Number(m[1]);
      if (port >= 1 && port <= 65535) return port;
    }
  }
  return null;
}

function parsePort(value, label = "port") {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${label}: '${value}' (expected 1-65535)`);
  }
  return port;
}

function primaryPort(app) {
  const ports = Array.isArray(app && app.ports) ? app.ports : [];
  const http = ports.find(p => p.virtual === 80) || ports[0];
  return http ? http.target : null;
}

/**
 * Wait until something accepts connections on the port.
 * Tries every plausible host so IPv4/IPv6-only listeners both work.
 */
async function waitForPort(port, { timeout = 30000, host } = {}) {
  const hosts = [];
  for (const h of [host, "127.0.0.1", "::1"]) {
    if (h && !hosts.includes(h)) hosts.push(h);
  }

  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await isPortAlive(port, hosts)) return;
    await sleep(300);
  }
  throw new Error(`Port ${port} never opened`);
}

module.exports = {
  getFreePort,
  isPortFree,
  isPortAlive,
  detectPortInCommand,
  parsePort,
  primaryPort,
  waitForPort
};
