const { createRequestHandler, createWebSocketServer, sendError } = require("../lib/frps/server");
const { TunnelConnection } = require("../lib/frps/connection-manager");
const { loadGatewayConfig } = require("../lib/config");

const { serviceId, token, application, maxBodySize } = loadGatewayConfig();

if (!serviceId || !token) {
  module.exports = (req, res) => {
    sendError(
      req,
      res,
      500,
      "Configuration missing",
      "Add config.json to the deployment or set STACKEDGE_FRPS_SERVICE_ID and STACKEDGE_FRPS_TOKEN.",
      "config"
    );
  };
} else {
  const tunnel = new TunnelConnection({ serviceId, maxBodySize });
  const wss = createWebSocketServer({ serviceId, token, tunnel, maxBodySize });
  const handle = createRequestHandler({ serviceId, token, application, maxBodySize, tunnel });

  module.exports = (req, res) => {
    if (req.headers.upgrade && String(req.url).startsWith("/_frpc")) {
      if (!req.socket || typeof wss.handleUpgrade !== "function") {
        sendError(
          req,
          res,
          501,
          "WebSocket unavailable",
          "This runtime cannot accept the FRPC WebSocket upgrade. Use a long-lived Node runtime or a Vercel-supported persistent transport.",
          "upgrade"
        );
        return;
      }
      try {
        wss.handleUpgrade(req, req.socket, Buffer.alloc(0), socket => {
          wss.emit("connection", socket, req);
        });
        return;
      } catch (err) {
        sendError(
          req,
          res,
          501,
          "WebSocket upgrade failed",
          `The FRPC WebSocket upgrade failed: ${err.message}`,
          "upgrade"
        );
        return;
      }
    }
    return handle(req, res);
  };
}
