#!/usr/bin/env node
/**
 * publish CLI shell: walks a folder (or takes one file), then hands the wire work to
 * upload-core.mjs. Node >= 20 (global fetch and crypto), zero dependencies.
 *
 * Output contract for agents:
 *   success → artifactId line, then every resolved share link (subdomain, path, and branded custom
 *             domain if one resolved this run) — hand ALL of them to the user, not just one
 *   failure → the server's message on stderr, exit code 1
 */
import { readdirSync, statSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, basename, sep } from "node:path";
import { uploadFiles, editArtifact, deleteArtifact, validateArgs, UploadError, setDefaultDomain, setVisibility, validateVisibilityChoice, generateSharePassword, isVisibilityOnlyEdit } from "./upload-core.mjs";
import { resolveAuth, readConfig, updateConfig } from "./config.mjs";
import { maybeOpen } from "./browser.mjs";

// Mirrors the server's junk filter in src/shared/junk.ts (kept in sync by
// test/integration/agent-skill-contract.test.ts). SEGMENTS match any path segment (a file OR
// directory named .git / __macosx is dropped); BASENAMES match a FILE's name only (a directory
// named .ds_store is legitimate content the server keeps).
const JUNK_SEGMENTS = new Set([".git", "__macosx"]);
const JUNK_BASENAMES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);

function walk(root) {
  const out = [];
  const rootReal = realpathSync(root);
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const lower = name.toLowerCase();
      // A .git / __macosx segment is dropped whatever its type (matches the server).
      if (JUNK_SEGMENTS.has(lower)) continue;
      let st = lstatSync(p);
      if (st.isSymbolicLink()) {
        // Follow a FILE symlink ONLY if it resolves to a target still inside the chosen folder —
        // never publish files outside the folder the user pointed at (an attacker-planted
        // data.txt -> ~/.ssh/id_rsa in an untrusted checkout would otherwise be exfiltrated to a
        // public URL). Directory symlinks and out-of-tree / broken links are skipped LOUDLY.
        let real;
        try { real = realpathSync(p); } catch { console.error("skipping broken symlink: " + relative(root, p)); continue; }
        if (real !== rootReal && !real.startsWith(rootReal + sep)) { console.error("skipping symlink outside the folder: " + relative(root, p)); continue; }
        const target = statSync(p);
        if (!target.isFile()) { console.error("skipping symlinked directory: " + relative(root, p)); continue; }
        st = target;
      }
      if (st.isDirectory()) {
        stack.push(p);
      } else if (!JUNK_BASENAMES.has(lower)) {
        // Exact byte sizes are part of the API contract: the server rejects a body that
        // materially exceeds its declared manifest size. Bodies are read lazily at PUT time
        // (readBody) so a 200 MB bundle is never held in memory all at once.
        out.push({ relativePath: relative(root, p).split(sep).join("/"), size: st.size, readBody: () => readFileSync(p) });
      }
    }
  }
  return out;
}

const USAGE = "Usage: node upload.mjs <folder-or-file> [--title <t>] [--slug <s>] [--visibility public|password|private] [--password-stdin] [--replace <artifactId>] [--abandon <artifactId>] [--api <origin>] [--default-domain <hostname|none>] [--no-open]\n   or: node upload.mjs --edit <artifactId> [--title <t>] [--slug <s>] [--visibility public|password|private] [--password-stdin] [--api <origin>] [--default-domain <hostname|none>] [--no-open]\n   or: node upload.mjs --delete <artifactId> [--api <origin>]\n   or: node upload.mjs --default-domain <hostname|none> [--api <origin>]";

