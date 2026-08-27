#!/usr/bin/env node
/**
 * `login` subcommand for the publish skill (#52): connect this machine to a yarrtifacts.com account
 * without pasting a token. Requests a pairing code, opens the approve link in the browser, and once
 * the owner clicks Allow, stores the returned scoped token in ~/.config/yarrtifacts/config.json.
 * Node >= 18 (global fetch), zero dependencies.
 *
 * Usage: node login.mjs [--name <label>] [--api <origin>] [--no-open]
 *        node login.mjs status                 # is the stored token still valid?
 *        node login.mjs logout                 # forget the stored token
 */
import { rmSync } from "node:fs";
import { startPairing, pollUntilApproved, LoginError } from "./login-core.mjs";
import { updateConfig, resolveAuth, configPath, DEFAULT_API_ORIGIN } from "./config.mjs";
import { openBrowser } from "./browser.mjs";

function parseArgs(argv) {
  const a = { open: true }; // a.api stays undefined unless --api is passed
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--name") a.name = argv[++i];
    else if (v === "--api") a.api = argv[++i];
    else if (v === "--no-open") a.open = false;
    else if (v === "status" || v === "logout") a.cmd = v;
    else throw new LoginError("Unknown argument: " + v);
  }
  return a;
}

async function doStatus(explicitApi) {
  // token + its matching origin resolved together, so an env token is checked against prod and a
  // saved token against the origin it was minted for.
  const { token, apiOrigin } = resolveAuth(explicitApi);
  if (!token) { console.log("Not connected. Run login to connect."); return; }
  const res = await fetch(apiOrigin + "/api/tokens/whoami", { headers: { authorization: "Bearer " + token } });
  console.log(res.ok ? "Connected." : "The stored token is no longer valid. Run login again.");
  if (!res.ok) process.exit(1);
}

async function main() {
  let a;
  try { a = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(1); }

  if (a.cmd === "logout") {
    try { rmSync(configPath()); console.log("Disconnected."); } catch { console.log("Nothing to disconnect."); }
    return;
  }
  if (a.cmd === "status") { await doStatus(a.api); return; }

  try {
    // login establishes a fresh pairing against --api (or prod); the resulting origin is saved so
    // later status/upload talk to the same place.
    const pairing = await startPairing({ apiOrigin: a.api || DEFAULT_API_ORIGIN, name: a.name }, fetch);
    const url = pairing.verificationUriComplete || pairing.verificationUri;
    console.error("Open this link in your browser and click Allow:");
    console.error("  " + url);
    console.error("Confirm this code matches what you see there:  " + pairing.userCode);
    if (a.open) openBrowser(url);
    console.error("Waiting for you to approve...");

    const { token } = await pollUntilApproved(pairing, fetch);
    // Merge, not overwrite (#64) — a re-pair on a machine that already saved a --default-domain
    // preference must not silently wipe it.
    const path = updateConfig({ token, apiOrigin: pairing.apiOrigin, createdAt: new Date().toISOString() });
    // Never print the token itself.
    console.error("Connected. Saved to " + path);
    console.log("connected");
  } catch (e) {
    console.error(e instanceof LoginError ? e.message : String(e));
    process.exit(1);
  }
}
main();
