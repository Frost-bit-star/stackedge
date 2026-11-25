const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "stackedge-vercel-"));
process.env.STACKEDGE_HOME = root;
fs.mkdirSync(root, { recursive: true });

const { initDeployment, setDeploymentUrl } = require("../lib/vercel/setup");
const { loadCredentials, loadDeployment } = require("../lib/vercel/config");
const { FrpcClient, loadTunnelConfig } = require("../lib/vercel/frpc");
const { createGateway } = require("../lib/vercel/template/lib/frps/server");
const { startTunnel, stopTunnel } = require("../lib/vercel/manager");

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function waitFor(emitter, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeoutMs);
    emitter.once(event, (...args) => {
      clearTimeout(timer);
      resolve(args);
    });
  });
}

test("vercel init writes a deployable project into the app root", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "stackedge-vercel-root-"));
  const generated = initDeployment("exported", { cwd });
  assert.equal(generated.exportDir, path.join(cwd, "stackedge-vercel"));
  assert.ok(fs.existsSync(path.join(generated.exportDir, "config.json")));
  assert.ok(fs.existsSync(path.join(generated.exportDir, "api", "gateway.js")));
});

test("stackedge FRPC forwards through the generated FRPS gateway", async t => {
  const backend = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json", "x-security-proxy": "yes" });
      res.end(
        JSON.stringify({
          path: req.url,
          host: req.headers.host,
          original: req.headers["x-original-host"] || null,
          marker: req.headers["x-stackedge-vercel"] || null,
          size: Buffer.concat(chunks).length
        })
      );
    });
  });
  const backendPort = await listen(backend);

  fs.writeFileSync(
    path.join(root, "apps.json"),
    JSON.stringify([
      {
        name: "demo",
        ports: [{ virtual: 80, target: backendPort }],
        securityPort: backendPort
      }
    ])
  );

  const generated = initDeployment("demo");
  const credentials = loadCredentials("demo");
  const generatedConfig = JSON.parse(
    fs.readFileSync(path.join(generated.project, "config.json"), "utf8")
  );
  assert.equal(generatedConfig.serviceId, generated.serviceId);
  assert.equal(generatedConfig.token, credentials.token);
  assert.equal(generatedConfig.application, "demo");
  assert.ok(fs.existsSync(path.join(generated.project, "errorpagetempdesign.html")));
  assert.ok(fs.existsSync(path.join(generated.project, "lib", "error-page.js")));

  const gateway = createGateway({
    serviceId: generated.serviceId,
    token: credentials.token,
    application: "demo"
  });
  const gatewayPort = await listen(gateway.server);
  setDeploymentUrl("demo", `http://127.0.0.1:${gatewayPort}`);

  const config = loadTunnelConfig("demo");
  assert.equal(config.protected, true);
  assert.equal(config.target, `http://127.0.0.1:${backendPort}`);

  const client = new FrpcClient({ ...config, reconnectDelayMs: 100 });
  t.after(async () => {
    client.stop();
    await close(gateway.server);
    await gateway.close();
    await close(backend);
  });

  const connected = waitFor(client, "connected");
  client.start();
  await connected;

  const health = await fetch(`http://127.0.0.1:${gatewayPort}/_health`).then(r => r.json());
  assert.equal(health.tunnel, "connected");

  const response = await fetch(`http://127.0.0.1:${gatewayPort}/hello`, {
    headers: { "x-forwarded-host": "demo.vercel.app" }
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-security-proxy"), "yes");
  const payload = await response.json();
  assert.equal(payload.path, "/hello");
  assert.equal(payload.original, "demo.vercel.app");
  assert.equal(payload.marker, "1");
  assert.equal(payload.host, `127.0.0.1:${backendPort}`);

  const parallel = await Promise.all(
    Array.from({ length: 6 }, (_, i) => fetch(`http://127.0.0.1:${gatewayPort}/${i}`).then(r => r.json()))
  );
  assert.deepEqual(parallel.map(r => r.path), Array.from({ length: 6 }, (_, i) => `/${i}`));

  const reconnected = waitFor(client, "connected", 8000);
  client.stop();
  client.start();
  await reconnected;
  assert.equal(loadDeployment("demo").serviceId, generated.serviceId);
});

test("stackedge vercel connect runs a detached FRPC worker", async t => {
  const backend = http.createServer((req, res) => res.end("bg-ok"));
  const backendPort = await listen(backend);

  fs.writeFileSync(
    path.join(root, "apps.json"),
    JSON.stringify([
      {
        name: "bg",
        ports: [{ virtual: 80, target: backendPort }],
        securityPort: backendPort
      }
    ])
  );

  const generated = initDeployment("bg");
  const gateway = createGateway({
    serviceId: generated.serviceId,
    token: loadCredentials("bg").token
  });
  const gatewayPort = await listen(gateway.server);
  setDeploymentUrl("bg", `http://127.0.0.1:${gatewayPort}`);

  t.after(async () => {
    stopTunnel("bg");
    await close(gateway.server);
    await gateway.close();
    await close(backend);
  });

  startTunnel("bg");

  const deadline = Date.now() + 10000;
  let connected = false;
  while (Date.now() < deadline && !connected) {
    await new Promise(resolve => setTimeout(resolve, 100));
    const state = require("../lib/vercel/config").readJson(
      require("../lib/vercel/config").connectionFile("bg")
    );
    connected = Boolean(state && state.connected);
  }
  assert.equal(connected, true);

  const body = await fetch(`http://127.0.0.1:${gatewayPort}/bg`).then(r => r.text());
  assert.equal(body, "bg-ok");

  stopTunnel("bg");
  assert.equal(
    require("../lib/vercel/config").readJson(require("../lib/vercel/config").connectionFile("bg")).manualDisconnect,
    true
  );
});