function parseArgs(argv) {
  const a = { open: true }; // a.api stays undefined unless --api is passed, so resolveAuth can fall back to the saved origin
  const rest = [];
  const val = (v) => { const x = argv[++i]; if (x === undefined) throw new UploadError("Missing value for " + v + "\n" + USAGE); return x; };
  let i = 0;
  for (; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--") { for (i++; i < argv.length; i++) rest.push(argv[i]); break; } // end-of-options: a path literally named --foo
    else if (v === "--title") a.title = val(v);
    else if (v === "--slug") a.slug = val(v);
    else if (v === "--replace") a.replace = val(v);
    else if (v === "--abandon") a.abandon = val(v);
    else if (v === "--edit") a.edit = val(v);
    else if (v === "--delete") a.delete = val(v);
    else if (v === "--api") a.api = val(v);
    else if (v === "--default-domain") a.defaultDomain = val(v);
    else if (v === "--no-open") a.open = false; // don't open the published link in the browser
    else if (v === "--visibility") a.visibility = validateVisibilityChoice(val(v));
    // DELIBERATELY no `--password <value>`: argv is world-readable via `ps` and lands in shell
    // history and agent session logs. Supply your own via stdin, or let the tool generate one.
    else if (v === "--password-stdin") a.passwordStdin = true;
    else if (v.startsWith("--")) throw new UploadError("Unknown flag: " + v + "\n" + USAGE);
    else rest.push(v);
  }
  a.dir = rest[0];
  return a;
}

/** The confirmation line for a resolved --default-domain value, shared by the standalone
 *  `--default-domain` path and the --edit path's configPatch-only fallback (#64) so the wording
 *  can't drift between the two. */
function formatDefaultDomainMessage(value) {
  return value === "none" ? "Default custom domain: none (no branded link by default)." : "Default custom domain set to " + value + ".";
}

/** Read one line from stdin without echoing it back anywhere (#83). Used for --password-stdin so a
 *  caller-chosen share password never appears in argv (visible to `ps`) or in shell history. */
function readPasswordFromStdin() {
  let raw = "";
  try {
    raw = readFileSync(0, "utf8"); // fd 0 — works for a pipe and for a heredoc
  } catch {
    throw new UploadError("--password-stdin was passed but nothing could be read from stdin.");
  }
  const pw = raw.split("\n")[0].replace(/\r$/, "");
  if (!pw) throw new UploadError("--password-stdin was passed but stdin was empty.");
  return pw;
}

/** Resolve the share password for --visibility password, in precedence order: stdin (explicit),
 *  the YARRTIFACTS_ARTIFACT_PASSWORD env var, else generate a strong one locally. Returns the
 *  password and whether we made it up (the caller must print a generated one exactly once). */
function resolveSharePassword(a) {
  if (a.passwordStdin) return { password: readPasswordFromStdin(), generated: false };
  const fromEnv = process.env.YARRTIFACTS_ARTIFACT_PASSWORD;
  if (fromEnv) return { password: fromEnv, generated: false };
  return { password: generateSharePassword(), generated: true };
}

/** Null when --visibility wasn't passed. Resolve before anything commits: reading a password from
 *  stdin can block and can fail. */
function resolveVisibilityRequest(a) {
  if (!a.visibility) return null;
  const needsPassword = a.visibility === "password";
  const { password, generated } = needsPassword ? resolveSharePassword(a) : { password: undefined, generated: false };
  return { visibility: a.visibility, password, generated };
}

const WHO_CAN_OPEN = { public: "anyone with the link", password: "anyone with the link and the password", private: "only you, signed in" };

/** The server keeps only a hash, so a generated password reaches stdout here or never. `previous`
 *  (an --edit or --replace gate) names the move, and tells a password rotation from a first password:
 *  the wire call is the same, but a rotation kills the secret viewers already hold. */
function reportVisibility(req) {
  if (!req) return;
  if (req.visibility === "password") {
    console.log("password: " + req.password);
    console.error(req.previous === "password"
      ? "Share password replaced; the old one no longer opens the artifact. It cannot be shown again."
      : req.generated
        ? "A share password was generated. Give it to the people who should see this artifact — it cannot be shown again."
        : "Share password set. It cannot be shown again.");
  }
  const move = req.previous && req.previous !== req.visibility ? ", was " + req.previous : "";
  console.error("Visibility: " + req.visibility + move + " (" + WHO_CAN_OPEN[req.visibility] + ").");
}

/** Gate an artifact that is already live: `--edit`, and `--replace` once its content has shipped. */
async function applyVisibility(req, ctxIds) {
  if (!req) return;
  const { token, apiOrigin } = ctxIds;
  const out = await setVisibility({ apiOrigin, token, artifactId: ctxIds.artifactId, visibility: req.visibility, password: req.password }, fetch);
  reportVisibility({ ...req, visibility: out.visibility, previous: out.previous });
}

