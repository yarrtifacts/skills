/**
 * deny-artifact-core.mjs — the decision behind the plugin's PreToolUse hook (#74).
 *
 * Claude Code ships a built-in `Artifact` tool that publishes pages to claude.ai. On a machine with
 * this plugin installed that is the wrong destination, and agents reach for it anyway (sometimes
 * without being asked to publish at all). The hook denies those calls and hands the agent a reason
 * pointing at the publish skill instead.
 *
 * Pure and dependency-free so the product repo's test suite can exercise it directly, the same split
 * upload-core.mjs / login-core.mjs use; deny-artifact.mjs is the stdin/stdout wrapper around it.
 */

/** Env var a user sets when they genuinely want a claude.ai artifact, so the only way out of the
 *  hook isn't uninstalling the plugin. Named in the README and in DENY_REASON below. */
export const ALLOW_ENV = "YARRTIFACTS_ALLOW_BUILTIN_ARTIFACT";

/** Written for the agent that reads it: where to publish, which skill to call, and when not to
 *  publish at all. The user sees it too, so it names the opt-out rather than dead-ending them.
 *
 *  The pirate framing is deliberate (the product is Yarrtifacts, its mark is an anchor): a denial is
 *  the one moment the plugin interrupts someone, and a joke costs nothing there. Every instruction
 *  still has to survive being read literally by an agent, so the flag sits on top and the orders
 *  stay plain underneath. */
export const DENY_REASON =
  "🏴‍☠️ Yarr! Your artifact has been boarded.\n\n" +
  "This crew publishes to yarrtifacts, not to claude.ai. Use the yarrtifacts:publish skill " +
  "instead: it carries the files aboard and hands back a shareable link. Only publish when the user " +
  "asked for it, and do not raid unprompted. If the user really does want a claude.ai artifact, they set " +
  `${ALLOW_ENV}=1 in their Claude Code settings and restart. Exporting it in a shell now will not reach ` +
  "this hook, so do not retry this call.";

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** Per tool, the actions that READ something already on claude.ai and send it nothing. Denying those
 *  dead-ends a question instead of protecting anything: the publish skill cannot answer "what do the
 *  comments on this say" either, and the artifact may not even be the user's -- claude.ai lists ones
 *  other people shared with them. Read vs write is the line, not publish vs not: an action belongs
 *  here if it does not PUT anything on claude.ai -- no page, no file, no row, no subscription.
 *
 *  WHAT THIS HOOK IS NOT: a data-egress boundary. Every read action names what to read, and a name
 *  is a string an agent could fill with a document instead -- a `where` filter, a paging cursor, a
 *  collection path. Chasing that would end with an empty allowlist, and it would buy nothing: an
 *  agent set on sending bytes somewhere has Bash and a network. This hook decides WHERE published
 *  work lands, and the honest guarantee is the one above.
 *
 *  THE KEYS ARE THE WHOLE TOOL LIST, and keeping them current is the maintenance this file has.
 *  Claude Code has since split what used to be `Artifact` actions across top-level tools, and the
 *  deny only ever saw the first one — which is how README.md's promise that replying to a comment
 *  thread gets redirected quietly stopped being true. The matcher in hooks.json is a regex over the
 *  whole family so a new sibling reaches this function; a tool missing from this map is passed
 *  through, so a sibling that appears later is visible but unguarded until someone adds it.
 *
 *  The family is FOUR tools, not the three below. `ArtifactCheck` is the deliberate omission: its
 *  actions are `verify`, which reads an existing artifact's viewer diagnostics, and `preview`, which
 *  renders HTML locally into screenshots — neither uploads a page, a file, a row or a comment, so
 *  there is nothing here to redirect. Listing it with an empty allowance would deny a read tool and
 *  say nothing true. Checked against the shipped binary in September 2026, which is the only place
 *  this list exists; it moved from 2.1.274 to 2.1.276 during the hour it took to check, so treat
 *  every sentence above as perishable and re-read the tool schemas rather than this comment. */
/** Family members this file has looked at and deliberately has no opinion about, with the reason.
 *  Data, not prose, because `npm run check:artifact-tools` compares the live tool list against
 *  KNOWN_TOOLS = these keys plus READ_ONLY_ACTIONS', and a family member in neither is the drift.
 *  The actions are recorded too: "no opinion" is a judgement about THESE actions, so a passed-through
 *  tool that grows one has to reach a human the same way a new tool does. decide() lets these
 *  actions through and denies any other, so a new one is refused rather than waved by until then. */
export const PASSED_THROUGH = {
  ArtifactCheck: {
    actions: new Set(["verify", "preview"]),
    reason: "verify reads an artifact's viewer diagnostics and preview renders locally; neither uploads anything, so there is nothing to redirect",
  },
};

