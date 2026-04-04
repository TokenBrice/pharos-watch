# Hartdrawss Findings Remediation Implementation Plan

Date: April 4, 2026

Inputs:
- [Hartdrawss thread assessment](/Users/ahirice/Documents/git/stablecoin-dashboard/agents/audits/2026-04-04-hartdrawss-thread-20-issue-assessment.md)
- `docs/architecture.md`
- `docs/api-reference.md`
- `docs/testing.md`
- `docs/operator-origin-access.md`
- `docs/deployment-process.md`

Scope:
- Convert the April 4, 2026 assessment into an implementation-ready remediation plan.
- Cover all 20 thread issues, including direct fixes, operational controls, and explicit no-action closures where the issue class is not applicable to Pharos.
- No application code is changed in this planning pass.

## Planning Principles

1. Fix root causes, not symptoms.
2. Separate Cloudflare account work from repo work.
3. Keep the plan deploy-safe for Pages + Worker + D1.
4. Preserve the current product architecture unless a finding requires a structural change.
5. For non-applicable findings, record the closure condition so the issue does not keep reopening in future reviews.

## Executive Summary

The remediation program should be organized into five active workstreams and one closure lane:

1. Transport enforcement
   Address `#17` by forcing HTTP to HTTPS on all production API hosts and adding a live transport smoke so the gap cannot regress silently.
2. Error disclosure reduction
   Address `#9` by sanitizing public and admin diagnostic responses and aligning the root app error boundary with the safer route-level error behavior.
3. Ops proxy trust hardening
   Address `#7`, `#13`, and the relevant portion of `#18` by making the Pages admin proxy independently verify the UI-side Cloudflare Access JWT and reject cross-site mutating requests.
4. Credential lifecycle hardening
   Address `#12` by adding a deliberate lifecycle model for API keys and rotation procedures for long-lived machine secrets.
5. Preventive guardrails
   Address the hardening follow-ups from `#3`, `#4`, `#8`, and `#19`.
6. Explicit closure of non-applicable items
   Record why `#2`, `#10`, `#11`, `#14`, `#15`, `#16`, and `#20` do not require active remediation work in the current architecture.

Recommended delivery order:

1. Transport enforcement (`#17`)
2. Error sanitization (`#9`)
3. Ops proxy trust hardening (`#7`, `#13`, `#18`)
4. Credential lifecycle controls (`#12`)
5. Guardrail and closure work (`#3`, `#4`, `#8`, `#19`, remaining low-risk items)

## Issue Disposition Matrix

| # | Issue | Current assessment | Remediation intent | Priority | Primary lane |
| --- | --- | --- | --- | --- | --- |
| 1 | API keys hardcoded in frontend JS | Mitigated | Preserve current posture; add regression review coverage only | P3 | Closure / guardrails |
| 2 | No rate limiting on `/login` | Not applicable | Close as external-IdP concern; verify Cloudflare Access policy ownership | P4 | Closure |
| 3 | SQL built with string concatenation | Mitigated with hardening follow-up | Expand SQL-safety guardrails and coverage | P2 | Guardrails |
| 4 | CORS set to `*` | Mitigated | Tighten deny behavior for disallowed origins | P2 | Guardrails |
| 5 | JWTs in `localStorage` | Mitigated | Preserve posture; optional regression guard only | P4 | Closure / guardrails |
| 6 | Weak/default JWT secret | Not applicable to repo auth | Preserve Cloudflare Access JWT verification during refactor | P4 | Closure |
| 7 | Admin routes protected only in frontend | Conditional | Closed by Pages proxy auth hardening | P1 | Ops proxy |
| 8 | `.env` committed to git | Mitigated | Add preventive secret-scanning control and runbook | P3 | Guardrails |
| 9 | Error responses leak internals | Partial / open | Sanitize diagnostic output and add regression tests | P1 | Error hygiene |
| 10 | File uploads lack MIME validation | Not applicable | Close; document future rule if uploads are ever added | P4 | Closure |
| 11 | Passwords hashed with MD5/SHA1 | Not applicable | Close; document future rule if password auth is ever added | P4 | Closure |
| 12 | Auth tokens never expire | Partial / mixed | Add lifecycle controls for machine credentials and confirm Access session policy | P1 | Credentials |
| 13 | Missing auth middleware on internal API routes | Conditional | Closed by Pages proxy JWT verification + CSRF/origin checks | P1 | Ops proxy |
| 14 | Server running as root | Not applicable | Close; serverless runtime has no repo-owned host process | P4 | Closure |
| 15 | Database port exposed to internet | Not applicable | Close; D1 has no repo-owned listener | P4 | Closure |
| 16 | IDOR on resource endpoints | Not reproduced / not applicable | Close for current surface; add future rule for user-owned resources | P4 | Closure |
| 17 | No HTTPS enforcement | Partial / open | Fix Cloudflare edge transport posture and add live smoke | P0 | Transport |
| 18 | Sessions not invalidated on logout | Not applicable in app-session sense, with ops caveat | Close once ops proxy trust boundary is hardened and Access session policy is documented | P2 | Ops proxy + credentials |
| 19 | npm packages not audited since setup | Mitigated | Keep automation; add ownership and response policy | P3 | Guardrails |
| 20 | Open redirects in callback URLs | Mitigated | Preserve `redirect: "manual"` posture and current tests | P4 | Closure |

