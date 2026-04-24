# Tighten Public API Gate — Design Spec

**Date:** 2026-04-24
**Status:** Approved
**Owner:** tokenbrice

## Background

The `/_site-data/*` Cloudflare Pages Function lane is marketed in the UI ("FOR PHAROS.WATCH ONLY") and docs as restricted to browsers on `pharos.watch`. In practice it is fully public: the "origin guard" in `functions/lib/site-data-origin.ts:27` inspects `new URL(request.url).origin` — i.e. the request URL's own hostname, not the caller's `Origin` header — so every request to `pharos.watch/_site-data/*` passes by definition. Verified with live curl: foreign-origin, no-origin, and no-cookie requests all return 200 with full JSON payloads.

Separately, `api.pharos.watch/api/*` accepts unauthenticated traffic subject to a 300 req/min IP-salted bucket (`PUBLIC_API_RATE_LIMIT_MAX_REQUESTS` in `shared/lib/ops-limits.ts:4`). The default API-key tier is 120 rpm, so unauthenticated callers currently enjoy more headroom than keyed ones.

All known integrators already hold API keys. The public unauthenticated lane is providing no required utility and represents a surface worth closing.

## Goals

1. Make `/_site-data/*` genuinely same-site: reject requests whose `Origin` and `Referer` both fail the allowed-hostname check.
2. Make `api.pharos.watch/api/*` require a valid `X-API-Key` for every non-admin, non-site-proxy, non-telegram-webhook request. No unauthenticated fallback.
3. Remove the now-dead public rate-limit infrastructure (constants, env var, function, tests).

## Non-goals

- Tokenized/signed cookies, JWT, or any cryptographic per-session binding for the website lane. Header-based gating is sufficient for the stated intent; callers with forged headers already have a legitimate path (get a key).
- Redesigning the API-key quota tiers. The default tier (120 rpm) and min/max bounds are unchanged.
- Migration of the `rate_limits` D1 table. Rows for the public bucket become orphaned but cause no runtime issue; cleanup can be a separate, coordinated rollout.
- Staged rollout / deprecation headers. User decision: hard cutover.

## Architecture

Three lanes exist after this lands. Each has a single enforcement point.

### Lane 1 — Website (`pharos.watch/_site-data/*`)

Cloudflare Pages Function at `functions/_site-data/[[path]].ts`.

Gate logic (replacing the current `url.origin` no-op in `functions/lib/site-data-origin.ts`):

```
allowed_hostnames = { SITE_HOSTNAME, OPS_UI_HOSTNAME, PAGES_APP_HOSTNAME (incl. *.pages.dev subdomains) }

origin_header  = request.headers.get("Origin")   // browser sends on cross-origin and some same-origin cases
referer_header = request.headers.get("Referer")  // browser sends on navigations and most fetches

if origin_header present:
  hostname_matches = hostname(origin_header) ∈ allowed_hostnames
  if NOT hostname_matches: return 404
  (if origin matches, accept regardless of referer)
else if referer_header present:
  if hostname(referer_header) ∉ allowed_hostnames: return 404
else:
  return 404   // neither header → not a real browser session, reject
```

Notes:
- `Origin` wins when present. A matching `Origin` + mismatched `Referer` still passes (some browsers / privacy extensions strip Referer).
- Absent-both → reject. Rationale: browsers doing any dynamic fetch emit at least one. Naïve curl / scripts emit neither.
- Response is `404 Not Found`, not `401`. Matches existing convention and doesn't advertise the path's existence.
- `isPagesAppHostname(url.hostname)` shortcut in the current code (allowing preview deploys on `*.pages.dev`) is preserved: if the request URL itself lands on a Pages preview hostname, we still accept without header checks, because preview previews don't have predictable `Origin`/`Referer`.
- Method restriction (GET only, 405 otherwise) is preserved.
- Allowlisted-path check (only GET endpoints from `ENDPOINT_DEFINITIONS`) is preserved.
- Server-injected `X-Pharos-Site-Proxy-Secret` forwarding to the site-api upstream is preserved.

### Lane 2 — Partner API (`api.pharos.watch/api/*`)

Cloudflare Worker, gated in `worker/src/handlers/http/gates.ts:evaluateAccessGate`.

Current logic has three sub-paths for `/api/*`: protected-route-with-key, protected-route-without-key (respecting `publicApiAuthMode`), and open routes. The open-route sub-path further consumes the public IP rate-limit bucket before returning.

