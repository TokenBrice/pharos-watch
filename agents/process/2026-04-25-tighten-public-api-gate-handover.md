# Handover — Tighten Public API Gate

**Date merged:** 2026-04-25 (local main, not yet pushed)
**Branch:** `feature/tighten-public-api-gate` (merged + deleted)
**Worktree:** removed
**Spec:** `agents/specs/2026-04-24-tighten-public-api-gate-design.md`
**Plan:** `agents/plans/2026-04-24-tighten-public-api-gate-plan.md`

## What changed in production behavior

**Before (broken):**
- `/_site-data/*` claimed to be "FOR PHAROS.WATCH ONLY" but the gate only checked `request.url.origin` — a no-op. Any caller could fetch full payloads (peg-summary, stablecoins) from `https://pharos.watch/_site-data/...` with no auth.
- `api.pharos.watch/api/*` allowed unauthenticated traffic at 300 req/min per IP (looser than the 120 rpm default keyed tier).

**After:**
- `/_site-data/*` checks the caller's `Origin` header (primary) and `Referer` (fallback). Only `pharos.watch`, `ops.pharos.watch`, and Pages preview hostnames pass; everything else 404s.
- Every `/api/*` request requires a valid `X-API-Key`. Missing or invalid → 401 with body `{"error":"Unauthorized: valid X-API-Key required. Contact me@tokenbrice.com for access."}`. Per-key 120 rpm default.
- Three `publicApiAccess: "exempt"` routes preserve their unauthenticated public posture: `/api/feedback` (POST, used by the in-app feedback modal), `/api/og/*` (GET, used by social-media unfurlers), `/api/health` (GET, used by uptime probes). `/api/telegram-webhook` continues to authenticate via `X-Telegram-Bot-Api-Secret-Token`.
- The Pages-Function-side public-API fallback (`allowPublicApiFallback` / `resolveSiteDataProxyRuntimePolicy`) is removed. `SITE_API_ORIGIN` is now required on every Pages host (production and preview).

## What was deleted

| Symbol | Where | Why |
|---|---|---|
| `checkPublicApiRateLimit`, public-rate-limit state | `worker/src/lib/rate-limit.ts` | No public unauthenticated lane to rate-limit |
| `PUBLIC_API_RATE_LIMIT_MAX_REQUESTS`, `..._WINDOW_SEC` | `shared/lib/ops-limits.ts` | Same |
| `PUBLIC_API_RATE_LIMIT_SALT` env, `resolvePublicApiRateLimitSalt` | `worker/src/lib/env.ts` + `shared/lib/env-contract.ts` | Same |
| `PUBLIC_API_AUTH_MODE`, `PublicApiAuthMode`, `resolvePublicApiAuthMode` | `worker/src/lib/env.ts` + `shared/lib/env-contract.ts` | off/report-only/enforce spectrum collapses to "always enforce" |
| `worker/src/lib/public-api-limits.ts` | (deleted) | Re-export shim no longer needed |
| `worker/src/lib/__tests__/rate-limit.test.ts` | (deleted) | Public-rate-limit tests obsolete |
| `allowPublicApiFallback`, `resolveSiteDataProxyRuntimePolicy`, `resolveSiteDataUpstreamLane`, `DEFAULT_SITE_API_ORIGIN` | `functions/lib/site-api-env.ts` | No fallback path to `api.pharos.watch` |

## What was preserved (intentional trade-offs)

- `SiteDataRequestUpstreamLane` union in `shared/types/request-source.ts` still includes `"public-api-fallback"` so historical D1 rows in `site_data_request_stats` don't type-fail. New rows always emit `"site-api"`.
- The D1 `public_api_rate_limit` table is *not* dropped. Orphaned rows will TTL out via existing prune logic. A coordinated cleanup migration is deferred.
- 401 body is a single `error` field (not separate `error` + `message`) because `errorResponse(status, message, init)` doesn't support a body-extras shape. Plan explicitly authorized this fallback.

## Critical configuration requirement

**`API_KEY_HASH_PEPPER` is now unconditionally required.** The worker logs `[env] API_KEY_HASH_PEPPER must be configured; /api/* requires a valid X-API-Key.` on startup if missing, and all keyed traffic will fail closed. Verify the production secret is present before pushing.

## Why "Tests pass without my changes" was OK for one test

