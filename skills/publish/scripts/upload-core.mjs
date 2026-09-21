/**
 * Wire core of the publish skill: init → PUT files → finalize against the
 * yarrtifacts.com API, authorized by a Bearer PAT. Pure JS with an injectable fetch —
 * no node imports — so the product repo CI runs this exact file against the real app
 * and the published skill can never drift from the server contract.
 */

export class UploadError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "UploadError";
    this.status = status;
  }
}

/** The failure line agents see: the API's human message, else its error code, else the status. */
export function formatFailure(status, body) {
  return (body && (body.message || body.error)) || ("HTTP " + status);
}

// Single source of truth for "is there anything to edit", shared by validateArgs' CLI-args-shaped
// check and editArtifact's own opts-shaped guard (their field names differ — CLI uses `edit`,
// editArtifact's opts use `artifactId` — so this takes just the values that actually matter, not a
// whole args/opts object, keeping both callers' messages from drifting apart independently.
function requireEditField(title, slug, hasDomainOverride, hasVisibility) {
  // Presence check, not truthiness: --title "" is a real request (clear the title, mirroring the
  // dashboard's own rename field), not "not provided" — a falsy check would silently drop it.
  if (title === undefined && slug === undefined && !hasDomainOverride && !hasVisibility) {
    throw new UploadError("Nothing to edit: pass --title, --slug, --visibility, and/or --default-domain with --edit.");
  }
}

/** --title/--slug shape the CREATE call and --abandon reclaims a failed CREATE draft; the replace
 *  route ignores all three, so combining any with --replace would silently drop user intent.
 *  --edit (#60) is a distinct metadata-only mode (no re-upload): checked FIRST and returns early,
 *  so combining it with --replace gets --edit's own accurate message, not the create/replace one.
 *  --default-domain (#64) alone (no --title/--slug) is also a valid --edit — it just resolves and
 *  saves the default-domain preference against this artifact without touching its metadata. */
export function validateArgs(args) {
  if (args.delete) {
    // Deliberately exclusive: a `--delete <id>` that also carried a folder or an --edit field would
    // leave the caller guessing whether the upload happened before or after the artifact vanished.
    if (args.edit || args.replace || args.abandon || args.dir || args.title !== undefined || args.slug !== undefined || args.visibility !== undefined || args.defaultDomain !== undefined) {
      throw new UploadError("--delete stands alone: it removes an artifact for good, so it does not combine with a folder, --edit, --replace, --title, --slug, --visibility, or --default-domain.");
    }
    return;
  }
  if (args.edit) {
    if (args.replace || args.abandon || args.dir) {
      throw new UploadError("--edit only combines with --title, --slug, --visibility and --default-domain (it edits an existing artifact's metadata, no re-upload). Remove --replace, --abandon, or the folder path.");
    }
    requireEditField(args.title, args.slug, args.defaultDomain !== undefined, args.visibility !== undefined);
    return;
  }
  if (args.replace && (args.title !== undefined || args.slug !== undefined || args.abandon)) {
    throw new UploadError("--title, --slug and --abandon only apply when creating a new artifact. Remove them, or drop --replace.");
  }
}

export function encodePath(rel) {
  return rel.split("/").map(encodeURIComponent).join("/");
}

// ── Visibility (#83) ────────────────────────────────────────────────────────────────────────────
// A token moves an artifact in either direction. Opening one up is the agent's call to confirm with
// the human first (SKILL.md); nothing here can know what the human said, so nothing here refuses.
const VISIBILITIES = ["public", "password", "private"];

/** True when `--edit` was given with ONLY `--visibility` (no title/slug/default-domain). Such an edit
 *  is complete on its own and must NOT reach editArtifact: that call moves title/slug/default-domain,
 *  so with none of them present it would trip its own "nothing to edit" guard and reject a perfectly
 *  valid request. Lives here (not in the CLI shell) so the case stays covered by a test. */
export function isVisibilityOnlyEdit(args) {
  return !!args.edit && args.visibility !== undefined
    && args.title === undefined && args.slug === undefined && args.defaultDomain === undefined;
}

/** Validate a --visibility value. Throws an UploadError naming the accepted set. */
export function validateVisibilityChoice(choice) {
  if (!VISIBILITIES.includes(choice)) {
    throw new UploadError("--visibility must be one of: " + VISIBILITIES.join(", ") + ".");
  }
  return choice;
}