## Workstream A: Transport Enforcement

Findings addressed:
- `#17`

Target state:
- Every production hostname redirects plain HTTP to HTTPS before application logic is reached.
- API and ops API hosts preserve method and body semantics for redirected POST requests.
- CI and post-deploy smoke detect any future downgrade regression immediately.

### Root Cause

The repo already emits canonical `https://` origins and HSTS headers, but the actual redirect behavior is controlled at the Cloudflare edge. On April 4, 2026, `api.pharos.watch` and `site-api.pharos.watch` still accepted plain HTTP instead of redirecting.

### Recommended implementation

1. Cloudflare edge configuration
   - Add explicit host-scoped Redirect Rules for:
     - `api.pharos.watch`
     - `site-api.pharos.watch`
   - Prefer `308` redirects for API hosts so method and body are preserved for POST traffic.
   - Review whether `ops-api.pharos.watch` should also move from `301` to `308` for consistency.
   - Keep existing working UI-host redirects in place for:
     - `pharos.watch`
     - `ops.pharos.watch`

2. Repo-side transport smoke
   - Add a dedicated live transport smoke script, recommended name: `scripts/smoke-transport.mjs`.
   - Validate at least:
     - `http://pharos.watch/`
     - `http://api.pharos.watch/api/health`
     - `http://site-api.pharos.watch/api/stablecoins`
     - `http://ops.pharos.watch/admin/`
     - `http://ops-api.pharos.watch/api/health`
   - Assert:
     - status is `301` or `308`
     - `Location` is the matching `https://` URL
     - no host/path downgrade or cross-host redirect occurs

3. CI integration
   - Run the transport smoke after worker and/or Pages production changes.
   - The cleanest fit is after `smoke-api` and before `smoke-ops` in `.github/workflows/deploy-cloudflare.yml`.
   - Also run it after scheduled Pages rebuilds so account-side drift is still caught even when the repo did not change.

4. Documentation
   - Update `docs/testing.md`
   - Update `docs/deployment-process.md`
   - Add the transport smoke to `docs/scripts.md`
   - Note the Cloudflare rule ownership and host coverage in `docs/operator-origin-access.md` if that remains the canonical host-split runbook

### Planned repo touchpoints

- new `scripts/smoke-transport.mjs`
- `package.json`
- `.github/workflows/deploy-cloudflare.yml`
- `.github/workflows/rebuild-pages.yml`
- `docs/testing.md`
- `docs/deployment-process.md`
- `docs/scripts.md`
- possibly `docs/operator-origin-access.md`

### Validation

