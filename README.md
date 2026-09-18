# yarrtifacts agent skill

Lets an AI agent (Claude Code, Codex CLI, Gemini CLI, Cursor, and anything else that reads
[Agent Skills](https://agentskills.io)) publish a local folder or file as a shareable web page
on [yarrtifacts.com](https://yarrtifacts.com) and hand back the link. It can also push a new
version of an already published artifact, so the link you shared keeps working.

## Connect your account

Run `login`. It opens a page in your browser, you click Allow, and it saves a token locally. No
copy-pasting.

```bash
node skills/publish/scripts/login.mjs
```

The token is saved to `~/.config/yarrtifacts/config.json` and used automatically on every upload.
`login status` checks it's still good; `login logout` forgets it.

A token can only upload, replace, rename, delete, change the slug, or tighten the visibility of artifacts it owns.
Tightening is one-way: a token can make an artifact password-protected or private, but only the dashboard
can open one back up. Deleting is permanent and has no undo, so an agent should ask you before it does that.
Everything else, including domain setup, stays in the dashboard, where you can also revoke the token any time.

**CI or no browser?** Create a token in the dashboard (**API tokens** → Create token) and set it as
an environment variable — it takes precedence over the saved login:

```bash
export YARRTIFACTS_TOKEN=yarr_pat_…
```

## Install

**Claude Code** (as a plugin):

```
/plugin marketplace add yarrtifacts/skills
/plugin install yarrtifacts@yarrtifacts
```

**Any skills-compatible agent** via [skills.sh](https://skills.sh):

```bash
npx skills add yarrtifacts/skills
```

**Manual** — copy `skills/publish/` into your agent's skills directory:

| Agent | Directory |
|---|---|
| Claude Code | `~/.claude/skills/` or `<project>/.claude/skills/` |
| OpenAI Codex CLI | `~/.agents/skills/` or `<project>/.agents/skills/` |
| Gemini CLI | `~/.gemini/skills/` or `<project>/.gemini/skills/` |
| Others | see your agent's skills documentation |

## Use

Ask your agent to "publish this folder as an artifact". In Claude Code it is also a slash command,
and everything a publish needs fits on the one line:

```
/yarrtifacts:publish ./report "Q3 report" private
```

Or run it yourself:

```bash
node skills/publish/scripts/upload.mjs ./report --title "Q3 report"
# → https://q3-report.arrtifacts.com/
```

The published link opens in your browser automatically (it's skipped on a headless or SSH box).
Add `--no-open` to suppress it. Opening is best effort, so a machine with no browser still succeeds.

Update it later without changing the link:

```bash
node skills/publish/scripts/upload.mjs ./report --replace <artifactId>
```

Rename an artifact, or move its link, without re-uploading:

```bash
node skills/publish/scripts/upload.mjs --edit <artifactId> --title "New title"
node skills/publish/scripts/upload.mjs --edit <artifactId> --slug new-slug
```

Changing the slug moves the public link right away. The old one keeps working: it redirects to the
new address as long as the artifact is published and nobody else has claimed that slug. You can pass
both flags at once, but the rename lands first, so a slug that turns out to be taken leaves the new
title already applied.

Delete an artifact for good. Nothing brings it back, so an agent should ask you before it runs this:

```bash
node skills/publish/scripts/upload.mjs --delete <artifactId>
```

Once a custom domain is active, the branded link comes back automatically (a domain still waiting on
DNS gets skipped). If you have two or more, mark one as the primary in the dashboard and it's used
automatically everywhere — nothing to set here. Or pick which one the CLI uses by default per-run:

```bash
node skills/publish/scripts/upload.mjs --default-domain <hostname>
```

No Node.js? The REST flow is four curl calls — see
[`skills/publish/references/api.md`](skills/publish/references/api.md).

## Keeping agents off built-in artifact tools

Claude Code ships its own `Artifact` tool that publishes to claude.ai. With this plugin enabled, a
hook intercepts that tool and points the agent back at `yarrtifacts:publish`, so "publish this" lands
on your own domain. Reading existing claude.ai artifacts still works -- listing them, reading their
comments and their attached files -- because the redirect cannot answer those questions either,
and some of those artifacts are ones other people shared with you. Anything that writes to
claude.ai gets redirected: publishing, uploading a file to an artifact, replying to or resolving a
comment thread, and writing into a published page's own stored data.

The refusal arrives under a pirate flag, which is the plugin working, not something breaking.

If you want a claude.ai artifact now and then, start Claude Code with the opt-out set:

```bash
YARRTIFACTS_ALLOW_BUILTIN_ARTIFACT=1 claude
```

The hook reads the environment Claude Code launched with, so exporting the variable in another
terminal mid-session changes nothing. For a lasting opt-out put it in your settings instead, and
restart:

```json
{ "env": { "YARRTIFACTS_ALLOW_BUILTIN_ARTIFACT": "1" } }
```

Prefer the per-run form. A variable exported in a shell profile turns the redirect off in every
future session, and nothing announces that it happened.

To turn the built-in tool off completely, so the agent falls through to this skill on its own, add
one of these to your Claude Code settings:

```json
{ "disableArtifact": true }
```

```json
{ "permissions": { "deny": ["Artifact"] } }
```

A deny rule takes the tool out of the model's context entirely. To drop our hook instead, disable or
uninstall the plugin.

Other agents have no artifact tool to intercept, so there the skill description is the only lever.

## Limits

200 files, 95 MB per file, 200 MB per bundle. Browser-viewable file types only (HTML, Markdown,
code, text/data, images, SVG, fonts, PDF).