/** A fresh share password, generated locally when the caller did not supply one. Base62 so it can be
 *  pasted into a chat or a terminal without quoting or escaping. Generated (rather than accepted as
 *  a CLI flag) precisely so the secret never reaches argv, where `ps` and shell history would see it. */
export function generateSharePassword(length = 20) {
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(length * 2);
  crypto.getRandomValues(bytes);
  const reject = 256 - (256 % ALPHABET.length); // rejection sampling keeps the draw unbiased
  let out = "";
  for (const b of bytes) {
    if (b >= reject) continue;
    out += ALPHABET[b % ALPHABET.length];
    if (out.length === length) break;
  }
  return out.length === length ? out : out + generateSharePassword(length - out.length);
}

/** Set an artifact's visibility. Returns the server's resolved visibility, the state it moved FROM
 *  (`previous`, so the caller can say "private → public" and can tell a password rotation from a
 *  first password), plus the password when one was applied — the CALLER prints it once so the human
 *  can pass it on; it is never persisted here. */
export async function setVisibility(opts, fetchImpl) {
  const { token, artifactId, visibility, password } = opts;
  const apiOrigin = normalizeOrigin(opts.apiOrigin);
  validateVisibilityChoice(visibility);
  const body = { visibility };
  if (visibility === "password") {
    if (typeof password !== "string" || !password) throw new UploadError("A share password is required for --visibility password.");
    body.password = password;
  }
  const j = await request(fetchImpl, apiOrigin + "/api/artifacts/" + encodeURIComponent(artifactId) + "/visibility", {
    method: "POST", headers: authHeaders(token, true), body: JSON.stringify(body),
  });
  return { visibility: j.visibility || visibility, previous: j.previous, ...(visibility === "password" ? { password } : {}) };
}

/** Delete an artifact permanently. The link stops serving immediately and the content is wiped —
 *  there is no undo and no restore, so the CALLER is responsible for having asked the human first.
 *  Owner-scoped server-side: someone else's id answers 404, never a delete. */
export async function deleteArtifact(opts, fetchImpl) {
  const { token, artifactId } = opts;
  const apiOrigin = normalizeOrigin(opts.apiOrigin);
  await request(fetchImpl, apiOrigin + "/api/artifacts/" + encodeURIComponent(artifactId) + "/delete", {
    method: "POST", headers: authHeaders(token),
  });
}

/** Actual byte length of a PUT body (utf-8 for strings). Sent as an explicit Content-Length so the
 *  server's declared-size check applies even through in-process test bridges; real HTTP stacks
 *  compute the same value themselves. */
export function bodyByteLength(body) {
  if (typeof body === "string") return new TextEncoder().encode(body).length;
  return body.byteLength ?? body.length ?? 0;
}

async function jsonOrThrow(res) {
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON body: fall through to the status line */ }
  if (!res.ok) throw new UploadError(formatFailure(res.status, body), res.status);
  return body || {};
}

/** True for a genuine connectivity failure (offline / DNS / reset — Node's undici surfaces it as a
 *  bare "TypeError: fetch failed" with a `.cause`), so we don't relabel an unrelated throw (e.g. a
 *  malformed URL from a bad --api) as a network problem. */
export function isTransportError(e) {
  if (e && e.cause !== undefined) return true;
  return /fetch failed|network|socket|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|dns/i.test(String((e && e.message) || e));
}

/** fetch + jsonOrThrow, but a TRANSPORT failure becomes a friendly "retry" UploadError instead of an
 *  opaque TypeError. A NON-transport throw (bad URL, etc.) surfaces its real message, not masked as
 *  network. HTTP errors still flow through jsonOrThrow with the server's message. */
async function request(fetchImpl, url, init) {
  let res;
  try {
    res = await fetchImpl(url, init);
  } catch (e) {
    if (isTransportError(e)) throw new UploadError("Network error: couldn't reach the server. Check your connection and try again.");
    throw new UploadError(String((e && e.message) || e));
  }
  return jsonOrThrow(res);
}

// Normalize a pasted API origin: strip trailing slashes so "https://x.com/" + "/api/…" doesn't
// yield a //api pathname that matches no route (a very confusing 403). Shared by uploadFiles and
// editArtifact so a future fix to this rule can't land in one and be forgotten in the other.
function normalizeOrigin(origin) {
  return String(origin || "").replace(/\/+$/, "");
}

