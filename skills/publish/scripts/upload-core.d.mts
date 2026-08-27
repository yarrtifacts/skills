/** Types for upload-core.mjs — kept next to the implementation so the product repo's
 *  strict-TS tests can import the exact file the public skill ships. */

export class UploadError extends Error {
  status?: number;
  /** Set when a create-path failure left a 'processing' draft behind — pass it back as `abandon` on retry. */
  artifactId?: string;
  /** Set by editArtifact when the slug call fails after the title already committed. */
  partial?: { title?: string | null };
  constructor(message: string, status?: number);
}

/** Exactly one of `body` (inline) or `readBody` (lazy per-file read) must be provided. */
export type UploadFile = { relativePath: string; size: number } & (
  | { body: string | Uint8Array; readBody?: never }
  | { body?: never; readBody: () => string | Uint8Array }
);

export interface UploadResult {
  url: string;
  /** Fully-qualified; null only against a pre-#64 server that doesn't send one. */
  pathUrl: string | null;
  slug: string;
  artifactId: string;
  versionId: string;
  /** false = the version stored but the artifact is unpublished, so the link is dormant. */
  published: boolean;
  /** The resolved branded custom-domain link for THIS run, or null (#64). */
  customDomainUrl: string | null;
  /** Set when 2+ active domains exist with no valid stored default — a non-blocking hint, never a failure. */
  domainPrompt: { candidates: string[] } | null;
  /** What to persist to the local config via updateConfig(), or null if nothing changed. */
  configPatch: DomainPreference | null;
  /** Set only when an explicit --default-domain override was invalid or couldn't be validated — the
   *  publish itself still succeeded. */
  domainOverrideError?: string;
  /** What the artifact was gated to BEFORE it went live, or null when the caller asked for nothing. */
  visibility: Visibility | null;
}

export interface EditResult {
  artifactId: string;
  /** null when the title was explicitly cleared (sanitizeTitle('') on the server). */
  title?: string | null;
  slug?: string;
  /** Set only when the slug changed. */
  url?: string;
  /** Set only when the slug changed; fully-qualified. */
  pathUrl?: string | null;
  /** Set only when the slug changed. false = the new link is dormant (the artifact isn't live). */
  published?: boolean;
  /** Present only when the slug changed or an explicit --default-domain was passed (#64). */
  customDomainUrl?: string | null;
  domainPrompt?: { candidates: string[] } | null;
  configPatch?: DomainPreference | null;
  domainOverrideError?: string;
}

/** Stored locally in config.json between runs (#64). "none" is an explicit opt-out, distinct from
 *  "never resolved yet" (the field simply absent/undefined). */
export type DomainPreference = { defaultDomain?: string; defaultDomainSnapshot?: string[] };

export interface DomainSelection {
  brandedHostname: string | null;
  hint: { candidates: string[] } | null;
}

export function fetchActiveDomains(
  opts: { apiOrigin: string; token: string },
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<{ active: string[]; primary: string | null }>;
export function resolveDomainSelection(
  activeHostnames: string[],
  stored: DomainPreference,
  primaryHostname?: string | null,
): DomainSelection;
export function validateDefaultDomainChoice(choice: string, activeHostnames: string[]): string;

export function formatFailure(status: number, body: { message?: string; error?: string } | null | undefined): string;
export function validateArgs(args: { replace?: string; title?: string; slug?: string; abandon?: string; edit?: string; dir?: string; defaultDomain?: string; visibility?: string }): void;
export function encodePath(rel: string): string;
export function bodyByteLength(body: string | Uint8Array): number;
export function uploadFiles(
  opts: {
    apiOrigin: string; token: string; files: UploadFile[]; title?: string; slug?: string;
    replace?: string; abandon?: string;
    /** CREATE path only: applied between init and the file PUTs, so the artifact goes live already
     *  closed. Passing either alongside `replace` THROWS — that artifact is already live, so gate it
     *  with setVisibility() after this resolves rather than before the upload. */
    visibility?: Visibility; password?: string;
  } & DomainPreference & { defaultDomainOverride?: string },
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<UploadResult>;
export function editArtifact(
  opts: { apiOrigin: string; token: string; artifactId: string; title?: string; slug?: string } & DomainPreference & { defaultDomainOverride?: string },
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<EditResult>;
export function setDefaultDomain(
  opts: { apiOrigin: string; token: string; defaultDomainOverride: string },
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<{ defaultDomain: string; configPatch: DomainPreference }>;

// Visibility (#83). A token may only tighten (public → password → private) or rotate a password;
// the SERVER owns that rule and answers 403 "token scope" on a downgrade.
export type Visibility = "public" | "password" | "private";
export function validateVisibilityChoice(choice: string): Visibility;
export function isVisibilityOnlyEdit(args: { edit?: string; visibility?: string; title?: string; slug?: string; defaultDomain?: string }): boolean;
export function generateSharePassword(length?: number): string;
export function setVisibility(
  opts: { apiOrigin: string; token: string; artifactId: string; visibility: Visibility; password?: string },
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<{ visibility: Visibility; password?: string }>;
