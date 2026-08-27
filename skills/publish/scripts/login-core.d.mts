/** Types for login-core.mjs — kept next to the implementation so the product repo's strict-TS
 *  tests can import the exact file the public skill ships. */

export class LoginError extends Error {
  constructor(message: string);
}

export interface Pairing {
  apiOrigin: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  intervalMs: number;
  expiresInMs: number;
  /** Test seam: an injectable clock for the deadline (defaults to Date.now). */
  _now?: () => number;
}

export function startPairing(
  opts: { apiOrigin: string; name?: string },
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<Pairing>;

export function pollUntilApproved(
  pairing: Pairing,
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
  sleep?: (ms: number) => Promise<void>,
): Promise<{ token: string; tokenName: string }>;