- Live `curl -I http://...` checks for all production hosts after Cloudflare rule creation
- `npm run test:smoke-api`
- new `npm run test:smoke-transport`
- `npm run test:smoke-ui -- --url https://pharos.watch --mode live`
- `npm run test:smoke-ops`

### Rollout and rollback

- Apply Cloudflare redirect rules first.
- Run manual transport verification immediately.
- Land the repo-side smoke in the next deploy-bearing change so the control becomes self-monitoring.
- If a redirect rule breaks traffic, rollback is Cloudflare-account-side and should not require code revert.

### Acceptance criteria

- Plain HTTP no longer serves app responses on `api.pharos.watch` or `site-api.pharos.watch`.
- CI fails if any production host stops redirecting HTTP to HTTPS.

## Workstream B: Error Disclosure Reduction

Findings addressed:
- `#9`

Target state:
- Public and admin diagnostics use stable codes and safe human-readable summaries only.
- Raw exception messages, SQL fragments, table names, and stack-like content stay in logs, not in responses.
- The root app error boundary behaves like the safer route-level page error component in production.

### Root Cause

The general API error wrapper fails closed, but the health and status diagnostics bypass that generic path and currently serialize raw error text into `warnings` and `sectionErrors.*.message`. The root app boundary also renders `error.message` directly in production.

### Recommended implementation

1. Introduce explicit sanitization helpers
   - Add a small internal helper for public warnings, recommended scope: worker-only or shared runtime-neutral if reused broadly.
   - Convert raw `unknown` errors into:
     - machine-readable code
     - generic message text
   - Keep raw details only in `console.warn` / `console.error`.

2. Sanitize public `/api/health`
   - Update `worker/src/lib/public-health-assessment.ts`
   - Replace strings like:
     - `db-unhealthy: ${formatError(err)}`
     - `blacklist-query-failed: ${error}`
     - `mint-burn-query-failed: ${error}`
     - `circuit-query-failed: ${error}`
   - With safe forms such as:
     - `db-unhealthy`
     - `blacklist-query-failed`
     - `mint-burn-query-failed`
     - `circuit-query-failed`
   - If a human-readable message is needed, it should be generic, for example `Database unavailable` rather than `no such table: ...`.

3. Sanitize admin `/api/status`
   - Update `worker/src/api/status-supplements.ts`
   - Review any other `sectionErrors` producers in:
     - `worker/src/lib/status-evaluation.ts`
     - `worker/src/lib/status-reliability.ts`
     - `worker/src/lib/status-reliability-shared.ts`
   - Preserve the existing `code` values where possible so the admin UI does not lose machine-readable meaning.
   - Replace raw `message` strings with fixed safe messages.

4. Align the root app error boundary
   - Update `src/app/error.tsx`
   - Match the production behavior already used in `src/components/page-error.tsx`:
     - development may show `error.message`
     - production should show generic recovery guidance only

5. Admin UI review
   - Audit any status dashboard UI that assumes the old free-form `sectionErrors.*.message` content.
   - If operators need richer debugging, direct them to logs or internal docs rather than response payloads.

### Planned repo touchpoints

- `worker/src/lib/public-health-assessment.ts`
- `worker/src/api/status-supplements.ts`
- `worker/src/lib/status-evaluation.ts`
- `worker/src/lib/status-reliability.ts`
- `worker/src/lib/status-reliability-shared.ts`
- `src/app/error.tsx`
- possibly `src/app/admin/*` or status-dashboard presentation helpers
- `docs/api-reference.md`

### Tests to add or update

- `worker/src/api/__tests__/health.test.ts`
  - assert warnings do not contain `sqlite`, `no such table`, `SELECT`, `Error:`, or stack-like text
- `worker/src/api/__tests__/status.test.ts`
  - assert `sectionErrors.*.message` stays generic for simulated query failures
- root app error-boundary test
  - assert production rendering does not expose `error.message`
- optional helper unit tests for any new sanitizer utility

### Validation

- `npm test`
- `npm run coverage:critical`
- `npm run build`
- manual request checks against `/api/health` and `/api/status` with induced local test failures if available

### Rollout and rollback

