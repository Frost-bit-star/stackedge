### Stackedge

<div align="center">
  <img 
    src="/Screenshot (4).png" 
    alt="Desktop View of Hosted Website" 
    style="max-width: 100%; height: auto; display: block;"
  />
</div>

## Decentralized App Hosting on Android using Termux + Tor

Stackedge is a Termux-friendly app hosting system that allows you to run any web app (Node.js, PHP, Go, etc.) on your Android device.
Inspired by the desire to build something decentralized, privacy-focused, and open-source, Stackedge integrates Tor onion services to make your apps accessible anywhere safely.

Your apps start immediately, Tor bootstraps in the background, and you can manage them via a simple CLI (start, stop, restart, list, resurrect).

**Features**

- Run any app (Node.js, PHP, Go, Python…) from the folder you are in.

- Tor integration for onion services.

- Apps start immediately; Tor bootstraps in the background.

- Resilient to Wi-Fi drops or Termux restarts.

## CLI commands similar to pm2:

- stackedge start <name> -- <command>

- stackedge stop <name>

- stackedge restart <name>

- stackedge list

- stackedge resurrect

- Fallback command shows status and help.

**Open-source and focused on privacy & decentralization.**
---

### Table of Contents

**Requirements**

1.Installation

2.Setup

**Usage**

1.Termux Auto-Resurrect

**Project Philosophy**

## Support

---

### Requirements

Android device

Termux
 installed

**Installed Termux packages:**
```
pkg update && pkg upgrade -y
pkg install nodejs git tor -y
```

**Optional for PHP apps:**
```
pkg install php -y
```

**Optional for Go apps:**

```
pkg install golang -y
```
**Optional for Python apps:**
```
pkg install python -y
```

### Installation & Usage

-- Step 1: Install dependencies
For Termux / Linux:
Copy code

Bash
# Update packages

```
pkg update -y && pkg upgrade -y

# Install Node.js and npm
pkg install nodejs -y

# Install Tor
pkg install tor -y
```
Make sure node, npm, and tor are in your PATH:
Copy code
Bash

```
node -v
npm -v
tor --version
```
- Step 2: Install Stackedge globally
Copy code
Bash

```
npm install -g stackedge
```
- Step 3: Verify installation
Copy code
Bash
```
stackedge

```
You should see the CLI help output.

- Step 4: Host your project
Navigate to the root folder of the project you want to host:
Copy code
Bash

```
cd /path/to/your/project

```
Start your app with Stackedge:
Copy code
Bash

```
stackedge start <appname> -- 127.0.0.1:3000

```
**Important:**

- The first app must run on port 3000.
- Subsequent apps should increment the port by 1: second app → 3001, third app → 3002, etc.
- Do not skip ports, otherwise the app will fail to start.
- Stackedge will run your app in the background and automatically create a Tor hidden service:
Copy code

```
✔ <appname> running in background
🌐 https://<generated-onion-url>
    
```
---

### Dashboard & Screenshots

**Dashboard View of running apps**

<div align="center">
  <img src="/Screenshot_20260103-160100.png" alt="Desktop View of Hosted Website" width="600"/>
</div>

**Running Logs in Stackedge**

<div align="center">
  <img src="/Screenshot_20260103-175414.png" alt="Stackedge Running Logs" width="600"/>
</div>
---

**You should see a status summary and available commands.**

### Setup

Stackedge uses the following directory structure in Termux:
```
$HOME/.stackedge/
 ├── apps.json             # Stores all app info
 ├── tor/
 │   ├── torrc             # Tor config
 │   └── services/         # Onion services storage
 └── logs/                 # App logs
```

**Stackedge automatically creates these directories on first run.**

## Usage
Start an app

Navigate to the app folder and run:
```
cd ~/my-react-app
stackedge start blog -- npm start
```

- blog is the app name.

- Everything after -- is the command to start your app.

**Tor starts in the background; your app starts immediately.**

### The onion address will appear once Tor is fully bootstrapped.

## Stop an app
- stackedge stop blog

## Restart an app
- stackedge restart blog

## List all apps
- stackedge list

---

**Shows:**

- App name

- App state (running/stopped)

- Port

- Tor state (pending/online)

- Onion address

- Resurrect all apps

**Use this to restore apps after Termux restart or Wi-Fi loss:**

- stackedge resurrect

- Termux Auto-Resurrect

**To automatically restore apps when Termux opens:**
```bash
echo 'if command -v stackedge >/dev/null; then stackedge resurrect >/dev/null 2>&1 & fi' >> ~/.bashrc
```

- Apps will start immediately.

- Tor will bootstrap in the background.

- No manual intervention needed.

- Project Philosophy

## Stackedge is:

### Open-source: Learn, modify, and contribute.

- Privacy-focused: Tor integration keeps your apps secure and accessible anonymously.

- Decentralized hosting on Android: Your device becomes your own server.

- Inspired by a love for Termux and building something great, this project is for developers, hackers, and privacy enthusiasts.

Check out my other projects and tutorials:
 [here](https://www.youtube.com/@Mr_termux-r2l)


---

### ☕ Support This Project

If you value open-source and anonymity, support me so I can keep building decentralized hosting tools on Android:

<a href="https://opencollective.com/tpkg-projects" target="_blank"> <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" height="50" alt="Buy Me A Coffee"> </a>


License

---

MIT License – Open source for everyone.
