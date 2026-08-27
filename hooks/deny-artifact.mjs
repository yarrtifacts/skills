#!/usr/bin/env node
/**
 * deny-artifact.mjs — PreToolUse hook wrapper (#74). Reads the hook payload on stdin, asks
 * deny-artifact-core.mjs what to do, and writes the decision as JSON on stdout.
 *
 * Exit status is always 0: Claude Code parses stdout JSON only on a clean exit, and exit 2 (the
 * stderr-based blocking path) would lose the structured permissionDecisionReason. Node >= 18, zero
 * dependencies, run via `node` because bash is not guaranteed on Windows.
 *
 * Everything here is written around one asymmetry: an empty stdout means ALLOW. So every way this
 * script can fail — a missing core, a core that stops exporting decide(), a core that throws,
 * unreadable stdin — has to end in a printed deny, never in a crash.
 */

/** Printed when the decision core can't be loaded or run. A publish to a third-party service is not
 *  something to wave through because our own plumbing broke. */
const FALLBACK_DENY = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason:
      "yarrtifacts: this hook could not load its decision core, so it is refusing the built-in Artifact tool " +
      "rather than letting a publish through by accident. Use the yarrtifacts:publish skill, and tell " +
      "the user their yarrtifacts plugin install looks damaged and is worth reinstalling.",
  },
};

function readStdin() {
  return new Promise((resolve) => {
    // Nothing piped in (someone ran the script by hand): don't block the tool call on a stream that
    // will never end. The core fails closed on the empty payload that results.
    if (process.stdin.isTTY) return resolve("");
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buf += chunk;
    });
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", () => resolve(buf));
  });
}

// Dynamic, not static: a failing static import aborts the module before any line below runs, and
// Node then exits non-zero having printed nothing — which Claude Code reads as "no opinion" and the
// Artifact call proceeds. A core that is missing, syntactically broken, or no longer exporting
// decide() must deny instead.
let decide = null;
try {
  const core = await import("./deny-artifact-core.mjs");
  if (typeof core.decide !== "function") throw new Error("deny-artifact-core.mjs exports no decide()");
  decide = core.decide;
} catch (err) {
  process.stderr.write(`deny-artifact: cannot load deny-artifact-core.mjs (${err?.message ?? err})\n`);
  process.stdout.write(JSON.stringify(FALLBACK_DENY));
}

if (decide) {
  let payload = null;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    payload = null; // unreadable input -> the core denies, which is the safe side for a publish tool
  }

  let decision;
  try {
    decision = decide(payload, process.env);
  } catch (err) {
    process.stderr.write(`deny-artifact: decide() threw (${err?.message ?? err})\n`);
    decision = FALLBACK_DENY;
  }

  // No process.exit() after the write: on a pipe that can truncate the JSON mid-flush, and a hook
  // whose output is cut in half is a hook that doesn't deny. Node exits 0 on its own once stdin ends.
  if (decision) process.stdout.write(JSON.stringify(decision));
}