New logic: **one path.** Every `/api/*` request that is not admin, not site-api, not telegram-webhook, and not a preview-with-site-proxy-credential must present a valid `X-API-Key`. Missing or invalid → `401 Unauthorized`.

Specifically:

- The `getPublicApiAccess(url.pathname)` branching is removed. The `publicApiAccess === "protected"` vs implicit-open distinction collapses.
- `resolvePublicApiAuthMode` is removed; there is no longer an `off`/`report-only`/`enforce` spectrum.
- The `checkPublicApiRateLimit` call, `resolvePublicApiRateLimitSalt`, and the IP-resolution helper `resolveClientIp` are removed from `gates.ts`. Per-key rate limiting via `checkApiKeyRateLimit` remains and becomes the only rate-limit path for `/api/*`.
- `/api/telegram-webhook` early-return at `gates.ts:95` is preserved (separate auth).
- `OPTIONS` preflights continue to pass through for CORS; the current CORS handler upstream is not modified.

### Lane 3 — Admin / site-api / site-proxy-credentialed previews

Unchanged:

- Admin credential → pass (`gates.ts:68-71`).
- `SITE_API_HOSTNAME` host + valid `X-Pharos-Site-Proxy-Secret` → pass with `requestLane: "site-api"` (`gates.ts:74-89`).
- Preview request with site-proxy credential hitting a `/api/*` site-data-allowed path → pass (`gates.ts:91-93`).

### Pages-to-worker fallback removal

`functions/lib/site-api-env.ts` exposes `resolveSiteApiOrigin(env, { allowPublicApiFallback })` and `resolveSiteDataUpstreamLane(env, ...)`. The `allowPublicApiFallback` branch exists so that if `SITE_API_ORIGIN` is unset, the Pages Function can fall back to the public API origin. After this change the public API lane returns 401 without a key, so that fallback would hard-fail anyway.

Decision: delete the `allowPublicApiFallback` path and the runtime-policy flag in `resolveSiteDataProxyRuntimePolicy`. The site-data proxy is configured to hit site-api or it returns 500 at startup (the existing `site-api-origin-missing` env-issue code already produces a 500 in this case).

## Data flow

```
Browser on pharos.watch
  → pharos.watch/_site-data/<path>                          (Pages)
    → [hostname-of-Origin-or-Referer ∈ allowed?] — no → 404
    → [path in ENDPOINT_DEFINITIONS GET allowlist?] — no → 404
    → fetch site-api.pharos.watch/api/<path> with X-Pharos-Site-Proxy-Secret
      → [hostname === SITE_API_HOSTNAME && valid site-proxy secret && GET && allowed path] → 200
    ← response (cache-respecting)
  ← response

External integrator
  → api.pharos.watch/api/<path> with X-API-Key: <valid>     (Worker direct)
    → [key valid?] — no → 401
    → [key's per-minute quota under limit?] — no → 429
    → route to handler → 200

External anonymous caller
  → api.pharos.watch/api/<path>                              (Worker direct)
    → 401 Unauthorized
  → pharos.watch/_site-data/<path>                          (Pages)
    → 404 (no matching Origin/Referer)
```

## Error model

| Condition | Status | Body |
|---|---|---|
| `/_site-data/*` with mismatched/absent Origin+Referer | 404 | `{"error":"Not found"}` |
| `/_site-data/*` with unsupported method | 405 | `{"error":"Method not allowed"}`, `Allow: GET` |
| `/_site-data/*` with unknown path | 404 | `{"error":"Not found"}` |
| `/api/*` without `X-API-Key` | 401 | `{"error":"Unauthorized","message":"Valid X-API-Key required. Contact me@tokenbrice.com for access."}` |
| `/api/*` with invalid `X-API-Key` | 401 | same as above |
| `/api/*` with valid key exceeding quota | 429 | existing body (unchanged) |
| `/api/*` with valid key, DB unreachable | 503 | `publicApiUnavailableResponse()` (unchanged) |

The `Contact me@tokenbrice.com for access` copy is a minor UX improvement — integrators hitting 401 get a direct path to remediation rather than a bare "Unauthorized".

## Testing strategy

### Unit — `functions/__tests__/site-data-origin.test.ts`

New file (extracted from the proxy test for focus):

