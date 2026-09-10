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

/** Actions that READ an artifact already on claude.ai and send it nothing. Denying these dead-ends a
 *  question instead of protecting anything: the publish skill cannot answer "what do the comments on
 *  this say" either, and the artifact may not even be the user's -- claude.ai lists ones other people
 *  shared with them. Read vs write is the line, not publish vs not: `upload_asset` pushes a local
 *  file and is a publish under another name, `reply` and `resolve` write into the vendor's copy, and
 *  all three stay denied by falling through to the bottom of decide(). */
const READ_ONLY_ACTIONS = new Set(["list", "comments", "list_assets", "read_asset"]);

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

  // Only ever speak about the Artifact tool. The matcher already scopes us there, but a hook that
  // silently denied some other tool because a future matcher edit went wide would be a nasty bug.
  if (p && typeof p.tool_name === "string" && p.tool_name !== "Artifact") return null;

  const input = p && typeof p.tool_input === "object" && p.tool_input !== null ? /** @type {Record<string, unknown>} */ (p.tool_input) : null;

  if (input && typeof input.action === "string" && READ_ONLY_ACTIONS.has(input.action)
      && !PUBLISH_KEYS.some((k) => k in input)) return null;

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
