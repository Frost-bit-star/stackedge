const readline = require("readline");

const PROVIDERS = {
  tor: ["tor"],
  vercel: ["vercel"],
  both: ["tor", "vercel"],
  localhost: ["local"]
};

const HOSTING_CHOICES = [
  { key: "1", value: "tor", label: "Tor Onion Service", providers: PROVIDERS.tor },
  { key: "2", value: "vercel", label: "Vercel", providers: PROVIDERS.vercel },
  { key: "3", value: "both", label: "Both", providers: PROVIDERS.both },
  { key: "4", value: "local", label: "Localhost only", providers: PROVIDERS.localhost }
];

function providersFromFlags(flags = {}) {
  const tor = Boolean(flags.tor);
  const vercel = Boolean(flags.vercel);
  const local = Boolean(flags.local || flags.localhost);

  if (!tor && !vercel && !local) return null;

  if (local && (tor || vercel)) {
    throw new Error("--local cannot be combined with --tor or --vercel");
  }

  if (tor && vercel) return PROVIDERS.both;
  if (tor) return PROVIDERS.tor;
  if (vercel) return PROVIDERS.vercel;
  return PROVIDERS.localhost;
}

function normalizeProviders(app = {}) {
  if (Array.isArray(app.providers) && app.providers.length) {
    const normalized = app.providers
      .map(provider => (provider === "localhost" ? "local" : provider))
      .filter(provider => ["tor", "vercel", "local"].includes(provider));
    return [...new Set(normalized)];
  }

  if (app.hosting === "vercel") return PROVIDERS.vercel;
  if (app.hosting === "both") return PROVIDERS.both;
  if (app.hosting === "local" || app.hosting === "localhost") return PROVIDERS.localhost;
  return PROVIDERS.tor;
}

function usesTor(providers) {
  return normalizeProviders({ providers }).includes("tor");
}

function usesVercel(providers) {
  return normalizeProviders({ providers }).includes("vercel");
}

function hostingLabel(providers) {
  const normalized = normalizeProviders({ providers });
  if (normalized.includes("tor") && normalized.includes("vercel")) return "Tor + Vercel";
  if (normalized.includes("tor")) return "Tor";
  if (normalized.includes("vercel")) return "Vercel";
  return "Localhost";
}

function hostingKey(providers) {
  const normalized = normalizeProviders({ providers });
  if (normalized.includes("tor") && normalized.includes("vercel")) return "both";
  return normalized[0] || "local";
}

function addProvider(app, provider) {
  const providers = normalizeProviders(app);
  if (!providers.includes(provider)) providers.push(provider);
  return providers;
}

async function promptProvider() {
  if (!process.stdin.isTTY) {
    throw new Error("No hosting provider selected. Use --tor, --vercel, or --local.");
  }

  console.log("\nSTACKEDGE HOSTING SETUP\n");
  console.log("Select how you want to publish your application:\n");
  for (const choice of HOSTING_CHOICES) {
    console.log(`  [${choice.key}] ${choice.label}`);
  }
  console.log("");

  const answer = await new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("Selection: ", value => {
      rl.close();
      resolve(value.trim().toLowerCase());
    });
  });

  const choice = HOSTING_CHOICES.find(
    item => item.key === answer || item.value === answer || item.label.toLowerCase() === answer
  );

  if (!choice) throw new Error("Invalid hosting selection.");
  return choice.providers;
}

async function resolveProviders(flags = {}) {
  return providersFromFlags(flags) || promptProvider();
}

module.exports = {
  PROVIDERS,
  providersFromFlags,
  normalizeProviders,
  usesTor,
  usesVercel,
  hostingLabel,
  hostingKey,
  addProvider,
  promptProvider,
  resolveProviders
};