- This is a low-risk repo-side deployment.
- Rollback is code-only if operator diagnostics become too vague, but the better course is usually to tune safe messages, not restore raw leakage.

### Acceptance criteria

- No response body on `/api/health`, `/api/status`, or production `src/app/error.tsx` contains raw SQL/table/stack detail under tested failure modes.
- Operators still receive stable error codes and actionable but non-sensitive summaries.

## Workstream C: Ops Proxy Trust Boundary Hardening

Findings addressed:
- `#7`
- `#13`
- `#18` (relevant trust-boundary portion)

Target state:
- `/api/admin/*` on `ops.pharos.watch` fails closed even if Cloudflare Access posture on the host drifts.
- The Pages admin proxy verifies the UI-side Access JWT itself before forwarding upstream.
- Mutating admin requests are protected against cross-site request forgery.

### Root Cause

`functions/api/admin/[[path]].ts` currently:
- checks that the request arrived on the ops origin
- validates the path and method
- forwards upstream with a Pages-held Access service token

It does not currently:
- validate the inbound UI `Cf-Access-Jwt-Assertion`
- require same-origin CSRF signals for mutating requests

The result is a trust assumption: if `ops.pharos.watch` is misconfigured at the Access layer, the proxy is effectively fail-open.

### Recommended implementation

1. Move Access JWT verification into a shared runtime-neutral location
   - Current worker verifier lives in `worker/src/lib/jwt-verify.ts`.
   - Pages Functions cannot import `worker/src` because of the repo boundary rules.
   - Create a shared verifier module under `shared/lib/`, recommended naming:
     - `shared/lib/cloudflare-access-jwt.ts`
   - Re-point both:
     - `worker/src/lib/auth.ts`
     - `functions/api/admin/[[path]].ts`
   - Preserve the current claim checks:
     - signature
     - `aud`
     - `iss`
     - `exp`
     - `nbf`

2. Activate Pages-side UI JWT validation
   - Update `functions/lib/ops-env.ts` so `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_OPS_UI_AUD` are no longer treated as future-reserved-only bindings.
   - Implement a Pages helper that:
     - reads `Cf-Access-Jwt-Assertion`
     - verifies it against the UI app AUD
     - returns `401` on failure before any upstream request
   - Use that helper in `functions/api/admin/[[path]].ts`.

3. Add CSRF/origin checks for mutating admin requests
   - For `POST` requests to `/api/admin/*`, require same-origin evidence.
   - Recommended minimum:
     - `Origin` equals `OPS_UI_ORIGIN`
   - Accept `Referer` same-origin only as a compatibility fallback if a browser path is confirmed to omit `Origin`.
   - Return `403` if the request fails this check.
   - Keep the check limited to mutating verbs so safe admin `GET` diagnostics continue to work from the same-origin UI.

4. Preserve path and header minimization
   - Keep the current allowlisted upstream path model.
   - Keep `redirect: "manual"` so redirect relays do not reopen issue `#20`.
   - Keep the narrow forwarded-header set.

5. Add smoke and unit coverage
   - Unit-test that the Pages proxy rejects:
     - missing JWT
     - invalid JWT
     - bad mutating `Origin`
   - Unit-test that these failures happen before upstream fetch.
   - Extend `smoke-ops` only if there is a clean way to verify the hardened path without making CI brittle. The main enforcement proof should stay in unit tests plus runtime env audit.

6. Update the Cloudflare runbook
   - Record the Pages bindings that must now exist:
     - `CF_ACCESS_TEAM_DOMAIN`
     - `CF_ACCESS_OPS_UI_AUD`
     - `OPS_API_SERVICE_TOKEN_ID`
     - `OPS_API_SERVICE_TOKEN_SECRET`
   - Keep `CF_ACCESS_OPS_API_AUD` worker-side for `ops-api` verification.

### Planned repo touchpoints

