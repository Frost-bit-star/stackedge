const net = require("net");

function waitForBootstrap() {
  return new Promise((resolve) => {
    const socket = net.connect(9051, "127.0.0.1");
    socket.on("connect", () => {
      socket.write("AUTHENTICATE\r\n");
      socket.write("SETEVENTS STATUS_CLIENT\r\n");
    });
    socket.on("data", (data) => {
      if (data.toString().includes("BOOTSTRAP PROGRESS=100")) {
        socket.end();
        resolve();
      }
    });
  });
}

module.exports = { waitForBootstrap };
