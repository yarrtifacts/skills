/**
 * Local credential store for the skill (#52). The token lives in a config file, NEVER in the model's
 * context: `login` writes it, `upload` reads it. Env `YARRTIFACTS_TOKEN` takes precedence so CI and
 * headless runs can inject one without a browser.
 *
 * Path: %APPDATA%/yarrtifacts/config.json on Windows, else $XDG_CONFIG_HOME (or ~/.config)/yarrtifacts/config.json.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export function configDir() {
  if (process.platform === "win32" && process.env.APPDATA) return join(process.env.APPDATA, "yarrtifacts");
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "yarrtifacts");
}
export function configPath() {
  return join(configDir(), "config.json");
}

export const DEFAULT_API_ORIGIN = "https://yarrtifacts.com";

/** The saved config object, or null if none/unreadable. */
export function readConfig() {
  try { return JSON.parse(readFileSync(configPath(), "utf8")); } catch { return null; }
}

/**
 * Resolve the token AND the origin to talk to, COHERENTLY, in one config read:
 *  - token: env `YARRTIFACTS_TOKEN` (CI/headless override) first, else the saved config token.
 *  - origin: an explicit `--api` always wins; otherwise the origin FOLLOWS the token's source — a
 *    config token uses the origin `login` saved for it, an env token uses prod. This keeps a token
 *    from ever being checked/sent against a different server than it was minted for.
 */
export function resolveAuth(explicitApi) {
  const envToken = process.env.YARRTIFACTS_TOKEN;
  const cfg = readConfig();
  const token = envToken || (cfg && typeof cfg.token === "string" && cfg.token ? cfg.token : null);
  let apiOrigin;
  if (explicitApi) apiOrigin = String(explicitApi).replace(/\/+$/, "");
  else if (!envToken && cfg && typeof cfg.apiOrigin === "string" && cfg.apiOrigin) apiOrigin = cfg.apiOrigin;
  else apiOrigin = DEFAULT_API_ORIGIN;
  return { token, apiOrigin };
}

/** Read-merge-write (#64): applies `patch` on top of whatever's on disk (or {} if none/unreadable),
 *  WITHOUT clobbering fields the patch doesn't mention — in particular the token/apiOrigin/createdAt
 *  that `login` wrote. No-op (returns null, touches nothing) on a null/undefined patch, so call sites
 *  can pass a possibly-null `configPatch` straight through without their own guard. */
export function updateConfig(patch) {
  if (!patch) return null;
  const current = readConfig() || {};
  return writeConfig({ ...current, ...patch });
}

/** Write the config atomically (temp file + rename) with 0600, so a Ctrl-C can't leave a partial or
 *  world-readable credential. `chmod 0600` is a POSIX no-op on Windows (ACL-only) — documented. */
export function writeConfig(cfg) {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  const path = configPath();
  const tmp = join(dirname(path), ".config.json.tmp");
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* best effort on Windows */ }
  renameSync(tmp, path);
  return path;
}
