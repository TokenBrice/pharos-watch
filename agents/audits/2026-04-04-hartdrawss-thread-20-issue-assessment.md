# Hartdrawss Thread 20-Issue Assessment

Date: April 4, 2026

Source thread:
- https://x.com/Hartdrawss/status/2039998901176897860

Scope:
- Repo-reviewed against the checked-in `stablecoin-dashboard` codebase and docs.
- No code changes were made.
- One focused sub-agent was used per thread issue, in waves due a 6-agent concurrency cap.
- Live runtime verification was performed only where it materially affected the verdict, most notably plain-HTTP behavior on production hosts on April 4, 2026.

Status legend:
- `Not applicable`: the product/runtime does not expose that class of surface in the checked-in architecture.
- `Mitigated`: the repo has a concrete control that addresses the issue class.
- `Conditional`: safe if the documented Cloudflare/runtime posture is enforced; risky if that external posture drifts.
- `Partial`: there is a real gap or leak, but narrower than the thread’s generic warning.

## Executive Summary

Most of the thread does not map cleanly onto Pharos because this product has no end-user account system, no password store, no upload surface, and no self-hosted database/server process. The repo’s real attack surface is the Cloudflare-hosted API and ops lanes, not a typical “vibe-coded SaaS auth” stack.

The findings that should actually drive remediation planning are:
- `#17 No HTTPS enforcement`: open finding. As of April 4, 2026, `http://api.pharos.watch/api/health` and `http://site-api.pharos.watch/api/stablecoins` still answered over plain HTTP instead of redirecting to HTTPS.
- `#9 Error responses leaking internals`: open finding. Public `/api/health` and admin `/api/status` can surface raw exception text, including D1/SQLite table names.
- `#13 Missing auth middleware on internal API routes`: conditional finding. The Worker lanes are gated correctly, but the Pages admin proxy trusts Cloudflare Access on `ops.pharos.watch` and does not independently validate a UI Access JWT.
- `#12 Tokens never expire`: mixed finding. Cloudflare Access JWTs do expire, but several machine credentials are intentionally long-lived with rotation/deactivation rather than TTL.

Secondary hardening candidates:
- `#3 SQL concatenation`: no confirmed live SQL injection, but the repo’s SQL safety guard does not cover `worker/scripts/*` and some broader interpolation shapes.
- `#4 CORS wildcard`: not vulnerable to wildcard CORS, but disallowed origins currently fall back to the first allowlisted origin instead of omitting `Access-Control-Allow-Origin`.
- `#7` and `#18`: not classic app-auth bugs, but they reinforce the same ops-host trust-boundary issue as `#13`.

## Findings Matrix

| # | Thread issue | Assessment | Planning note |
| --- | --- | --- | --- |
| 1 | API keys hardcoded in frontend JS | Mitigated | No privileged key is embedded in browser code; the only plaintext key exposure is the intentional one-time admin reveal flow. |
| 2 | No rate limiting on `/login` | Not applicable | No repo-owned login surface exists; operator login is delegated to Cloudflare Access. |
| 3 | SQL built with string concatenation | Mitigated with hardening follow-up | Live request paths use bound params or allowlisted identifier interpolation; operator scripts deserve stricter guardrails. |
| 4 | CORS set to `*` | Mitigated | CORS is allowlisted, not wildcard; separate admin CSRF hardening still makes sense. |
| 5 | JWTs in `localStorage` | Mitigated | Browser storage is used for UI state only, not auth/session material. |
| 6 | Weak/default JWT secret | Not applicable to repo-owned auth | Admin JWTs are Cloudflare Access tokens verified against JWKS, not app-issued JWTs signed with a repo secret. |
| 7 | Admin routes protected only in frontend | Mitigated, with ops-host caveat | Worker/admin routes are server-gated, but the Pages admin proxy still trusts external Access posture. |
| 8 | `.env` committed to git | Mitigated in reachable local history | No tracked real env file or leaked env history was found in the reachable checkout. |
| 9 | Error responses leak stack traces / DB names | Partial | Generic handlers fail closed, but `/api/health` and `/api/status` can leak raw exception text. |
| 10 | File uploads lack MIME validation | Not applicable | No upload surface was found. |
| 11 | Passwords hashed with MD5/SHA1 | Not applicable | No password-based auth/store exists. |
| 12 | Auth tokens never expire | Partial / mixed | Cloudflare Access JWTs expire; machine credentials do not have repo-enforced TTL. |
| 13 | Missing auth middleware on internal API routes | Conditional | The Pages admin proxy lacks in-repo inbound Access/JWT validation and assumes Cloudflare Access is correctly enforced on `ops.pharos.watch`. |
| 14 | Server running as root | Not applicable | Production runtime is static Pages + Worker + D1, not a root-owned app server. |
| 15 | Database port exposed to internet | Not applicable | D1 is a bound serverless database, not a self-hosted DB listener. |
| 16 | IDOR on resource endpoints | Not applicable / not reproduced | Public resources are global analytics data; mutable numeric-id resources are operator-only. |
| 17 | No HTTPS enforcement | Partial / open | Production API lanes currently accept plain HTTP on at least two hosts. |
| 18 | Sessions not invalidated on logout | Not applicable in app-session sense, with ops-host caveat | There is no repo-managed session to revoke; logout is Cloudflare Access logout, but the Pages admin proxy still trusts external Access posture. |
| 19 | npm packages not audited since setup | Mitigated | Audits exist in CI, merge-gate, and a weekly scheduled workflow. |
| 20 | Open redirects in callback URLs | Mitigated | No user-controlled redirect sink was found; proxy redirects are handled manually and not relayed. |

