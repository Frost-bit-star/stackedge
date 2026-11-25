const fs = require("fs");
const path = require("path");

const DEFAULT_MAX_BODY_SIZE = 16 * 1024 * 1024;

function loadGatewayConfig() {
  let fileConfig = {};
  try {
    fileConfig = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "config.json"), "utf8"));
  } catch {}

  const maxBodySize = Number(
    process.env.STACKEDGE_FRPS_MAX_BODY_SIZE || fileConfig.maxBodySize || DEFAULT_MAX_BODY_SIZE
  );

  return {
    serviceId: process.env.STACKEDGE_FRPS_SERVICE_ID || fileConfig.serviceId || null,
    token: process.env.STACKEDGE_FRPS_TOKEN || fileConfig.token || null,
    application:
      process.env.STACKEDGE_FRPS_APP || fileConfig.application || fileConfig.app || "app",
    maxBodySize: Number.isFinite(maxBodySize) && maxBodySize > 0 ? maxBodySize : DEFAULT_MAX_BODY_SIZE
  };
}

module.exports = { loadGatewayConfig };