- new `shared/lib/cloudflare-access-jwt.ts` or equivalent
- `worker/src/lib/jwt-verify.ts` or replacement wrapper
- `worker/src/lib/auth.ts`
- `functions/lib/ops-env.ts`
- `functions/api/admin/[[path]].ts`
- `functions/__tests__/ops-admin-proxy.test.ts`
- `worker/src/lib/__tests__/auth.test.ts`
- `docs/operator-origin-access.md`
- `docs/api-reference.md`
- `docs/testing.md`

### Suggested delivery phases

Phase C1: shared verifier extraction
- Create the shared verifier and migrate worker auth to it.
- No behavior change intended.

Phase C2: Pages validation behind env readiness
- Implement Pages-side validation using `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_OPS_UI_AUD`.
- Add tests.

Phase C3: CSRF/origin enforcement
- Add `Origin` / `Referer` validation for mutating requests.
- Validate admin UI behavior manually.

Phase C4: docs and smoke alignment
- Update runbooks and any relevant CI smoke expectations.

### Validation

- `npm test`
- `npm run coverage:critical`
- `npm run build`
- `cd worker && npx tsc --noEmit`
- Pages proxy unit tests proving fail-closed behavior
- manual browser verification on `ops.pharos.watch/admin/`

### Rollout and rollback

- Do not hard-require the new Pages env bindings until they are populated in Cloudflare.
- Land the shared verifier extraction first if that reduces risk.
- If admin UI traffic breaks, inspect whether the UI host is sending `Cf-Access-Jwt-Assertion` as expected before relaxing any auth check.

### Acceptance criteria

- Anonymous or invalid-JWT requests to `/api/admin/*` on `ops.pharos.watch` fail before upstream proxying.
- Cross-site POST attempts fail with `403`.
- Valid same-origin operator requests continue to work.

## Workstream D: Credential Lifecycle Hardening

Findings addressed:
- `#12`
- supporting closure for the session-related portion of `#18`

Target state:
- Human operator sessions are clearly owned by Cloudflare Access policy with documented session duration.
- Repo-owned machine credentials have an intentional lifecycle model:
  - explicit expiry where appropriate
  - explicit rotation procedure where expiry is not practical
  - zero-downtime or bounded-downtime rotation paths for shared secrets

### Credential classes in scope

1. Cloudflare Access UI/API JWTs
   - externally issued
   - already expire
   - repo must continue validating claims correctly

2. Public API keys
   - repo-owned
   - currently long-lived until rotate/deactivate

3. `SITE_API_SHARED_SECRET`
   - repo/runtime-owned shared secret between Pages and Worker

4. Pages service-token credentials for `ops-api`
   - Cloudflare Access service tokens
   - configured in Pages env and CI secrets

5. Telegram webhook secret
   - repo/runtime-owned shared secret

### Recommended implementation

#### D1. Cloudflare Access human-session policy

Implementation:
- Confirm the actual UI and API Access app session durations in Zero Trust.
- Document the intended operator-session duration in `docs/operator-origin-access.md`.
- Recommended posture:
  - short session duration
  - MFA required
  - no repo change unless claim validation needs adjustment

Closure condition:
- The repo and the runbook both reflect that human sessions do expire and are not app-managed.

#### D2. Public API key expiry model

Recommended target design:
- Add nullable `expires_at` to `api_keys`.
- Add `last_rotated_at` if the team wants first-class rotation reporting.
- Treat existing rows as grandfathered until explicitly updated.

Recommended staged rollout:

Stage D2.1: schema and enforcement support
- Add backward-compatible D1 migration, for example:
  - `expires_at INTEGER NULL`
  - optional `last_rotated_at INTEGER NULL`
- Reject expired keys in `worker/src/lib/api-keys.ts`.
- Surface expiry in list/create/update/rotate responses.

Stage D2.2: admin API and UI support
- Extend shared request/response types.
- Add expiry fields to:
  - `GET /api/api-keys`
  - `POST /api/api-keys`
  - `POST /api/api-keys/:id/update`
  - `POST /api/api-keys/:id/rotate`
- Update admin UI to show:
  - active / expired / expiring-soon state
  - optional expiry selection on create and rotate

