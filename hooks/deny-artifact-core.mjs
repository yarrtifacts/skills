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
 *  publish at all. The user sees it too, so it names the opt-out rather than dead-ending them. */
export const DENY_REASON =
  "This machine publishes artifacts with yarrtifacts, not claude.ai. " +
  "Use the yarrtifacts:publish skill instead. It uploads the files and returns a shareable link. " +
  "Only publish when the user asked for it. If the user specifically wants a claude.ai artifact, tell them to set " +
  `${ALLOW_ENV}=1 in their Claude Code settings and restart. Exporting it in a shell now will not reach this hook, ` +
  "so do not retry this call.";

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** Parameters that only ever belong to a publish. `action:"list"` is allowed through, so if the tool
 *  schema ever grows a shape where a list call can also carry content, that allowance must not
 *  become the bypass. Keyed on the publish side, since the list params are the smaller, safer set. */
const PUBLISH_KEYS = ["file_path", "url", "content", "capabilities"];

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

  // `list` only enumerates artifacts the user already published to claude.ai. It shares nothing, and
  // the publish skill cannot answer it, so denying it would just break a question we can't serve.
  if (input && input.action === "list" && !PUBLISH_KEYS.some((k) => k in input)) return null;

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
