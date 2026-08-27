/**
 * Wire core of the `login` device-pairing flow (#52): request a code, then poll until the owner
 * approves in the browser and the server hands back a scoped PAT. Pure JS with an injectable fetch
 * (and sleep), so the product repo CI drives this exact file against the real worker.
 */

export class LoginError extends Error {
  constructor(message) { super(message); this.name = "LoginError"; }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** True for a genuine connectivity failure (Node's undici surfaces it as "TypeError: fetch failed"
 *  with a `.cause`), so an unrelated throw (e.g. a malformed URL) isn't mislabeled as a network
 *  problem and can surface its real message instead. */
export function isTransportError(e) {
  if (e && e.cause !== undefined) return true;
  return /fetch failed|network|socket|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|dns/i.test(String((e && e.message) || e));
}
const NET_MSG = "Network error: couldn't reach the server. Check your connection and try again.";

async function jsonOrThrow(res) {
  let body = null;
  try { body = await res.json(); } catch { /* fall through to status */ }
  if (!res.ok) throw new LoginError((body && (body.message || body.error)) || ("HTTP " + res.status));
  return body || {};
}

/** POST /api/pairings/start → the codes + the URL the user opens. */
export async function startPairing({ apiOrigin, name }, fetchImpl) {
  const origin = String(apiOrigin || "").replace(/\/+$/, "");
  const body = {};
  if (name) body.name = name;
  let res;
  try {
    res = await fetchImpl(origin + "/api/pairings/start", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
  } catch (e) {
    // A transport failure → clear "retry" (nothing is pending yet, so failing here is safe). A
    // non-transport throw (bad --api URL, etc.) surfaces its real reason rather than "network".
    throw new LoginError(isTransportError(e) ? NET_MSG : String((e && e.message) || e));
  }
  const j = await jsonOrThrow(res);
  return {
    apiOrigin: origin,
    deviceCode: j.deviceCode,
    userCode: j.userCode,
    verificationUri: j.verificationUri,
    verificationUriComplete: j.verificationUriComplete,
    intervalMs: Math.max(1, Number(j.interval) || 5) * 1000,
    expiresInMs: Math.max(1, Number(j.expiresIn) || 600) * 1000,
  };
}

/**
 * Poll until the pairing resolves. Resolves `{ token, tokenName }` on approval; throws LoginError on
 * deny / expiry / token-limit / timeout. `pending` and `slow_down` both just wait one interval.
 */
// Retry a transient failure (the mint-revert 500, a network blip) a few times, but fail fast on a
// PERSISTENT one so `login` surfaces the real cause instead of silently looping to the deadline.
// Transport and 5xx keep SEPARATE counters so the error message names the right culprit.
const MAX_CONSECUTIVE_FAILS = 5;

export async function pollUntilApproved(pairing, fetchImpl, sleep = defaultSleep) {
  const { apiOrigin, deviceCode, expiresInMs } = pairing;
  let interval = pairing.intervalMs;
  let consecutive5xx = 0;
  let consecutiveTransport = 0;
  const deadline = pairing._now ? pairing._now() + expiresInMs : Date.now() + expiresInMs;
  for (;;) {
    const now = pairing._now ? pairing._now() : Date.now();
    if (now > deadline) throw new LoginError("This login timed out. Run login again.");
    let res;
    try {
      res = await fetchImpl(apiOrigin + "/api/pairings/poll", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceCode }),
      });
    } catch (e) {
      // A NON-transport throw (bad URL, arg bug) is a real error → surface it, don't retry forever.
      if (!isTransportError(e)) throw new LoginError(String((e && e.message) || e));
      // A transport blip mid-poll: the owner may have already approved, so don't throw it away —
      // bounded retry, then fail fast if the network stays down.
      if (++consecutiveTransport > MAX_CONSECUTIVE_FAILS) throw new LoginError(NET_MSG);
      await sleep(interval);
      continue;
    }
    consecutiveTransport = 0;
    // 429 (poll rate limit) and 5xx (the server's revert-and-retry after a transient mint error) are
    // NOT terminal — back off and keep polling. A 5xx that PERSISTS (a real outage, not the one-poll
    // mint-revert) fails fast after a few tries rather than looping to the deadline.
    if (res.status === 429 || res.status >= 500) {
      if (res.body) { try { await res.body.cancel(); } catch { /* drain so the connection can be reused */ } }
      if (res.status >= 500 && ++consecutive5xx > MAX_CONSECUTIVE_FAILS) throw new LoginError("The server keeps failing to finish login (HTTP " + res.status + "). Try again shortly.");
      await sleep(interval);
      continue;
    }
    consecutive5xx = 0;
    let j = null;
    try { j = await res.json(); } catch { /* fall through */ }
    if (!res.ok) throw new LoginError((j && (j.message || j.error)) || ("HTTP " + res.status));
    switch (j && j.status) {
      case "approved":
        if (!j.token) throw new LoginError("Login approved but no token was returned. Try again.");
        return { token: j.token, tokenName: j.tokenName };
      case "denied": throw new LoginError("Login was denied in the browser.");
      case "expired": throw new LoginError("This login expired before it was approved. Run login again.");
      case "limit": throw new LoginError((j && j.message) || "You have too many active tokens. Revoke one in the dashboard, then run login again.");
      case "slow_down": interval = Math.max(interval, (Number(j.interval) || 5) * 1000); await sleep(interval); break;
      case "pending": default: await sleep(interval); break;
    }
  }
}