## Priority Remediation Candidates

### P0

1. Enforce HTTPS redirects for `api.pharos.watch` and `site-api.pharos.watch` at the Cloudflare edge.
2. Add an HTTP smoke to the deploy path that asserts `301` or `308` for all production hosts.

### P1

1. Sanitize public `/api/health` warnings so raw exception text never reaches clients.
2. Sanitize admin `/api/status` `sectionErrors.*.message` for the same reason.
3. Align the root app error boundary with the safer production behavior already used by `src/components/page-error.tsx`.
4. Harden the Pages admin proxy by validating the UI-side Access JWT in-function and adding explicit CSRF/origin checks for mutating `/api/admin/*` routes.

### P2

1. Decide whether public API keys need finite expiry in addition to deactivate/rotate.
2. Formalize rotation policy for `SITE_API_SHARED_SECRET`, Pages service-token credentials, and the Telegram webhook secret.
3. Extend `scripts/check-sql-interpolation-safety.mjs` to cover `worker/scripts/*` and broader interpolation patterns.
4. Tighten CORS behavior for disallowed origins by omitting `Access-Control-Allow-Origin` instead of falling back to the first allowlisted origin.

## Detailed Notes For Actionable Findings

### Issue 9: Error Response Leakage

Current state:
- `worker/src/lib/api-utils.ts` fails closed for unhandled exceptions and returns generic `500`.
- The exception is the diagnostic path, not the general error wrapper.

Observed leak paths:
- Public `/api/health` returns `assessment.warnings`, and `worker/src/lib/public-health-assessment.ts` builds warning strings like `db-unhealthy: ${formatError(err)}`, `blacklist-query-failed: ${error}`, `mint-burn-query-failed: ${error}`, and `circuit-query-failed: ${error}`.
- Admin `/api/status` returns `sectionErrors`, and the status supplement/evaluation helpers copy raw `err.message` strings into those response fields.
- `src/app/error.tsx` renders `error.message` directly, while `src/components/page-error.tsx` already hides those details in production.

Why it matters:
- `/api/health` is publicly reachable.
- `/api/status` is admin-only, but it still discloses schema/runtime detail to any authenticated operator or any caller who reaches the ops proxy under misconfigured Access.

Planning direction:
- Replace raw messages in both endpoints with stable codes plus generic text.
- Keep raw exception text in logs only.
- Add regression tests for strings like `no such table`, `sqlite`, and stack-like content.

Key refs:
- `worker/src/api/health.ts`
- `worker/src/lib/public-health-assessment.ts`
- `worker/src/api/status.ts`
- `worker/src/api/status-supplements.ts`
- `worker/src/lib/status-evaluation.ts`
- `worker/src/lib/status-reliability-shared.ts`
- `src/app/error.tsx`
- `src/components/page-error.tsx`

### Issue 12: Long-Lived Auth Credentials

Current state:
- Cloudflare Access JWTs are checked for `exp`, `nbf`, `aud`, and `iss`.
- Public API keys are long-lived until deactivated or rotated; there is no `expires_at`.
- `SITE_API_SHARED_SECRET`, Pages `CF-Access-Client-*` service-token credentials, and `X-Telegram-Bot-Api-Secret-Token` are static secrets with no repo-enforced TTL.

Interpretation:
- If the thread item is interpreted narrowly as “session tokens never expire,” Pharos does not reproduce that bug for the admin/browser session path.
- If the item is interpreted more broadly as “auth credentials never expire,” there is real hardening work to consider for API keys and other machine credentials.

Planning direction:
- Decide whether API keys need finite lifetime in schema and admin UX.
- If not, explicitly document them as revocable long-lived credentials and formalize rotation expectations outside code.
- Validate Cloudflare Access session duration externally because that control lives in Zero Trust, not the repo.

Key refs:
- `worker/src/lib/auth.ts`
- `worker/src/lib/jwt-verify.ts`
- `worker/src/lib/api-keys.ts`
- `worker/migrations/0083_api_keys.sql`
- `functions/_site-data/[[path]].ts`
- `functions/api/admin/[[path]].ts`
- `worker/src/api/telegram-webhook.ts`

### Issue 13: Missing Auth Middleware On Internal Routes

Current state:
- Worker-side auth gates are real and coherent.
- The weak point is the Pages admin proxy, not the Worker.