Stage D2.3: operational policy
- Decide default expiry for new external keys.
- Recommended starting posture:
  - existing keys: no forced immediate expiry
  - new keys: default finite lifetime, with explicit override only for approved exceptions
- Publish the policy in docs or operator runbook.

Why staged rollout is recommended:
- It closes the finding without breaking existing integrations immediately.
- It stays compatible with the current one-time-reveal key model.

#### D3. `SITE_API_SHARED_SECRET` rotation

Current risk:
- One static secret is used between Pages and Worker.
- Rotation is awkward because both runtimes must move together.

Recommended design:
- Support overlap on the Worker side, for example:
  - `SITE_API_SHARED_SECRET`
  - `SITE_API_SHARED_SECRET_PREVIOUS`
- Pages continues sending only the current secret.

Rotation procedure:
1. Deploy Worker accepting both current and previous.
2. Update Pages secret to the new current value.
3. Verify `/_site-data/*` traffic and smoke.
4. Remove the previous value in a follow-up deploy.

This avoids a hard synchronized cutover.

#### D4. Telegram webhook secret rotation

Current risk:
- One static secret protects the webhook.

Recommended design:
- Mirror the shared-secret overlap pattern:
  - `TELEGRAM_WEBHOOK_SECRET`
  - optional `TELEGRAM_WEBHOOK_SECRET_PREVIOUS`
- Worker accepts either during a short rotation window.

Rotation procedure:
1. Deploy acceptance of both old and new.
2. Update Telegram webhook config to send the new secret.
3. Observe successful deliveries.
4. Remove the previous secret.

#### D5. Ops API service-token rotation

Code change:
- none required unless the team wants dual-token support in Pages, which is not necessary because Access handles validation externally

Operational plan:
1. Create a new Access service token.
2. Update:
   - Pages env
   - CI secrets used by `smoke-ops`
3. Deploy and run smoke.
4. Revoke the old token.

Document this in `docs/operator-origin-access.md`.

### Planned repo touchpoints

- `worker/migrations/*` for API key expiry support
- `worker/src/lib/api-keys.ts`
- admin API handlers for key create/update/rotate/list
- shared API key types under `shared/`
- admin UI key-management components under `src/app/admin/` and related hooks
- `worker/src/api/telegram-webhook.ts`
- `worker/src/lib/auth.ts` for site-secret overlap support
- `functions/_site-data/[[path]].ts` if any request-side secret naming changes are needed
- `docs/api-reference.md`
- `docs/operator-origin-access.md`
- any admin runbook or README section that documents API key issuance

### Validation

- migration replay: `npm run check:migrations`
- full repo validation for any API key schema/UI work
- targeted tests for:
  - expired key rejection
  - expiring-soon display
  - dual-secret acceptance during rotation windows
  - Telegram webhook acceptance rules

### Rollout and rollback

- Keep API key expiry nullable on first rollout.
- Do not force-expire existing keys in the migration.
- Use overlap windows for shared secrets to avoid downtime.

### Acceptance criteria

- Human operator sessions are documented as expiring under Access policy.
- Public API keys can expire and expired keys are rejected.
- Site and Telegram shared secrets have a safe rotation path.
- Service-token rotation is documented and smoke-tested.

## Workstream E: Preventive Guardrails

Findings addressed:
- `#3`
- `#4`
- `#8`
- `#19`
- low-risk reinforcement for `#1`, `#5`, and `#20`

### E1. SQL interpolation safety guardrail

Current gap:
- `scripts/check-sql-interpolation-safety.mjs` scans only `worker/src`.
- It is line-based and can miss broader interpolation shapes.

Recommended implementation:

1. Expand file coverage
   - include `worker/scripts` if SQL is present there
   - optionally include any root scripts that issue SQL against D1

2. Improve detection
   - inspect full template literals, not only single-line fragments
   - keep the current allowlist / `// SAFETY:` escape hatch
   - prefer safe helper patterns over ad hoc comments where possible

3. Document the contract
   - update `docs/testing.md` and `docs/scripts.md`
   - explain what counts as a compliant dynamic SQL site