/** Prints the non-blocking "ambiguous default domain" hint to stderr — never called on a failure
 *  path, always alongside a SUCCESSFUL publish/edit's own output (#64). */
function printDomainHint(prompt) {
  if (!prompt) return;
  console.error("Multiple custom domains are set up and none is chosen as a default yet (or the list changed):");
  for (const host of prompt.candidates) console.error("  - " + host);
  console.error('Ask the user which one to use as the default branded link (or "none"), then re-run with --default-domain <hostname-or-none> to save the choice and add the branded link next time.');
}

async function main() {
  // Out here so the catch below can tell "nothing shipped" from "only the gate failed".
  let publishedArtifactId = "";
  try {
    const a = parseArgs(process.argv.slice(2));
    const cfg = readConfig() || {};
    const domainOpts = { defaultDomain: cfg.defaultDomain, defaultDomainSnapshot: cfg.defaultDomainSnapshot, defaultDomainOverride: a.defaultDomain };

    // Standalone --default-domain (#64): NO other flag at all — just set the preference and exit.
    // A narrower guard (e.g. just !a.dir && !a.edit) would let a mistyped `--replace <id>
    // --default-domain host` or `--title "" --default-domain host` (folder omitted) silently take
    // this branch instead of hitting the usual "missing folder" error, quietly dropping the
    // create/replace/rename the caller actually asked for. Presence checks, not truthiness — an
    // explicit --title "" is a real request (see requireEditField above), not "not provided".
    if (a.defaultDomain !== undefined && !a.dir && !a.edit && !a.delete && !a.replace && !a.abandon && a.title === undefined && a.slug === undefined && a.visibility === undefined) {
      const { token, apiOrigin } = resolveAuth(a.api);
      if (!token) throw new UploadError("Not connected. Run `node login.mjs` to connect your account, or set YARRTIFACTS_TOKEN.");
      const out = await setDefaultDomain({ apiOrigin, token, defaultDomainOverride: a.defaultDomain }, fetch);
      updateConfig(out.configPatch);
      console.log(formatDefaultDomainMessage(out.defaultDomain));
      return;
    }

    // --delete: take an artifact down for good. Checked before every other mode so a stray flag
    // can't turn a deletion into a publish; validateArgs rejects the combination outright.
    if (a.delete) {
      validateArgs(a);
      const { token, apiOrigin } = resolveAuth(a.api);
      if (!token) throw new UploadError("Not connected. Run `node login.mjs` to connect your account, or set YARRTIFACTS_TOKEN.");
      await deleteArtifact({ apiOrigin, token, artifactId: a.delete }, fetch);
      console.log("deleted: " + a.delete);
      return;
    }

    // --edit (#60): rename/re-slug an already-published artifact, no re-upload, no folder walk.
    if (a.edit) {
      const { token, apiOrigin } = resolveAuth(a.api);
      if (!token) throw new UploadError("Not connected. Run `node login.mjs` to connect your account, or set YARRTIFACTS_TOKEN.");
      validateArgs(a);
      // Before editArtifact: an empty --password-stdin must not abort with the slug already moved.
      const editVis = resolveVisibilityRequest(a);
      // --visibility ALONE (#83) is a complete edit on its own, and editArtifact has nothing to do
      // for it (it only moves title/slug/default-domain). Calling it anyway would trip its own
      // "nothing to edit" guard, so handle this case here and skip the pointless round trip.
      if (isVisibilityOnlyEdit(a)) {
        console.log("artifactId: " + a.edit);
        await applyVisibility(editVis, { token, apiOrigin, artifactId: a.edit });
        return;
      }
      const out = await editArtifact({ apiOrigin, token, artifactId: a.edit, title: a.title, slug: a.slug, ...domainOpts }, fetch);
      if (out.configPatch) updateConfig(out.configPatch);
      if (out.url && out.published === false) console.error("Note: this artifact is unpublished, so the new link is dormant. Publish it in the dashboard to make it live (a free link that has expired needs a plan first).");
      // artifactId first, then: a title-only edit has no URL (last lines stay "artifactId: …"); a
      // slug change prints every resolved link — subdomain, path, and branded if one resolved.
      console.log("artifactId: " + out.artifactId);
      if (out.title !== undefined) console.error("Renamed.");
      if (out.url) {
        console.log(out.url);
        if (out.pathUrl) console.log(out.pathUrl);
        if (out.customDomainUrl) console.log(out.customDomainUrl);
      } else if (out.configPatch) {
        // An edit that didn't change the slug (title-only, or --default-domain alone) has no route
        // to read the artifact's EXISTING slug, so there's no branded link to print THIS run even
        // though --default-domain resolved and saved the preference — say so, or it looks like a
        // no-op. It'll show starting from this artifact's next publish/replace/slug edit.
        console.log(formatDefaultDomainMessage(out.configPatch.defaultDomain));
      }
      printDomainHint(out.domainPrompt);
      if (out.domainOverrideError) console.error("Note: --default-domain not saved: " + out.domainOverrideError);
      await applyVisibility(editVis, { token, apiOrigin, artifactId: out.artifactId });
      // A slug change moved the link — open it (a title-only / default-domain-only edit has no
      // out.url, so maybeOpen no-ops). Never open a dormant (unpublished) link. Best-effort (#75).
      if (out.published !== false) maybeOpen(out, { open: a.open });
      return;
    }
    if (!a.dir) throw new UploadError(USAGE);
    // Token + origin, coherently (env token → prod; config token → its saved origin; --api wins).
    const { token, apiOrigin } = resolveAuth(a.api);
    if (!token) throw new UploadError("Not connected. Run `node login.mjs` to connect your account, or set YARRTIFACTS_TOKEN.");
    validateArgs(a);
    const st = statSync(a.dir);
    const files = st.isDirectory()
      ? walk(a.dir)
      : [{ relativePath: basename(a.dir), size: st.size, readBody: () => readFileSync(a.dir) }];
    const vis = resolveVisibilityRequest(a);
    // uploadFiles refuses replace+visibility: a live artifact is gated after its content ships.
    const gateNow = a.replace ? {} : { visibility: vis?.visibility, password: vis?.password };
    const out = await uploadFiles({ apiOrigin, token, files, title: a.title, slug: a.slug, replace: a.replace, abandon: a.abandon, ...gateNow, ...domainOpts }, fetch);
    publishedArtifactId = out.artifactId;
    if (out.configPatch) updateConfig(out.configPatch);
    if (!out.published) console.error("Note: this artifact is unpublished, so the link is dormant. Publish it in the dashboard to make it live (a free link that has expired needs a plan first).");
    // artifactId first (agents remember it for --replace), then every resolved link — subdomain,
    // path, and branded custom-domain if one resolved this run.
    console.log("artifactId: " + out.artifactId);
    console.log(out.url);
    if (out.pathUrl) console.log(out.pathUrl);
    if (out.customDomainUrl) console.log(out.customDomainUrl);
    printDomainHint(out.domainPrompt);
    if (out.domainOverrideError) console.error("Note: --default-domain not saved: " + out.domainOverrideError);
    if (a.replace) await applyVisibility(vis, { token, apiOrigin, artifactId: out.artifactId });
    else reportVisibility(vis && { ...vis, visibility: out.visibility ?? vis.visibility });
    // Open the published artifact in the browser (best link: branded if it resolved, else subdomain).
    // Never open a dormant (unpublished) link. Best-effort — a failed launch never changes the exit
    // code, and it runs AFTER the links are printed so the agent's output is unaffected (#75).
    if (out.published !== false) maybeOpen(out, { open: a.open });
  } catch (e) {
    if (e && e.partial && e.partial.title !== undefined) {
      console.error(e.partial.title === null ? "Note: the title was already cleared." : "Note: the title was already changed to \"" + e.partial.title + "\".");
    }
    console.error(e instanceof UploadError ? e.message : String(e));
    if (e && e.artifactId) {
      console.error("A draft artifact was left behind (id " + e.artifactId + "). Add --abandon " + e.artifactId + " to your retry to reclaim it, or delete it in the dashboard.");
    }
    if (publishedArtifactId) console.error("The new version published; only the visibility change failed. Re-run `--edit " + publishedArtifactId + " --visibility …` to retry it.");
    process.exitCode = 1;
  }
}
main();