What is good:
- `ops-api.pharos.watch` requires a valid `Cf-Access-Jwt-Assertion` before the Worker treats a request as admin.
- `site-api.pharos.watch` requires `X-Pharos-Site-Proxy-Secret` and allowlisted `GET` routes.
- Public protected API routes require `X-API-Key`.

What is risky:
- `functions/api/admin/[[path]].ts` only checks that the request is on the ops origin, then forwards it upstream with service-token credentials held in Pages env.
- `functions/lib/ops-env.ts` explicitly treats Pages-side UI Access validation as a future reserved feature, not an active control.
- The repo therefore assumes Cloudflare Access is correctly configured on `ops.pharos.watch`; if that assumption is wrong, the proxy is effectively fail-open.

Planning direction:
- Add in-function verification of the UI Access JWT on `/api/admin/*`.
- Add explicit origin/CSRF protections for mutating admin requests.
- Add smoke coverage that verifies anonymous requests to `ops.pharos.watch/api/admin/status` fail before proxying.

Key refs:
- `functions/api/admin/[[path]].ts`
- `functions/lib/ops-origin.ts`
- `functions/lib/ops-env.ts`
- `worker/src/lib/auth.ts`
- `worker/src/handlers/http/gates.ts`
- `docs/operator-origin-access.md`

### Issue 17: HTTPS Enforcement

Current state:
- The repo hard-codes canonical `https://` origins and emits HSTS.
- The repo does not contain its own HTTP-to-HTTPS redirect or scheme rejection logic.
- Cloudflare edge settings therefore decide whether plaintext traffic is actually blocked or redirected.

Live verification on April 4, 2026:
- `http://pharos.watch/` -> `301` to `https://pharos.watch/`
- `http://ops.pharos.watch/admin/` -> `301` to `https://ops.pharos.watch/admin/`
- `http://ops-api.pharos.watch/api/health` -> `301` to `https://ops-api.pharos.watch/api/health`
- `http://api.pharos.watch/api/health` -> plain-HTTP response observed
- `http://site-api.pharos.watch/api/stablecoins` -> plain-HTTP response observed

Independent spot-check from this audit on April 4, 2026:
- `curl -I http://api.pharos.watch/api/health` returned `HTTP/1.1 405 Method Not Allowed` with normal Worker headers, proving no HTTPS redirect on that host for `HEAD`.
- `curl -I http://site-api.pharos.watch/api/stablecoins` returned `HTTP/1.1 401 Unauthorized` over plain HTTP.
- `curl -I http://pharos.watch/` and `curl -I http://ops-api.pharos.watch/api/health` returned `301`.

Planning direction:
- Treat this as an open Cloudflare edge configuration issue, not an app-code bug.
- Enable `Always Use HTTPS` or equivalent Redirect Rules for `api.pharos.watch` and `site-api.pharos.watch`.
- Add plaintext-to-HTTPS smoke tests to the deploy path.

Key refs:
- `shared/lib/runtime-origins.json`
- `public/_headers`
- `worker/src/handlers/http/cors.ts`
- `worker/src/handlers/http/request-dispatch.ts`
- `worker/wrangler.toml`
- `docs/operator-origin-access.md`
- `docs/deployment-process.md`

## Notes On Other Green / Mostly-Green Items

- `#1`: frontend key exposure is not present; the admin key reveal flow is intentional and access-gated.
- `#3`: request-reachable SQL is currently safe, but the SQL-safety check should grow.
- `#4`: CORS is allowlisted; the real adjacent concern is CSRF on the admin proxy if Access is misconfigured.
- `#7`: not frontend-only auth, but it points at the same ops-proxy trust boundary as `#13`.
- `#8`: reachable local history looks clean; a broader secret scan would still be prudent if there is suspicion of leakage outside fetched refs.
- `#18`: not an app-session invalidation bug, but it reinforces the same dependency on correct Cloudflare Access coverage as `#13`.
- `#19`: audit cadence exists; the gap is operational verification and ownership, not missing automation.
- `#20`: no open redirect sink was found; the Pages proxies intentionally use `redirect: "manual"` and do not relay upstream `Location` headers.

## Suggested Remediation Planning Order

1. Fix HTTPS enforcement in Cloudflare for `api.pharos.watch` and `site-api.pharos.watch`.
2. Remove internal error leakage from `/api/health`, `/api/status`, and the root app error boundary.
3. Harden `/api/admin/*` Pages proxy trust assumptions with UI-side Access validation and CSRF/origin checks.
4. Decide whether API keys should expire and document/automate credential rotation policy for long-lived machine secrets.
5. Tighten preventive guardrails: HTTP downgrade smoke, SQL safety checks, and CORS deny behavior.

## Final Position

The Hartdrawss thread is directionally useful, but Pharos is not a generic “vibe-coded app” with user accounts, passwords, uploads, and a public database listener. Most of those warnings are either not applicable or already mitigated by the current Cloudflare/Worker architecture.

The real work is smaller and sharper:
- close the HTTPS downgrade gap,
- stop leaking raw internal error text,
- remove trust assumptions in the Pages admin proxy,
- and decide how much lifecycle control to add to long-lived machine credentials.
