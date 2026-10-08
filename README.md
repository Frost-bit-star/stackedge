### Stackedge

<div align="center">
  <img 
    src="/Screenshot (4).png" 
    alt="Desktop View of Hosted Website" 
    style="max-width: 100%; height: auto; display: block;"
  />
</div>

## Decentralized App Hosting with Tor - Termux, Linux servers and VPS

Stackedge runs any web app (Node.js, PHP, Go, Python, static sites...) in the background and
exposes it through a Tor onion service. It works the same on an Android phone (Termux),
a Debian/Ubuntu VPS, Fedora, Arch, Alpine or a Mac - no fixed ports, no fixed paths.

Your apps start immediately, Tor is installed and bootstrapped for you, and after a server
reboot everything comes back on its own.

**Features**

- Run any app from any folder - Node.js, PHP, Go, Python, anything with a command.

- **Any port**: use `--port 8080`, `--port 4242`, or none at all and stackedge picks a free one.

- **Works everywhere**: Termux, Linux servers, VPS, macOS. The Tor binary and all paths are
  auto-detected - nothing is hardcoded to one machine.

- **Installs Tor for you** if it is missing (`apt`, `dnf`, `pacman`, `apk`, `zypper`, `brew`, Termux `pkg`).

- **Survives reboots**: `stackedge daemon install` registers a systemd service (or cron
  `@reboot`, or a shell hook on Termux) that restores your apps on boot.

- Coexists with a system Tor daemon: if the default control port is taken, stackedge
  automatically moves to a free one.

- CLI similar to pm2: `start`, `stop`, `restart`, `delete`, `list`, `resurrect`, `logs`.

**Open-source and focused on privacy & decentralization.**

---

### Table of Contents

