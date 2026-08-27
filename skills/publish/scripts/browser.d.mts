/** Types for browser.mjs (#75) — kept next to the implementation so the product repo's strict-TS
 *  tests can import the exact file the public skill ships. */

export interface OpenableResult {
  url?: string;
  customDomainUrl?: string;
}

export type SpawnLike = (cmd: string, args: string[], opts: object) => { on(event: string, cb: () => void): { unref(): void } };

export function isHeadless(opts?: { env?: Record<string, string | undefined>; platform?: string }): boolean;

export function pickOpenUrl(result: OpenableResult | null | undefined): string | null;

export function openBrowser(url: string, opts?: { spawnImpl?: SpawnLike; platform?: string }): void;

export function maybeOpen(
  result: OpenableResult | null | undefined,
  opts?: { open?: boolean; env?: Record<string, string | undefined>; platform?: string; spawnImpl?: SpawnLike },
): { opened: boolean; url?: string; reason?: string };
