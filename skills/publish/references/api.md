# yarrtifacts.com upload API

Base: `https://yarrtifacts.com`. Uploads carry `Authorization: Bearer <token>` — a personal access
token (`yarr_pat_…`). Get one either from the **API tokens** tab, or via the `login` pairing flow
below (which mints the same kind of token). Tokens can call the routes documented below (upload,
replace, rename, slug-edit, delete, and visibility in either direction); anything else answers
`403 {"error":"token scope"}` (except the two read-only routes: `GET /api/tokens/whoami` and
`GET /api/domains`).

## Visibility

`POST /api/artifacts/{artifactId}/visibility` with `{"visibility":"public"|"password"|"private"}`,
plus `"password":"…"` (min 8 chars) when setting `password`.
→ `200 { "ok": true, "visibility": "<new>", "previous": "<old>" }`. A token moves an artifact in
either direction; opening one up is the client's job to confirm with its user first. `previous` is
how a client tells a password rotation (`password → password`, which invalidates the secret viewers
already hold) from a first password. The password is hashed server-side (PBKDF2) and never readable
back.

**When creating**, call it between `init` and `finalize` if the artifact must never be public: it
exists but serves nothing in that window, so the state is in place the moment the link goes live.
After `finalize` the link is open until the call lands.

**When replacing**, call it *after* `finalize` instead. That artifact is already live and a new
version inherits the artifact's own visibility, so there is no open window to close — while gating
first would rotate its share password, killing the secret its viewers hold, for a version that may
still fail to upload. To close an artifact that is currently public and replace its content, close
it first, then replace.

## Delete

`POST /api/artifacts/{artifactId}/delete`, no body, `→ 200 {"ok":true}`. Owner-scoped: an id the
token's owner does not hold answers `404 {"error":"unknown artifact"}`, and so does one already
deleted, which makes a retry safe. The link stops serving at once and the stored bundle is wiped,
so this is not reversible. Rate-limited on the same per-owner budget as rename and slug-edit.

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
  "slug": "my-report",         // optional; omit for a random link
  "abandon": "<artifactId>" }  // optional; reclaims your own draft left behind by a failed create
```

→ `200 { "artifactId": "…", "versionId": "…", "slug": "…" }`

`size` must be the file's exact byte length — a PUT body materially larger than its declared
size is rejected. All files must be browser-viewable types (pages, Markdown, code, text/data,
images, SVG, fonts, PDF, audio, video, wasm). Limits: 200 files, 95 MB per file, 200 MB per bundle.

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
moves the public link immediately. The old one 301s to the new address while the artifact stays
published; if another artifact later claims that slug, it serves instead and the redirect stops.
Give the user the new link either way.

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
| 403 | `artifact limit` (`code: artifact_limit`) | Init or the first finalize on a free account whose one publication is spent. Deleting an artifact does not give it back; replace still works. |
| 400 | `bad manifest` / `bad entry` / `duplicate path: …` / `unsupported type: …` / `unsafe path: …` / `invalid slug` / `file too large` / `bundle too large` | Manifest problems at init (size caps checked against declared sizes return 400 here). |
| 409 | `slug taken` / `entry` / `still processing` / `version not writable` / `replace conflict` / `not editable` / `changed` / `recently used` / `unavailable` / `rename conflict` / `conflict` | Conflicts; `entry` = no clear entry point (add index.html); `changed` through `rename conflict` are rename/slug-edit conflicts; `conflict` = the visibility moved while your call was in flight, call again. |
| 413 | `file too large` / `size mismatch` / `bundle too large`, or `code: quota_exceeded` | Upload-time caps: a PUT body over 95 MB or beyond its declared size; a finalize whose stored bundle exceeds 200 MB. With `code: quota_exceeded` (init/replace) the account is out of storage and `error` is the sentence to show. |
| 503 | `kv update failed` / `kv invalidation failed` | A transient storage fault; the row is unchanged or already correct. Retry once. |
| 422 | `incomplete` | Some files never arrived; re-upload and finalize again. |
| 429 | `rate limited` | Per-owner/IP budget; honor `retry-after`. |
