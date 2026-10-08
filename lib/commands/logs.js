const fs = require("fs");
const { logFile } = require("../process");

/**
 * Print the last N lines of an app's log.
 * @param {string} name - App name
 * @param {number} lines - How many trailing lines to show
 */
async function logsApp(name, lines = 100) {
  const file = logFile(name);

  if (!fs.existsSync(file)) {
    console.log(`No logs for '${name}' yet (${file})`);
    return;
  }

  const content = fs.readFileSync(file, "utf8").replace(/\s+$/, "");
  if (!content) {
    console.log(`Log file for '${name}' is empty`);
    return;
  }

  const all = content.split("\n");
  console.log(all.slice(Math.max(0, all.length - lines)).join("\n"));
}

module.exports = { logsApp };