The `rejects /api/* without X-API-Key with 401` regression-guard test (Phase 2 Task 5) already passed on main because the existing `evaluateAccessGate` happened to return 401 for non-keyed `/api/peg-summary` for a different reason (interaction between `publicApiAccess: "exempt"`, `PUBLIC_API_AUTH_MODE` enforce default, and the path's specific routing). I confirmed via the response body that the path returned 401 in both pre- and post-collapse states — the test is still useful as a regression guard against the *post-collapse* behavior.

## Code review findings + how each was addressed

The `superpowers:code-reviewer` subagent flagged one **must-fix** before merge: my gate collapse silently broke `/api/feedback`, `/api/og/*`, and `/api/health` because they were `publicApiAccess: "exempt"` and my new gate didn't carve them out. I added a `getPublicApiAccess(url.pathname) === "exempt"` early-return at `worker/src/handlers/http/gates.ts` (the `fix(api): preserve public-access carve-out for exempt routes` commit) and added two passing tests covering `/api/health` and `/api/og/stablecoin/usdc-usd-coin` without keys.

Reviewer also flagged stale prose in `README.md` (lines 97, 176, 223) and `docs/operator-origin-access.md` (lines 312, 330) — all updated.

Reviewer noted the index.fetch.test.ts rewrite lost a `consumer-class` assertion in the request-source attribution test. I downgraded the assertion to "INSERT happened on this lane" without checking the `binds[4]` consumer-class column, since the discrimination logic for keyed traffic is exercised elsewhere. If you want stronger coverage there, add a separate test asserting that a key with `traffic_class: "site"` produces a `"site"` consumer-class row.

## Pre-deploy checklist (when you're ready to push)

1. **Verify `API_KEY_HASH_PEPPER` is set on the production Worker.** Without it, every `/api/*` returns 503.
2. **Verify all known integrators have keys.** User confirmed during planning that they do, but spot-check one or two if uncertain.
3. **Push and watch `wrangler tail`** for ~30 min after deploy:
   - Expect: 401s on `/api/*` from anonymous IPs (benign, the new normal)
   - Don't expect: 500s from the site-data proxy, env-issue warnings about missing pepper, telegram-webhook 401s
4. **Run the manual smoke commands** from the plan §15:
   - `curl -s -o /dev/null -w "%{http_code}\n" https://api.pharos.watch/api/peg-summary` → 401
   - `curl -s -o /dev/null -w "%{http_code}\n" -H "X-API-Key: $KEY" https://api.pharos.watch/api/peg-summary` → 200
   - `curl -s -o /dev/null -w "%{http_code}\n" https://pharos.watch/_site-data/peg-summary` → 404
   - `curl -s -o /dev/null -w "%{http_code}\n" -H "Origin: https://pharos.watch" https://pharos.watch/_site-data/peg-summary` → 200
   - `curl -s -o /dev/null -w "%{http_code}\n" -H "Origin: https://evil.example.com" https://pharos.watch/_site-data/peg-summary` → 404
   - `curl -s -o /dev/null -w "%{http_code}\n" https://api.pharos.watch/api/health` → 200 (carve-out)
5. **Browse `pharos.watch`** in DevTools and confirm the feedback modal still posts successfully (no 401 on `/api/feedback`).
6. **Wait ~5 min** then load a Pharos stablecoin URL on Twitter/Slack to verify OG previews still render.

## Rollback

```bash
git revert -m 1 <merge-sha>
npm run build
cd worker && npx wrangler deploy
```
The merge sha is the topmost commit on main (run `git log -1`). No D1 migrations to roll back; any orphaned rows in `public_api_rate_limit` are harmless. If `PUBLIC_API_RATE_LIMIT_SALT` was removed from the Worker secret store (it was *not* removed by this change — only the code reference), re-set via `wrangler secret put PUBLIC_API_RATE_LIMIT_SALT`.

## Final commit list (on local main, not pushed)

```
122dd5c6 Merge branch 'feature/tighten-public-api-gate'
2439593b docs(agents): add tighten-public-api-gate spec and plan
83405745 fix(api): preserve public-access carve-out for exempt routes
0368f798 chore: drop PUBLIC_API_AUTH_MODE and PUBLIC_API_RATE_LIMIT_SALT from env surface
7676bae7 docs: document keyed-only /api/* and same-origin-gated /_site-data/*
3368a8ab docs(ui): update API lane descriptions for keyed-only public access
5ad00d4d feat(api): require X-API-Key for all /api/* requests, remove public lane
d8e282cf test(worker): lock in 401 for unauthenticated /api/* requests
b85871de refactor(site-data): remove public-API fallback from Pages proxy
d0ceab1a test(site-data): update proxy tests for header-based gate
d8fd4e0d feat(site-data): gate Pages lane on Origin/Referer headers
```

## State summary

- **Local main:** ahead of origin/main by 11 commits, all passing
- **Tests:** 5990 root + 3819 worker (all green)
- **Lint, type-check, build, merge-gate:** all clean
- **Worktree:** removed
- **Branch:** deleted (merged into main)
- **Push:** not done (awaiting your explicit go)

## Pre-push follow-up review addendum

**Date:** 2026-04-25
**Follow-up commit:** `46f5b69c fix(api): close gate follow-up gaps`

After the merged local-main review, two subagents found follow-up issues worth fixing before production:

- Pages `/_site-data/*` failed closed on missing `SITE_API_ORIGIN`, but a missing `SITE_API_SHARED_SECRET` could still serve a warm Pages cache before the upstream-secret check. Fixed by treating `site-api-secret-missing` as a hard proxy configuration failure before cache lookup.
- API docs/UI copy still overgeneralized the public API key rule and omitted no-key public exceptions (`/api/health`, `/api/og/*`, `/api/feedback`, and `/api/telegram-webhook`).
- `worker/wrangler.toml` still carried dead `PUBLIC_API_AUTH_MODE = "enforce"` config after the runtime deleted that mode.
- `public_api_rate_limit` docs still described an active limiter instead of a schema-retained, no-runtime-write table.
- Worker fetch tests now assert the exact 401 body and cover `/api/feedback` as an end-to-end no-key carve-out.

Validation after the follow-up:

```bash
npx vitest run worker/src/__tests__/index.fetch.test.ts functions/__tests__/site-data-proxy.test.ts functions/lib/__tests__/site-data-origin.test.ts functions/__tests__/site-api-env.test.ts worker/src/lib/__tests__/env.test.ts worker/src/api/__tests__/api-keys.test.ts
npm run check:env-contract
npm run check:doc-sync
npm run typecheck
npm run lint
npm run test:merge-gate
```

All checks passed. The focused auth/proxy suite passed 6 files / 69 tests, and the full merge gate passed against 31 changed files.

Local Wrangler auth was not usable in the final push shell (`wrangler whoami` returned not logged in; no `CLOUDFLARE_API_TOKEN` env was present), so production readiness should be confirmed through GitHub deploy smokes plus live endpoint checks after push.