4. Optional hardening
   - introduce a tiny helper for allowlisted identifier interpolation so developers do not hand-roll the pattern repeatedly

Acceptance:
- New risky interpolation sites in the broader SQL surface fail CI.

### E2. CORS deny behavior

Current gap:
- `worker/src/handlers/http/cors.ts` falls back to the first allowlisted origin when the request `Origin` is not allowed.

Recommended implementation:

1. Change origin resolution semantics
   - if the request has no `Origin`, preserve the current default behavior
   - if the request has an `Origin` and it is not allowlisted, do not emit `Access-Control-Allow-Origin`

2. Preflight behavior
   - preferred: return `403` for disallowed-origin preflight requests
   - alternative: return `204` without CORS headers
   - choose one behavior and document it

3. Update tests
   - extend `worker/src/__tests__/index.fetch.test.ts`
   - add explicit disallowed-origin cases

4. Update API docs
   - adjust the CORS section in `docs/api-reference.md`

Acceptance:
- Disallowed origins no longer receive a misleading allowlisted ACAO value.

### E3. Secret-scanning and env hygiene

Current state:
- No tracked real `.env` leak was found in reachable history.

Recommended implementation:

1. One-time historical scan
   - run a one-time broader secret scan across reachable refs and release history
   - this is operational, not necessarily a permanent CI gate

2. Preventive CI control
   - recommended minimal option: add one secret-scanning workflow or enable GitHub native secret scanning if available
   - do not add multiple overlapping tools on the first pass

3. Documentation
   - record where local secrets belong:
     - `.dev.vars`
     - Cloudflare secrets/bindings
     - GitHub Actions secrets

Acceptance:
- Future accidental secret commits have an automated detection path.

### E4. Dependency audit ownership

Current state:
- `npm audit` already runs in validate and weekly dependency audit workflows.

Recommended implementation:

1. Keep the existing automation unchanged.
2. Add ownership and response expectations to docs or ops checklist:
   - who reviews the weekly audit
   - expected response time for high-severity production advisories
3. Optionally add issue-template or runbook guidance for dependency-response triage.

Acceptance:
- The control is not only automated, but also assigned.

### E5. Low-cost regression reinforcement for green findings

Issue `#1`
- Preserve the current one-time key reveal flow.
- Ensure admin key creation/rotation tests continue proving that plaintext tokens are returned only once and not persisted in list endpoints.

Issue `#5`
- No app-session storage fix is needed.
- Optional future guardrail: lightweight grep or lint rule against storing auth tokens in browser storage.

Issue `#20`
- Preserve `redirect: "manual"` in both proxies.
- Keep or extend unit coverage that confirms upstream Access redirects are translated to safe errors rather than relayed.

## Closure Lane For Non-Applicable Findings

These items do not require active remediation work in the current architecture, but each should have an explicit closure note so they do not stay as vague backlog noise.

### `#2` No rate limiting on `/login`

Closure:
- Pharos does not implement a repo-owned login route.
- Login is handled by Cloudflare Access / external identity.
- Document policy ownership in `docs/operator-origin-access.md` if needed.

### `#10` File uploads lack MIME validation

Closure:
- No upload surface exists.
- If uploads are ever introduced, require MIME, size, extension, and storage-policy design review before merge.

### `#11` Passwords hashed with MD5/SHA1

Closure:
- No password auth/store exists.
- If password auth is ever introduced, require Argon2id or scrypt and a dedicated security review.

### `#14` Server running as root

Closure:
- Production runtime is Pages + Worker + D1.
- There is no repo-owned root server process to remediate.

### `#15` Database port exposed to internet

Closure:
- D1 is serverless and bound; no repo-owned database listener exists.

### `#16` IDOR on resource endpoints

Closure:
- Current public endpoints expose shared analytics datasets, not user-owned records.
- If the product adds per-user resources later, require ownership checks and abuse tests as a launch gate.

### `#20` Open redirects in callback URLs