- allowed Origin, no Referer → pass
- absent Origin, allowed Referer → pass
- absent Origin, foreign Referer → 404
- foreign Origin, any Referer → 404
- allowed Origin, foreign Referer → pass (Origin wins)
- absent both → 404
- request hitting a Pages preview hostname (e.g. `xyz.pages.dev`) → pass without header check (preserves existing shortcut)

### Unit — `functions/__tests__/site-data-proxy.test.ts`

Update existing fixtures:
- Replace `Origin: https://pharos.watch` → `Origin: https://pharos.watch` (already matches allowed; confirm still passes).
- Add test: absent-both rejects.
- Remove any test that relied on the `url.origin` no-op passing foreign callers.

### Unit — `worker/src/handlers/http/__tests__/gates.test.ts` (new or extended)

- `/api/<any-path>` no `X-API-Key` → 401
- `/api/<any-path>` with valid key under quota → pass (200 after handler)
- `/api/<any-path>` with valid key over quota → 429
- `/api/<any-path>` with invalid key → 401
- `/api/telegram-webhook` no key → not blocked by access gate (passes to telegram handler)
- Admin credential bypass → unchanged
- Site-api-host request with valid site-proxy secret → unchanged

### Unit — `worker/src/__tests__/index.fetch.test.ts`

- Delete `PUBLIC_API_RATE_LIMIT_SALT` fixture entries.
- Flip assertions for unauthenticated `/api/*` from 200 to 401.

### Delete

- `worker/src/lib/__tests__/rate-limit.test.ts` — file becomes empty after public tests removed; if the file only tested public rate limit, delete the file entirely.
- `worker/src/lib/__tests__/env.test.ts` — remove `resolvePublicApiRateLimitSalt` describe block.

### Type check

- `cd worker && npx tsc --noEmit`
- `npm run build` (Next.js)
- `npm run lint`
- `npm test`

### Post-deploy smoke (manual)

```bash
# Partner API — no key → 401
curl -s -o /dev/null -w "%{http_code}\n" https://api.pharos.watch/api/peg-summary
# expected: 401

# Partner API — with key → 200
curl -s -o /dev/null -w "%{http_code}\n" -H "X-API-Key: $KEY" https://api.pharos.watch/api/peg-summary
# expected: 200

# Site-data — no Origin/Referer → 404
curl -s -o /dev/null -w "%{http_code}\n" https://pharos.watch/_site-data/peg-summary
# expected: 404

# Site-data — allowed Origin → 200
curl -s -o /dev/null -w "%{http_code}\n" -H "Origin: https://pharos.watch" https://pharos.watch/_site-data/peg-summary
# expected: 200

# Site-data — allowed Referer only → 200
curl -s -o /dev/null -w "%{http_code}\n" -H "Referer: https://pharos.watch/some-page" https://pharos.watch/_site-data/peg-summary
# expected: 200

# Site-data — foreign Origin → 404
curl -s -o /dev/null -w "%{http_code}\n" -H "Origin: https://evil.example.com" https://pharos.watch/_site-data/peg-summary
# expected: 404
```

## Rollback

Single revert. The change touches no D1 migrations and introduces no new required env vars (it removes `PUBLIC_API_RATE_LIMIT_SALT`; re-adding the variable in wrangler.toml is trivial if reverted). Orphaned `rate_limits` rows for public buckets are harmless and naturally expire.

If a widespread integrator outage is observed post-deploy:

1. `git revert <commit>`
2. `npm run build && wrangler deploy` (worker) and Cloudflare Pages auto-redeploys.
3. Re-set `PUBLIC_API_RATE_LIMIT_SALT` secret if it was removed at the Cloudflare dashboard level (not just in code).

## Documentation updates

- `docs/api-reference.md` — front-matter: "All `/api/*` endpoints require a valid `X-API-Key` header. Contact me@tokenbrice.com to request one." Remove any reference to anonymous access or the 300 rpm public tier.
- `docs/architecture.md` — update the authentication/rate-limit section to describe one rate-limit path (per-key) and the header-gated site-data proxy.
- `docs/worker-and-api-limits.md` — remove the public-tier row; keep per-key defaults and bounds.
- `src/app/about/**` (if it mentions API access) — match the new reality.
- UI "Website lane" card — keep the copy intent but make it factually correct: same-origin lane; external consumers must use `api.pharos.watch/api/*` with a key.

## Open questions

None remaining. Intent and numbers are locked: hard cutover, header-based site gate (Origin primary, Referer fallback, neither → reject), no public unauthenticated API.