export const READ_ONLY_ACTIONS = {
  // Writes: publish (with `asset:true` it pushes a LOCAL FILE, a publish under another name),
  // delete, pin, unpin. `quickstart` is read-only but is step one of publishing, so it falls
  // through and the agent reads the redirect before it builds anything.
  Artifact: new Set(["list", "read", "open"]),
  // Writes: reply and resolve edit the vendor's copy. `watch` is absent because its name does not
  // settle it -- see the shape check in decide().
  ArtifactComments: new Set(["read"]),
  // A published page's own shared database. Writes: set, update, str_replace, delete, batch — and
  // `set`/`update` accept a local `file_path` whose contents are uploaded, which is this hook's
  // whole reason to exist arriving under a different tool name. get/list/query are its three reads
  // and all three are here; `query` was briefly held back because a `where` value is sent to the
  // server, until the same was true of `list`'s cursor and of the collection path itself — which is
  // the egress question this hook does not answer. See the header.
  ArtifactData: new Set(["get", "list", "query"]),
};

/** The other half of the same ledger: actions looked at and judged to WRITE. All but one are denied
 *  by falling through READ_ONLY_ACTIONS; `watch` is here because it writes in every form decide()
 *  refuses, and the bare form it allows is settled by the shape check below, not by this list.
 *  Denial needs no list to work (anything not allowed is denied), which is exactly why this exists:
 *  it records that somebody read what the action does. `npm run check:artifact-tools` reports any
 *  live action in NEITHER list, because that is an action nobody has classified yet, and guessing
 *  from a name is how `watch` -- which opens a server-side subscription -- reads as a read. */
export const KNOWN_WRITE_ACTIONS = {
  Artifact: new Set(["publish", "delete", "pin", "unpin", "quickstart"]),
  ArtifactComments: new Set(["reply", "resolve", "watch"]),
  ArtifactData: new Set(["set", "update", "str_replace", "delete", "batch"]),
};

/** Parameters that can carry a page, so their presence outranks whatever the call labels itself.
 *  The read allowance above is the one hole in an otherwise total deny and the schema it trusts is
 *  not ours; requiring the absence of these keeps a future schema change from widening it. `url`
 *  is deliberately NOT here -- it names which artifact to read and cannot carry content, and every
 *  read-only action except a bare `list` needs it. */
const PUBLISH_KEYS = ["file_path", "content", "capabilities"];

/**
 * Decide what to do with one PreToolUse payload.
 * @param {unknown} payload parsed hook input, or anything at all if stdin was unreadable
 * @param {Record<string, string | undefined>} env
 * @returns {null | {hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: string}}}
 *          null means "say nothing, let the call proceed".
 */
export function decide(payload, env = {}) {
  if (TRUTHY.has(String(env[ALLOW_ENV] ?? "").trim().toLowerCase())) return null;

  const p = payload && typeof payload === "object" ? /** @type {Record<string, unknown>} */ (payload) : null;

  // Only ever speak about the tools named above. The matcher in hooks.json is `Artifact.*`, an
  // UNANCHORED regex, which is wider on purpose -- a tool the vendor adds tomorrow reaches this
  // function instead of slipping past a matcher nobody remembered to update -- so THIS is the line
  // that keeps the hook from denying something it has no opinion about.
  const tool = p && typeof p.tool_name === "string" ? p.tool_name : null;
  const input = p && typeof p.tool_input === "object" && p.tool_input !== null ? /** @type {Record<string, unknown>} */ (p.tool_input) : null;

  // A passed-through tool is let by only for the actions somebody read. The release gate can only
  // see the tools the releasing session has, and ArtifactCheck is enabled per session, so a
  // publishing action added to it could reach customers with no release ever noticing. Anything
  // beyond the recorded actions falls through to the deny below, like an unknown action anywhere.
  const passed = tool !== null && Object.prototype.hasOwnProperty.call(PASSED_THROUGH, tool) ? PASSED_THROUGH[tool] : null;
  if (passed) {
    if (input && typeof input.action === "string" && passed.actions.has(input.action)) return null;
  } else if (tool !== null && !Object.prototype.hasOwnProperty.call(READ_ONLY_ACTIONS, tool)) return null;

  // A payload with no readable tool_name gets no read allowance at all: it reached a matcher that
  // only fires on these tools, so it is one of them with the name lost, and guessing which would be
  // guessing in the direction of allowing a publish.
  const readable = tool === null ? null : READ_ONLY_ACTIONS[tool];
  if (readable && input && typeof input.action === "string" && readable.has(input.action)
      && !PUBLISH_KEYS.some((k) => k in input)) return null;

  // The one action whose shape, not its name, decides. `watch` with no `url` lists the watches this
  // session already holds -- local bookkeeping that never leaves the machine. Name a `url` and it
  // opens a subscription on claude.ai; add `replies` and it re-arms automatic comment replies. So
  // the bare form is a read and the other two are not, and no allowlist keyed on the action name
  // alone can say that.
  if (tool === "ArtifactComments" && input && input.action === "watch"
      && !("url" in input) && !("replies" in input)) return null;

  // Everything else is a publish (the tool treats an omitted action as one), including a payload we
  // couldn't parse: an unreadable call to a publishing tool is not evidence that it was harmless.
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: DENY_REASON,
    },
  };
}
