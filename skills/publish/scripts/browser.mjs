/**
 * Shared browser-opening for the publish skill (#75). Extracted from login.mjs so both `login`
 * (opens the pairing link) and `upload` (opens the published artifact) share one launcher, and so the
 * decision logic — which link, and whether to open at all — is pure and unit-testable with an
 * injected spawn. Node >= 18, zero dependencies. spawn/platform/env are injectable for tests;
 * production calls default them to the real Node globals.
 */
import { spawn } from "node:child_process";

/** True when opening a browser here would clearly fail or land on the wrong machine: a Linux box with
 *  no display server, or any SSH session (the browser would open on the remote host, not the user's).
 *  macOS/Windows desktops don't use DISPLAY, so they're only headless under SSH. */
export function isHeadless({ env = process.env, platform = process.platform } = {}) {
  if (env.SSH_TTY || env.SSH_CONNECTION) return true;
  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return true;
  return false;
}

/** The best link to open for an upload/edit result: the branded custom-domain link when one resolved
 *  this run, else the subdomain link. null when there's nothing to open — a title-only edit or a
 *  standalone --default-domain has no `url`, so those never open a browser. */
export function pickOpenUrl(result) {
  if (!result) return null;
  return result.customDomainUrl || result.url || null;
}

/** Best-effort browser launch. Never throws and never blocks: a missing launcher / spawn error is
 *  swallowed (the link is always printed too), so opening can't change an upload's exit code. */
export function openBrowser(url, { spawnImpl = spawn, platform = process.platform } = {}) {
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  // Windows: `cmd /c start "" <url>` — the empty "" is start's title arg, so a url with spaces/quotes
  // isn't mistaken for the window title.
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawnImpl(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    /* print-only fallback — the caller already showed the link */
  }
}

/** Orchestrate the post-publish open: honour --no-open, skip headless/remote environments, pick the
 *  best link, and launch best-effort. Returns why it did or didn't open (for the caller's note + tests);
 *  never throws. */
export function maybeOpen(result, { open = true, env = process.env, platform = process.platform, spawnImpl = spawn } = {}) {
  if (!open) return { opened: false, reason: "no-open" };
  if (isHeadless({ env, platform })) return { opened: false, reason: "headless" };
  const url = pickOpenUrl(result);
  if (!url) return { opened: false, reason: "no-url" };
  openBrowser(url, { spawnImpl, platform });
  return { opened: true, url };
}
