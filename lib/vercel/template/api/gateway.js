const http = require("http");
const { createGateway, sendError } = require("../lib/frps/server");
const { loadGatewayConfig } = require("../lib/config");

const config = loadGatewayConfig();

let server;
if (!config.serviceId || !config.token) {
  server = http.createServer((req, res) => {
    sendError(
      req,
      res,
      500,
      "Configuration missing",
      "Add config.json to the deployment or set STACKEDGE_FRPS_SERVICE_ID and STACKEDGE_FRPS_TOKEN.",
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

module.exports = server;
