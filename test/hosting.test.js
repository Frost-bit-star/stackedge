const test = require("node:test");
const assert = require("node:assert/strict");

const {
  providersFromFlags,
  normalizeProviders,
  usesTor,
  usesVercel,
  hostingKey,
  addProvider
} = require("../lib/hosting");

test("hosting flags select one provider", () => {
  assert.deepEqual(providersFromFlags({ tor: true }), ["tor"]);
  assert.deepEqual(providersFromFlags({ vercel: true }), ["vercel"]);
  assert.deepEqual(providersFromFlags({ local: true }), ["local"]);
  assert.deepEqual(providersFromFlags({ tor: true, vercel: true }), ["tor", "vercel"]);
  assert.equal(providersFromFlags({}), null);
});

test("vercel-only hosting does not use Tor", () => {
  const providers = providersFromFlags({ vercel: true });
  assert.equal(usesVercel(providers), true);
  assert.equal(usesTor(providers), false);
  assert.equal(hostingKey(providers), "vercel");
});

test("legacy apps default to Tor", () => {
  const providers = normalizeProviders({ appState: "running" });
  assert.deepEqual(providers, ["tor"]);
  assert.equal(usesTor(providers), true);
  assert.equal(usesVercel(providers), false);
});

test("vercel init adds Vercel without removing Tor", () => {
  const providers = addProvider({ providers: ["tor"] }, "vercel");
  assert.deepEqual(providers, ["tor", "vercel"]);
  assert.equal(hostingKey(providers), "both");
});