Closure:
- Current proxies already use `redirect: "manual"` and do not relay upstream `Location`.
- Preserve this behavior during future proxy refactors.

## Delivery Sequence

Recommended phase plan:

### Phase 0: External readiness and scoping

1. Confirm Cloudflare ownership for redirect rules and Access settings.
2. Confirm whether `Cf-Access-Jwt-Assertion` is present on Pages Functions requests to `ops.pharos.watch`.
3. Decide API key expiry policy defaults before coding the admin UX.

### Phase 1: P0 transport

1. Fix Cloudflare redirect rules for `api.pharos.watch` and `site-api.pharos.watch`.
2. Manually verify on April 4, 2026-style `curl -I http://...` checks.
3. Add repo-side transport smoke and CI integration.

### Phase 2: P1 error sanitization

1. Sanitize `/api/health`
2. Sanitize `/api/status`
3. Sanitize `src/app/error.tsx`
4. Add regression tests
5. Update API docs

### Phase 3: P1 ops proxy hardening

1. Extract shared Access JWT verifier
2. Add Pages JWT validation
3. Add mutating-request origin/CSRF checks
4. Update tests and runbooks

### Phase 4: P1 credential lifecycle

1. Document Access session policy
2. Implement API key expiry support
3. Add site-secret overlap rotation support
4. Add Telegram webhook overlap rotation support
5. Document service-token rotation

### Phase 5: P2-P3 guardrails and closures

1. Expand SQL safety checker
2. Tighten CORS deny behavior
3. Add secret-scanning control
4. Document dependency-audit ownership
5. Close remaining non-applicable findings explicitly

## Validation Checklist For Implementation PRs

Any PR that implements part of this plan should, as applicable, run:

- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run coverage:critical`
- `npm run build`
- `npm run seo:check`
- `cd worker && npx tsc --noEmit`
- `npm run check:migrations`
- `npm run check:sql-safety`
- `npm run test:merge-gate`

Live and post-deploy validation should include:

- `npm run test:smoke-api`
- `npm run test:smoke-ops`
- new transport smoke
- `npm run test:smoke-ui -- --url https://pharos.watch --mode live`

## Recommended Ticket Breakdown

Supersession note:
- The execution ticket IDs in this section are superseded by [2026-04-04-hartdrawss-sequenced-ticket-backlog.md](/Users/ahirice/Documents/git/stablecoin-dashboard/agents/plans/2026-04-04-hartdrawss-sequenced-ticket-backlog.md).
- Use the sequenced backlog as the canonical execution authority for branch planning, wave ordering, and subagent dispatch.

1. `SEC-01` Enforce HTTPS redirects for all production API hosts and add transport smoke
2. `SEC-02` Sanitize `/api/health`, `/api/status`, and root error-boundary messages
3. `SEC-03` Extract shared Cloudflare Access JWT verification for Worker + Pages
4. `SEC-04` Harden `/api/admin/*` Pages proxy with UI JWT validation
5. `SEC-05` Add same-origin CSRF/origin protection to mutating admin proxy routes
6. `SEC-06` Add API key expiry support and admin UX
7. `SEC-07` Add safe rotation overlap for `SITE_API_SHARED_SECRET`
8. `SEC-08` Add safe rotation overlap for Telegram webhook secret
9. `SEC-09` Expand SQL interpolation safety checks
10. `SEC-10` Tighten disallowed-origin CORS behavior
11. `SEC-11` Add secret-scanning preventive control
12. `SEC-12` Update security-related runbooks and deployment/testing docs

## Final Position

The remediation scope is real but focused. The repo does not need a generic “secure the whole SaaS stack” rewrite. It needs:

- Cloudflare transport enforcement on the two API hosts that still allowed plain HTTP on April 4, 2026
- response-sanitization for a narrow set of diagnostic surfaces
- a stricter trust boundary on the Pages admin proxy
- and deliberate lifecycle handling for long-lived machine credentials

Everything else should either be implemented as a small preventive guardrail or explicitly closed as not applicable to the current Pages + Worker + D1 architecture.
