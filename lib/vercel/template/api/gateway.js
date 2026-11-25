const http = require("http");
const { createGateway, sendError } = require("../lib/frps/server");
const { loadGatewayConfig, missingConfigMessage } = require("../lib/config");

const config = loadGatewayConfig();

let server;
const missing = missingConfigMessage(config);
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

module.exports = server;
