const path = require("path");
const HOME = process.env.HOME;

module.exports = {
  HOME,
  BASE_DIR: path.join(HOME, ".stackedge"),
  APPS_FILE: path.join(HOME, ".stackedge", "apps.json"),
  LOG_DIR: path.join(HOME, ".stackedge", "logs"),
  TOR_DIR: path.join(HOME, ".stackedge", "tor"),
  TORRC: path.join(HOME, ".stackedge", "tor", "torrc")
};
