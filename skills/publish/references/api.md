# yarrtifacts.com upload API

Base: `https://yarrtifacts.com`. Uploads carry `Authorization: Bearer <token>` — a personal access
token (`yarr_pat_…`). Get one either from the **API tokens** tab, or via the `login` pairing flow
below (which mints the same kind of token). Tokens can call the routes documented below (upload,
replace, rename, slug-edit, and visibility in the tightening direction only); anything else answers
`403 {"error":"token scope"}` (except the two read-only routes: `GET /api/tokens/whoami` and
`GET /api/domains`).

## Visibility

`POST /api/artifacts/{artifactId}/visibility` with `{"visibility":"public"|"password"|"private"}`,
plus `"password":"…"` (min 8 chars) when setting `password`. A token may only move an artifact to an
equal-or-stricter state — `public → password → private`, or a password rotation in place. A request
that would widen access answers `403 {"error":"token scope"}` naming the dashboard; the row is not
touched. The password is hashed server-side (PBKDF2) and never readable back.

**When creating**, call it between `init` and `finalize` if the artifact must never be public: it
exists but serves nothing in that window, so the state is in place the moment the link goes live.
After `finalize` the link is open until the call lands.

**When replacing**, call it *after* `finalize` instead. That artifact is already live and a new
version inherits the artifact's own visibility, so there is no open window to close — while gating
first would rotate its share password, killing the secret its viewers hold, for a version that may
still fail to upload. To close an artifact that is currently public and replace its content, close
it first, then replace.

## Login (device pairing)

Instead of pasting a token, the CLI can pair with the browser (no cookies needed on these routes):

```
POST /api/pairings/start        { "name": "my laptop" }   (optional)
→ 200 { "deviceCode": "yarr_dc_…", "userCode": "WXYZ-2345",
        "verificationUri": "https://yarrtifacts.com/link",
        "verificationUriComplete": "https://yarrtifacts.com/link?code=WXYZ-2345",
        "expiresIn": 600, "interval": 5 }
```

Show/open `verificationUriComplete`; the owner (signed into the dashboard) compares `userCode` and
clicks Allow. Then poll:

```
POST /api/pairings/poll         { "deviceCode": "yarr_dc_…" }
→ 200 { "status": "pending" | "slow_down" | "denied" | "expired" | "limit"
        | "approved", "token": "yarr_pat_…", "tokenName": "my laptop" }
```

Poll no faster than `interval` seconds (a faster poll returns `slow_down`). The **first** poll after
approval returns the token exactly once, then the pairing is gone. `login status` calls
`GET /api/tokens/whoami` (200 = the token still resolves, 401 = revoked).

## Upload

## 1. Init

```
POST /api/artifacts/init
Content-Type: application/json

{ "manifest": [ { "relativePath": "index.html", "size": 1234 }, … ],
  "title": "My report",        // optional
  "slug": "my-report" }        // optional; omit for a random link
```

→ `200 { "artifactId": "…", "versionId": "…", "slug": "…" }`

`size` must be the file's exact byte length — a PUT body materially larger than its declared
size is rejected. All files must be browser-viewable types (pages, Markdown, code, text/data,
images, SVG, fonts, PDF). Limits: 200 files, 95 MB per file, 200 MB per bundle.

## 2. Upload each file

```
PUT /api/artifacts/{artifactId}/versions/{versionId}/files/{path}
<raw file bytes>
```

`{path}` is the manifest's `relativePath` with each segment URI-encoded
(`img dir/a b.svg` → `img%20dir/a%20b.svg`). → `200 { "ok": true }`

## 3. Finalize

```
POST /api/artifacts/{artifactId}/versions/{versionId}/finalize
```

→ `200 { "url": "https://<slug>.arrtifacts.com/", "slug": "…", "versionId": "…",
         "pathUrl": "https://arrtifacts.com/a/<slug>/", "subdomainUrl": "<slug>.arrtifacts.com" }`

`url` is the shareable link.

## 4. Replace (new version, same link)

```
POST /api/artifacts/{artifactId}/replace
Content-Type: application/json

{ "manifest": [ … ] }
```

→ `200 { "versionId": "…", "slug": "…" }` — then repeat steps 2 and 3 with the new `versionId`.
`title`/`slug` are ignored here; see step 5 below to rename or change the link.

## 5. Edit (rename / change the link, no re-upload)

```
POST /api/artifacts/{artifactId}/rename
Content-Type: application/json

{ "title": "New title" }
```

→ `200 { "title": "…" }`

```
POST /api/artifacts/{artifactId}/slug
Content-Type: application/json

{ "slug": "new-slug" }
```

→ `200 { "slug": "…", "url": "https://<newSlug>.arrtifacts.com/",
         "pathUrl": "https://arrtifacts.com/a/<newSlug>/", "published": true }`

`published: false` means the link is dormant (the artifact isn't published) — check it before
telling the user the new link is live.

Call either or both — they're independent requests, not one atomic operation. Changing the slug
moves the public link immediately; the old one 404s and can be claimed by another artifact after a
short cooldown, so warn the user before changing a link they've already shared.

## Custom domains

```
GET /api/domains
```

→ `200 { "domains": [ { "id": "…", "hostname": "brand.example.com", "state": "active", "primary": true, "dns": … }, … ] }`

Token-reachable, read-only, scoped to the caller's own owner. `state` is one of
`pending_dns`/`active`/`failed`/`detaching`; only `active` domains serve a working link, at
`https://<hostname>/<slug>/`. `primary` (#42) marks the ONE domain the owner chose in the dashboard
as their canonical link; when an active domain has `primary: true`, use it as the branded host and
skip prompting — the owner already decided. If no active domain is primary, fall back to the local
`--default-domain` preference (one active domain is used automatically; 2+ prompts for a pick).
Attaching, detaching, and choosing the primary are all dashboard-only (session, not token).

## Errors

Every error is JSON: `{ "error": "<code>", "message": "<human text>" }` (`message` may be
absent). Show `message`, falling back to `error`, falling back to the HTTP status.

| Status | error | Notes |
|---|---|---|
| 401 | `invalid token` | Unknown or revoked token. |
| 403 | `token scope` | Route outside the ones documented above. |
| 400 | `bad manifest` / `bad entry` / `duplicate path: …` / `unsupported type: …` / `unsafe path: …` / `invalid slug` / `file too large` / `bundle too large` | Manifest problems at init (size caps checked against declared sizes return 400 here). |
| 409 | `slug taken` / `entry` / `still processing` / `version not writable` / `replace conflict` / `not editable` / `changed` / `recently used` / `unavailable` / `rename conflict` | Conflicts; `entry` = no clear entry point (add index.html); the last five are rename/slug-edit conflicts. |
| 413 | `file too large` / `size mismatch` / `bundle too large` | Upload-time caps: a PUT body over 95 MB or beyond its declared size; a finalize whose stored bundle exceeds 200 MB. |
| 422 | `incomplete` | Some files never arrived; re-upload and finalize again. |
| 429 | `rate limited` | Per-owner/IP budget; honor `retry-after`. |
