const { createGateway } = require("./lib/frps/server");
const { loadGatewayConfig } = require("./lib/config");

const { serviceId, token, application, maxBodySize } = loadGatewayConfig();

if (!serviceId || !token) {
  console.error("FRPS config missing: add config.json or set STACKEDGE_FRPS_SERVICE_ID and STACKEDGE_FRPS_TOKEN.");
  process.exit(1);
}

const port = Number(process.env.PORT || 3000);
const gateway = createGateway({ serviceId, token, application, maxBodySize });

gateway.server.listen(port, () => {
  console.log(`Stackedge FRPS listening on port ${port} (service ${serviceId})`);
});
