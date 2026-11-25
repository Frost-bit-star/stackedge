const http = require("http");
const { createGateway, sendError } = require("./lib/frps/server");
const { loadGatewayConfig, missingConfigMessage } = require("./lib/config");

const config = loadGatewayConfig();
const missing = missingConfigMessage(config);

let server;
if (missing.length) {
  server = http.createServer((req, res) => {
    sendError(
      req,
      res,
      500,
      "Configuration missing",
      `Missing configuration: ${missing.join("; ")}. Keep config.json private, or set the environment variables in Vercel.`,
      "config"
    );
  });
} else {
  try {
    server = createGateway(config).server;
  } catch (err) {
    server = http.createServer((req, res) => {
      sendError(req, res, 500, "Gateway startup failed", err.message, "startup");
    });
  }
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  server.listen(port, () => {
    if (missing.length) {
      console.warn(`Stackedge FRPS running in error mode on port ${port}: missing ${missing.join("; ")}`);
    } else {
      console.log(`Stackedge FRPS listening on port ${port} (service ${config.serviceId})`);
    }
  });
}

module.exports = server;