- [Requirements](#requirements)
- [Install](#install)
- [Usage](#usage)
- [Commands](#commands)
- [Boot integration (reboots)](#boot-integration-reboots)
- [Configuration](#configuration)
- [Data directory](#data-directory)
- [Dashboard & Screenshots](#dashboard--screenshots)
- [Tor onion testing](#tor-onion-testing)
- [Project philosophy](#project-philosophy)
- [Support](#support)

---

### Requirements

**Android / Termux**

```
pkg update -y && pkg upgrade -y
pkg install nodejs git -y
```

**Linux server / VPS (Debian, Ubuntu, Fedora, Arch, Alpine...)**
Node.js 18+ (`node -v` to check). Everything else - including Tor - is installed for you.

**Optional runtimes for your apps**

```
Termux:  pkg install php golang python -y
Debian:  sudo apt install php golang python3 -y
```

---

### Install

```
npm install -g stackedge
```

Then run the one-shot setup. On a server this installs Tor (if missing) and registers boot
integration so your apps come back after a reboot:

```
stackedge setup
```

Prefer to do it by hand? Then just run the two pieces separately:

```
stackedge daemon install     # start apps on boot (systemd / cron / shell hook)
```

Verify:

```
stackedge            # shows the command list
stackedge daemon status
```

---

### Usage

Navigate to the project you want to host and start it:

```
cd ~/my-react-app
stackedge start blog -- npm start
```

- `blog` is the app name.
- Everything after `--` is the command used to start the app.

Output:

```
✔ blog running in background on port 45123
  logs: /home/you/.stackedge/logs/blog.log
🌐 http://generated-onion-address.onion
```

#### Any port

Stackedge never forces ports. Pick one:

```
stackedge start api --port 8080 -- node server.js
stackedge start site --port 4242 -- python3 -m http.server
stackedge start blog -- npm start                      # free port is picked for you
```

The port is also taken from, in this order:

1. `--port` flag
2. the command itself (`--port 4000`, `127.0.0.1:4000`, `http.server 8080`)
3. the `PORT` environment variable
4. any free port the OS hands out

Your app receives it through the `PORT` (and `SSL_PORT`) environment variables, so frameworks
that already honour `PORT` work without changes.

Apps that bind a specific interface can use `--host`:

```
stackedge start lan --host 10.0.0.5 --port 3000 -- npm start
```

---

### Commands

| Command | Description |
| --- | --- |
| `stackedge start <name> [--port <n>] [--ssl-port <n>] [--host <ip>] -- <cmd>` | Start an app and publish it as an onion service |
| `stackedge stop <name>` | Stop an app (kills its whole process group) |
| `stackedge restart <name>` | Restart an app on the same ports |
| `stackedge delete <name>` | Remove an app and its onion service |
| `stackedge list` | Table of apps, states, ports and onion URLs |
| `stackedge resurrect` | Restore every app (after a reboot or network drop) |
| `stackedge logs <name> [-n 100]` | Show recent app logs |
| `stackedge daemon <install\|uninstall\|status>` | Manage boot integration |
| `stackedge setup` | Install Tor if missing + install boot integration |

---

### Boot integration (reboots)

`stackedge daemon install` picks whatever fits the machine:

1. **systemd (system service)** - when running as root, or when passwordless `sudo` is
   available. Writes `/etc/systemd/system/stackedge.service` and enables it.
2. **systemd (user service)** - otherwise, writes
   `~/.config/systemd/user/stackedge.service` and enables login lingering, so apps start
   on boot without anyone logging in.
3. **cron `@reboot`** - for servers without systemd.
4. **Shell hook** - Termux and other systems: the line is added to `~/.bashrc` / `~/.zshrc`
   / `~/.profile`, which is how apps are restored when Termux is opened.

Remove it again with `stackedge daemon uninstall` (your apps and data stay untouched) and
inspect it with `stackedge daemon status`.

**Termux auto-resurrect by hand** (same thing the shell hook does):

```
echo 'if command -v stackedge >/dev/null; then stackedge resurrect >/dev/null 2>&1 & fi' >> ~/.bashrc
```

---

### Configuration

All settings are optional environment variables - nothing is hardcoded to one machine.

| Variable | Default | Meaning |
| --- | --- | --- |
| `TOR_BIN` | auto-detected | Path to the `tor` binary |
| `STACKEDGE_HOME` | `~/.stackedge` | Where apps, logs and Tor data live |
| `STACKEDGE_TOR_CONTROL_PORT` | `9051` | Tor control port (auto-moves if taken) |
| `STACKEDGE_TOR_SOCKS_PORT` | `0` (disabled) | Expose a local SOCKS port from Tor |
| `STACKEDGE_APP_HOST` | `127.0.0.1` | Address onion traffic is forwarded to |
| `STACKEDGE_BOOTSTRAP_TIMEOUT` | `180000` | How long to wait for Tor (ms) |
| `PORT` / `SSL_PORT` | auto | Default ports for the next `start` |

Example on a VPS where another Tor already owns 9051:

```
export STACKEDGE_TOR_CONTROL_PORT=9151
stackedge start blog -- npm start
```

---

### Data directory

```
~/.stackedge/
 ├── apps.json          # registry: apps, ports, onion addresses
 ├── logs/              # <name>.log for every app
 └── tor/
     ├── torrc          # regenerated from the registry on every change
     ├── control-port   # control port actually in use
     └── hidden/        # onion keys, one folder per app
```

Created automatically on first run. Older `~/.tor` data is imported once so existing onion
addresses are kept.

---

### Dashboard & Screenshots

**Dashboard View of running apps**

<div align="center">
  <img src="/Screenshot_20260103-160100.png" alt="Stackedge dashboard" width="600"/>
</div>

**Running Logs in Stackedge**

<div align="center">
  <img src="/Screenshot_20260103-175414.png" alt="Stackedge running logs" width="600"/>
</div>

---

### Tor onion testing

**Quick `.onion` testing (no Tor install required)**

👉 **[4everproxy Tor Proxy](https://www.4everproxy.com/tor-proxy)**

#### Notes

- Useful for basic availability checks
- No local Tor setup required
- Not recommended for privacy-critical use
- Some onion services may not fully load due to proxy limitations

For development, debugging and serious privacy testing, use **Tor Browser or a local Tor
daemon**.

---

### Project philosophy

## Stackedge is:

- **Open-source**: learn, modify and contribute.

- **Privacy-focused**: Tor integration keeps your apps accessible anonymously.

- **Decentralized hosting**: your phone or your VPS becomes your own server.

Built for developers, hackers and privacy enthusiasts who like Termux and building things.

Check out my other projects and tutorials: [here](https://www.youtube.com/@Mr_termux-r2l)

---

### ☕ Support This Project

If you value open-source and anonymity, support me so I can keep building decentralized hosting tools:

<a href="https://selar.com/showlove/alchemist" target="_blank"> <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" height="50" alt="Buy Me A Coffee"> </a>

---

License

MIT License - open source for everyone.