// Bearer auth header, alone (PUT/finalize) or extended with the JSON content-type (init/replace/
// rename/slug). Shared by uploadFiles and editArtifact for the same reason as normalizeOrigin.
function authHeaders(token, withJson) {
  const auth = { authorization: "Bearer " + token };
  return withJson ? { ...auth, "content-type": "application/json" } : auth;
}

/** GET /api/domains via the token; returns the lowercased+sorted active hostnames (pending/failed/
 *  detaching domains aren't usable share links yet) AND which of them the owner marked as the backend
 *  "primary" (#42), or null if none is set/active. Throws UploadError on a transport or HTTP failure —
 *  callers decide whether that's fatal for their situation. */
export async function fetchActiveDomains(opts, fetchImpl) {
  const apiOrigin = normalizeOrigin(opts.apiOrigin);
  const j = await request(fetchImpl, apiOrigin + "/api/domains", { method: "GET", headers: authHeaders(opts.token) });
  const domains = Array.isArray(j.domains) ? j.domains : [];
  const activeRows = domains.filter((d) => d && d.state === "active");
  const active = activeRows.map((d) => String(d.hostname).toLowerCase()).sort();
  const primaryRow = activeRows.find((d) => d.primary === true);
  const primary = primaryRow ? String(primaryRow.hostname).toLowerCase() : null;
  return { active, primary };
}

/** Pure decision (#64, extended #42): given the CURRENT active hostnames, the locally stored
 *  preference, and the backend "primary" (if any), decide which branded hostname to use this run and
 *  whether the CLI needs to ask the human. Never throws. Rules, in order:
 *   - 0 active -> no branded link, no hint (nothing to choose from).
 *   - a backend PRIMARY that is active (#42) -> ALWAYS that one, no hint. It is the owner's explicit
 *     global choice (dashboard "Make primary"), so it wins over the local per-artifact preference and
 *     spares the agent from picking. An explicit per-run --default-domain override still wins over it
 *     (that path never reaches here). A non-active/absent primary is ignored, falling through below.
 *   - exactly 1 active -> ALWAYS that one, unconditionally — even overriding a stored "none" or a
 *     different previous pick. Never prompts.
 *   - 2+ active, no primary -> reuse the stored choice ONLY if the active set is UNCHANGED from the
 *     stored snapshot (order/case-independent) and the choice is still valid ("none", or a hostname
 *     still in the active set); otherwise a non-blocking hint listing the candidates (never a throw). */
export function resolveDomainSelection(activeHostnames, stored, primaryHostname) {
  const active = [...activeHostnames].map((h) => String(h).toLowerCase()).sort();
  if (active.length === 0) return { brandedHostname: null, hint: null };
  const primary = primaryHostname ? String(primaryHostname).toLowerCase() : null;
  if (primary && active.includes(primary)) return { brandedHostname: primary, hint: null };
  if (active.length === 1) return { brandedHostname: active[0], hint: null };

  const storedSnapshot = stored && Array.isArray(stored.defaultDomainSnapshot)
    ? [...stored.defaultDomainSnapshot].map((h) => String(h).toLowerCase()).sort()
    : null;
  const snapshotMatches = storedSnapshot !== null
    && storedSnapshot.length === active.length
    && storedSnapshot.every((h, i) => h === active[i]);

  if (snapshotMatches) {
    const def = stored && typeof stored.defaultDomain === "string" ? stored.defaultDomain.toLowerCase() : undefined;
    if (def === "none") return { brandedHostname: null, hint: null };
    if (def !== undefined && active.includes(def)) return { brandedHostname: def, hint: null };
  }
  return { brandedHostname: null, hint: { candidates: active } };
}

/** Validates a --default-domain value against the LIVE active set. "none" (any case) is always
 *  valid. Throws UploadError, listing the active alternatives, on anything else that isn't an active
 *  hostname. Returns the normalized value: "none" or a lowercased hostname. */
export function validateDefaultDomainChoice(choice, activeHostnames) {
  if (typeof choice !== "string" || !choice) throw new UploadError('--default-domain needs a hostname or "none".');
  if (choice.toLowerCase() === "none") return "none";
  const active = [...activeHostnames].map((h) => String(h).toLowerCase());
  const norm = choice.toLowerCase();
  if (!active.includes(norm)) {
    throw new UploadError(active.length
      ? `"${choice}" is not one of your active custom domains: ${active.join(", ")}. Pass "none" to skip a branded link.`
      : "You have no active custom domains to choose from yet.");
  }
  return norm;
}

