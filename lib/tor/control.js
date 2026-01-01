const net = require("net");

function createOnion(port) {
  return new Promise((resolve) => {
    const socket = net.connect(9051, "127.0.0.1");
    socket.on("connect", () => {
      socket.write("AUTHENTICATE\r\n");
      socket.write(`ADD_ONION NEW:ED25519-V3 Port=80,127.0.0.1:${port}\r\n`);
    });
    socket.on("data", (data) => {
      const line = data.toString();
      if (line.includes("ServiceID=")) {
        const id = line.split("ServiceID=")[1].trim();
        socket.end();
        resolve(`${id}.onion`);
      }
    });
  });
}

module.exports = { createOnion };
