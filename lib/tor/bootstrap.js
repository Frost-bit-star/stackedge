const fs = require("fs");
const path = require("path");
const net = require("net");

async function waitForBootstrap(torDir, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const cookieFile = path.join(torDir, "control_auth_cookie");

    let cookieHex;
    try {
      cookieHex = fs.readFileSync(cookieFile).toString("hex");
    } catch (err) {
      return reject(new Error("Cannot read Tor cookie: " + err.message));
    }

    const socket = net.connect(9051, "127.0.0.1");
    const start = Date.now();

    socket.on("connect", () => {
      socket.write(`AUTHENTICATE ${cookieHex}\r\n`);
      socket.write("SETEVENTS STATUS_GENERAL\r\n");
    });

    socket.on("data", (data) => {
      const lines = data.toString().split("\r\n");

      for (const line of lines) {
        // Example:
        // 650 STATUS_GENERAL BOOTSTRAP PROGRESS=100 TAG=done SUMMARY="Done"
        if (line.includes("BOOTSTRAP") && line.includes("PROGRESS=100")) {
          socket.end();
          return resolve();
        }

        if (line.startsWith("515") || line.startsWith("550")) {
          socket.end();
          return reject(new Error("Tor control error: " + line));
        }
      }
    });

    socket.on("error", reject);

    const timer = setInterval(() => {
      if (Date.now() - start > timeout) {
        clearInterval(timer);
        socket.end();
        reject(new Error("Tor bootstrap timed out"));
      }
    }, 1000);
  });
}

module.exports = { waitForBootstrap };