/** Shared validate-and-build-patch step for an explicit --default-domain value (#64). Always fetches
 *  a FRESH active list (never trusts a stale snapshot) so a typo or a since-detached hostname is
 *  caught. Throws UploadError on any problem — callers decide whether that's fatal for them. */
async function overridePatch(apiOrigin, token, defaultDomainOverride, slug, fetchImpl) {
  const { active } = await fetchActiveDomains({ apiOrigin, token }, fetchImpl);
  const normalized = validateDefaultDomainChoice(defaultDomainOverride, active);
  // `slug` is undefined for the standalone call and for an edit that isn't ALSO changing the slug
  // (title-only, or --default-domain alone) — there's no PAT-reachable route to read an artifact's
  // EXISTING slug, so customDomainUrl can't be built yet even though configPatch below still saves
  // the preference. The branded link shows starting from the artifact's next publish/replace/slug edit.
  const customDomainUrl = normalized !== "none" && slug ? `https://${normalized}/${slug}/` : null;
  return { customDomainUrl, domainPrompt: null, configPatch: { defaultDomain: normalized, defaultDomainSnapshot: active } };
}

/** Standalone `--default-domain <hostname|none>` (no publish/--edit, #64): validate against a fresh
 *  domain list and hard-fail (throw) on any problem — validation IS the point of this call, so
 *  config is left untouched on failure. */
export async function setDefaultDomain(opts, fetchImpl) {
  const apiOrigin = normalizeOrigin(opts.apiOrigin);
  const patch = await overridePatch(apiOrigin, opts.token, opts.defaultDomainOverride, undefined, fetchImpl);
  return { defaultDomain: patch.configPatch.defaultDomain, configPatch: patch.configPatch };
}

/** Shared by uploadFiles (after finalize) and editArtifact (after a slug change or an explicit
 *  --default-domain, #64): resolve which branded URL, if any, to show this run.
 *   - defaultDomainOverride set: validated, but a failure is CAUGHT here (not thrown) — the publish
 *     or edit already succeeded, so a bad flag value must not look like the whole operation failed.
 *     Surfaces as `domainOverrideError` instead.
 *   - otherwise (passive per-publish lookup): a fetchActiveDomains failure is swallowed silently — a
 *     domains-list hiccup must never fail an already-finalized artifact. */
async function resolveDomainsForRun(opts, slug, fetchImpl) {
  const { apiOrigin, token, defaultDomain, defaultDomainSnapshot, defaultDomainOverride } = opts;
  if (defaultDomainOverride !== undefined) {
    try {
      return await overridePatch(apiOrigin, token, defaultDomainOverride, slug, fetchImpl);
    } catch (e) {
      return { customDomainUrl: null, domainPrompt: null, configPatch: null, domainOverrideError: (e && e.message) || String(e) };
    }
  }
  let active, primary;
  try {
    ({ active, primary } = await fetchActiveDomains({ apiOrigin, token }, fetchImpl));
  } catch {
    return { customDomainUrl: null, domainPrompt: null, configPatch: null };
  }
  const { brandedHostname, hint } = resolveDomainSelection(active, { defaultDomain, defaultDomainSnapshot }, primary);
  if (hint) return { customDomainUrl: null, domainPrompt: hint, configPatch: null };
  if (!brandedHostname) return { customDomainUrl: null, domainPrompt: null, configPatch: null };
  return {
    customDomainUrl: slug ? `https://${brandedHostname}/${slug}/` : null,
    domainPrompt: null,
    configPatch: { defaultDomain: brandedHostname, defaultDomainSnapshot: active },
  };
}

/**
 * Upload `files` ([{relativePath, size, body|readBody}]) as one artifact.
 * opts: { apiOrigin, token, files, title?, slug?, replace?, abandon?, visibility?, password?,
 * defaultDomain?, defaultDomainSnapshot?, defaultDomainOverride? } — `replace`/`abandon` are
 * existing artifact ids (replace = new version of it; abandon = reclaim a failed create draft);
 * `visibility`/`password` gate a CREATE before it goes live; passing either with `replace` throws
 * (gate a live artifact with setVisibility() AFTER this resolves). The `defaultDomain*` trio drives
 * branded-link resolution (#64), sourced from the local config file / --default-domain flag.
 * Returns { url, pathUrl, slug, artifactId, versionId, published, visibility, customDomainUrl,
 * domainPrompt, configPatch, domainOverrideError? }. Throws UploadError with the server's message
 * (on a create-path failure the thrown error carries `.artifactId` of the leftover draft).
 */
