const net = require("net");
const fs = require("fs");
const path = require("path");

async function waitForBootstrap(torDir) {
  return new Promise((resolve, reject) => {
    const cookieFile = path.join(torDir, "control_auth_cookie");
    let cookieHex;
    try {
      cookieHex = fs.readFileSync(cookieFile).toString("hex");
    } catch (err) {
      return reject("Cannot read Tor cookie: " + err.message);
    }

    const socket = net.connect(9051, "127.0.0.1", () => {
      socket.write(`AUTHENTICATE ${cookieHex}\r\n`);
      socket.write("SETEVENTS STATUS_CLIENT\r\n");
    });

    socket.on("data", (data) => {
      const lines = data.toString().split("\r\n");
      for (const line of lines) {
        if (line.includes("BOOTSTRAP PROGRESS=100")) {
          socket.end();
          return resolve();
        } else if (line.startsWith("515") || line.startsWith("550")) {
          socket.end();
          return reject("Tor error: " + line);
        }
      }
    });

    socket.on("error", (err) => reject(err));
  });
}

module.exports = { waitForBootstrap };