export async function uploadFiles(opts, fetchImpl) {
  const { token, files, title, slug, replace, abandon, visibility, password, defaultDomain, defaultDomainSnapshot, defaultDomainOverride } = opts;
  const apiOrigin = normalizeOrigin(opts.apiOrigin);
  validateArgs(opts);
  if (replace && visibility) {
    throw new UploadError("Set the visibility of a replaced artifact AFTER this resolves, with setVisibility(): it is already live, so gating it before the upload risks rotating its share password for a version that never ships.");
  }
  if (!files || !files.length) throw new UploadError("Nothing to upload: the folder has no files.");
  const auth = authHeaders(token);
  const jsonHeaders = authHeaders(token, true);
  const manifest = files.map((f) => ({ relativePath: f.relativePath, size: f.size }));

  let artifactId, versionId, slugOut;
  // The state the SERVER reported back, never the value we asked for — echoing the input would make
  // any assertion on it pass even with the whole setVisibility call removed.
  let serverResolvedVisibility = null;
  if (replace) {
    const j = await request(fetchImpl, apiOrigin + "/api/artifacts/" + encodeURIComponent(replace) + "/replace", {
      method: "POST", headers: jsonHeaders, body: JSON.stringify({ manifest }),
    });
    artifactId = replace;
    versionId = j.versionId;
    slugOut = j.slug;
  } else {
    const body = { manifest };
    if (title) body.title = title;
    if (slug) body.slug = slug;
    if (abandon) body.abandon = abandon; // reclaim the caller's own failed prior draft (server-side owner+status-scoped delete)
    const j = await request(fetchImpl, apiOrigin + "/api/artifacts/init", {
      method: "POST", headers: jsonHeaders, body: JSON.stringify(body),
    });
    artifactId = j.artifactId;
    versionId = j.versionId;
    slugOut = j.slug;
  }

  // PUTs are independent of each other (only init-before / finalize-after are ordered), so run a
  // small pool. Bodies come from `body` or a lazy `readBody()` (so only in-flight files sit in RAM).
  const PUT_CONCURRENCY = 4;
  let next = 0;
  let aborted = false;
  async function putWorker() {
    while (!aborted && next < files.length) {
      const f = files[next++];
      // Read the body first — a LOCAL read failure is reported as such (distinct from a transfer
      // failure). Both set `aborted` so siblings stop picking up the rest of a doomed bundle.
      let body;
      try {
        body = f.body !== undefined ? f.body : f.readBody ? f.readBody() : undefined;
        if (body === undefined) throw new Error("neither body nor readBody");
      } catch (e) {
        aborted = true;
        throw new UploadError("Could not read " + f.relativePath + ": " + String((e && e.message) || e));
      }
      try {
        await request(fetchImpl,
          apiOrigin + "/api/artifacts/" + artifactId + "/versions/" + versionId + "/files/" + encodePath(f.relativePath),
          { method: "PUT", headers: { ...auth, "content-length": String(bodyByteLength(body)) }, body },
        );
      } catch (e) {
        aborted = true;
        throw e; // already an UploadError (HTTP or transport), rethrown to stop the pool
      }
    }
  }
  try {
    // Nothing serves until finalize below, so the artifact goes live already closed (#92).
    if (visibility) {
      serverResolvedVisibility = (await setVisibility({ apiOrigin, token, artifactId, visibility, password }, fetchImpl)).visibility;
    }

    await Promise.all(Array.from({ length: Math.min(PUT_CONCURRENCY, files.length) }, putWorker));

    const fin = await request(fetchImpl,
      apiOrigin + "/api/artifacts/" + artifactId + "/versions/" + versionId + "/finalize",
      { method: "POST", headers: auth },
    );
    // Servers from v0.18 return the fully-qualified `url`; older ones only the bare subdomain host.
    // `published: false` = the version stored but the artifact is unpublished, so the link is dormant.
    const result = {
      url: fin.url || ("https://" + fin.subdomainUrl + "/"),
      pathUrl: fin.pathUrl || null, // null-safe: an older server (pre-#64) doesn't send an absolute one
      slug: fin.slug || slugOut,
      artifactId,
      versionId,
      published: fin.published !== false,
      // What the artifact was gated to before it went live, as the SERVER resolved it — null when
      // the caller asked for nothing.
      visibility: serverResolvedVisibility,
    };
    // resolveDomainsForRun's every return path already sets customDomainUrl/domainPrompt/configPatch
    // (see its own doc comment), so there's no default to spread in here first.
    const domainResolution = await resolveDomainsForRun(
      { apiOrigin, token, defaultDomain, defaultDomainSnapshot, defaultDomainOverride },
      result.slug, fetchImpl,
    );
    return { ...result, ...domainResolution };
  } catch (e) {
    // A failure after init leaves a draft behind (create path). Attach the id to WHATEVER was
    // thrown — including a transport-level TypeError from the finalize fetch, which is exactly when
    // the draft is most certainly orphaned — so the caller can report it and pass it back as
    // `abandon` on the retry for the server to reclaim.
    if (!replace && artifactId && e && typeof e === "object") {
      try { e.artifactId = artifactId; } catch { /* frozen error object: nothing to attach to */ }
    }
    throw e;
  }
}

/**
 * Rename and/or change the slug of an already-published artifact, and/or set its --default-domain
 * preference — no re-upload (#60, #64).
 * opts: { apiOrigin, token, artifactId, title?, slug?, defaultDomain?, defaultDomainSnapshot?,
 * defaultDomainOverride? }. At least one of title/slug/defaultDomainOverride is required. Sequenced
 * title-first, slug-second: if the slug call fails after the title already committed, the thrown
 * error carries `.partial.title` so the caller can report the partial success instead of implying
 * nothing happened.
 * Returns { artifactId, title?, slug?, url?, pathUrl?, published?, customDomainUrl?, domainPrompt?,
 * configPatch?, domainOverrideError? } — the domain-resolution fields (#64) are only present when
 * the slug changed or an explicit --default-domain was passed; a title-only edit with no domain
 * override returns exactly {artifactId, title} as before. KNOWN GAP: an edit that resolves a domain
 * WITHOUT also changing the slug (a title-only edit + --default-domain, or --default-domain alone)
 * has no route to read the artifact's EXISTING slug, so `configPatch` still saves the preference but
 * `customDomainUrl` stays null this run — the branded link only appears starting from the artifact's
 * next publish/replace or slug edit. Closing that gap needs a new PAT-reachable single-artifact read
 * route; out of scope here. published:false means the new link is dormant — not live yet.
 */
export async function editArtifact(opts, fetchImpl) {
  const { token, artifactId, title, slug, defaultDomain, defaultDomainSnapshot, defaultDomainOverride } = opts;
  // Self-validating, like uploadFiles' validateArgs(opts) call: any caller of the exported function
  // (not just upload.mjs's CLI branch) gets this error instead of a silent artifactId-only no-op.
  // Shares requireEditField with validateArgs' --edit branch so the two can't drift apart.
  requireEditField(title, slug, defaultDomainOverride !== undefined);
  const apiOrigin = normalizeOrigin(opts.apiOrigin);
  const jsonHeaders = authHeaders(token, true);
  const out = { artifactId };

  if (title !== undefined) {
    const j = await request(fetchImpl, apiOrigin + "/api/artifacts/" + encodeURIComponent(artifactId) + "/rename", {
      method: "POST", headers: jsonHeaders, body: JSON.stringify({ title }),
    });
    out.title = j.title;
  }
  if (slug !== undefined) {
    try {
      const j = await request(fetchImpl, apiOrigin + "/api/artifacts/" + encodeURIComponent(artifactId) + "/slug", {
        method: "POST", headers: jsonHeaders, body: JSON.stringify({ slug }),
      });
      out.slug = j.slug;
      out.url = j.url;
      out.pathUrl = j.pathUrl || null;
      out.published = j.published;
    } catch (e) {
      if (out.title !== undefined && e && typeof e === "object") {
        try { e.partial = { title: out.title }; } catch { /* frozen error object: nothing to attach to */ }
      }
      throw e;
    }
  }
  if (slug !== undefined || defaultDomainOverride !== undefined) {
    const domainResolution = await resolveDomainsForRun(
      { apiOrigin, token, defaultDomain, defaultDomainSnapshot, defaultDomainOverride },
      out.slug, fetchImpl,
    );
    Object.assign(out, domainResolution);
  }
  return out;
}
