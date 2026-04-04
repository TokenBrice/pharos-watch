# 2026-04-04 Hartdrawss Dispatch-Ready Ticket Packets

Inputs:
- [Hartdrawss thread assessment](/Users/ahirice/Documents/git/stablecoin-dashboard/agents/audits/2026-04-04-hartdrawss-thread-20-issue-assessment.md)
- [Hartdrawss remediation implementation plan](/Users/ahirice/Documents/git/stablecoin-dashboard/agents/plans/2026-04-04-hartdrawss-remediation-implementation-plan.md)
- [Hartdrawss sequenced ticket backlog](/Users/ahirice/Documents/git/stablecoin-dashboard/agents/plans/2026-04-04-hartdrawss-sequenced-ticket-backlog.md)
- [Hartdrawss ticket verification and orchestration note](/Users/ahirice/Documents/git/stablecoin-dashboard/agents/plans/2026-04-04-hartdrawss-ticket-verification-and-orchestration.md)

## Purpose

Freeze the remaining implementation ambiguity so each remediation ticket can be dispatched to a single owner or subagent without interpretation drift.

This document is deliberately stricter than the backlog:
- the backlog remains the authority for merge order, blockers, and waves
- this document is the authority for ticket-level execution contracts
- no ticket owner may widen scope, change a frozen contract, or edit forbidden files without an orchestrator update to this document

## Dispatch Protocol

1. Complete [2026-04-04-hartdrawss-ctrl-00-decision-record.md](/Users/ahirice/Documents/git/stablecoin-dashboard/agents/plans/2026-04-04-hartdrawss-ctrl-00-decision-record.md) before dispatching any ticket that lists `CTRL-00` as a blocker.
2. Dispatch one ticket per branch and one primary owner per ticket.
3. When a packet lists a file as forbidden, treat it as read-only even if the change looks nearby.
4. If a ticket needs a forbidden file, stop and return the blocker to the orchestrator instead of widening scope.
5. Ticket owners must run the exact validation commands in the packet, then report:
   - files changed
   - docs changed
   - validation run
   - unresolved risk
6. When a packet splits `Owner-run validation` from `Orchestrator live verification`, the ticket owner runs only the owner-run block and leaves live checks to the orchestrator.
7. The orchestrator owns shared-doc rebases, live smoke, browser verification, and final merge-gate runs.

## Frozen Program Decisions

These choices are no longer open for implementer interpretation.

### 1. `CTRL-00` deliverable format

`CTRL-00` must produce and fill:
- [2026-04-04-hartdrawss-ctrl-00-decision-record.md](/Users/ahirice/Documents/git/stablecoin-dashboard/agents/plans/2026-04-04-hartdrawss-ctrl-00-decision-record.md)

It must contain concrete values, not prose placeholders, for:
- Pages receipt of `Cf-Access-Jwt-Assertion` on `ops.pharos.watch` for browser-authenticated traffic
- Pages receipt of `Cf-Access-Jwt-Assertion` on `ops.pharos.watch` for service-token traffic
- exact `CF_ACCESS_TEAM_DOMAIN`
- exact `CF_ACCESS_OPS_UI_AUD`
- operator Access session duration owner and value
- rule owner / rule location for the API-host HTTP-to-HTTPS redirects
- owner for the Pages -> `ops-api` service token
- owner for the CI `smoke-ops` service token

### 2. API-host transport contract

`SEC-01` is frozen to this behavior:
- `http://api.pharos.watch/...` must return `308`
- `http://site-api.pharos.watch/...` must return `308`
- redirect target must preserve host, path, and query and only upgrade the scheme to `https`
- the redirect must happen before any application auth or worker logic responds

Repo architecture decision:
- add a dedicated script: `scripts/smoke-transport.mjs`
- add a dedicated npm command: `npm run test:smoke-transport`
- do not overload `scripts/smoke-api.mjs` with transport coverage

### 3. Cloudflare Access team-domain policy

Silent team-domain fallback is no longer allowed anywhere Access JWT verification is active.

This means:
- worker-side Access verification must not fall back to `"pharos-watch"` when verification is enabled
- Pages-side UI JWT verification must require explicit `CF_ACCESS_TEAM_DOMAIN`
- env validation should fail closed when an Access audience is configured without an explicit team domain

### 4. Pages admin proxy request matrix

`SEC-04` must implement exactly this request contract on `ops.pharos.watch/api/admin/*`:

| Request | Expected result |
| --- | --- |
| invalid or missing UI JWT | `401` before upstream fetch |
| valid UI JWT + `GET` or `HEAD` | allow, subject to existing path/method checks |
| valid UI JWT + `POST` / `PUT` / `PATCH` / `DELETE` + same-origin `Origin` | allow |
| valid UI JWT + `POST` / `PUT` / `PATCH` / `DELETE` + missing `Origin` | `403` |
| valid UI JWT + `POST` / `PUT` / `PATCH` / `DELETE` + foreign `Origin` | `403` |
| wrong host / non-ops origin | preserve current `404` behavior |

Additional contract:
- JWT failure must be handled before the proxy attempts the upstream fetch
- CSRF/origin failure must be handled before the proxy attempts the upstream fetch
- the Pages proxy must continue forwarding service-token headers only server-to-server

### 5. API-key expiry contract

`SEC-05` and `SEC-06` must implement this exact contract.

Shared type shape:
- `ApiKeySummary.expiresAt: number | null`
- `ApiKeyCreateRequest.expiresAt?: number | null`
- `ApiKeyUpdateRequest.expiresAt?: number | null`

Semantics:
- all timestamps remain Unix epoch seconds
- existing rows stay `expiresAt = null`
- list returns all keys, including expired keys
- gate validity is `isActive && (expiresAt == null || expiresAt > now)`
- create with omitted `expiresAt` uses the default expiry policy
- create or update with explicit `expiresAt: null` means deliberate non-expiring exception
- rotate does not accept expiry input and preserves the current `expiresAt`

Default expiry policy:
- new keys default to `90` days from creation when `expiresAt` is omitted
- this is the frozen remediation default; `CTRL-00` records operator ownership and sign-off, not a new choice

### 6. API-key admin UI behavior

`SEC-06` must implement this exact operator behavior:
- the actual UI surface is `src/components/status/api-keys-panel.tsx` plus `src/hooks/use-api-keys.ts`
- expiry editing uses a `datetime-local` input converted to UTC epoch seconds on submit
- empty input does not mean “no expiry”
- non-expiring keys require an explicit control such as a checkbox or toggle labeled as an exception
- rotate has no expiry control
- status labels are:
  - `inactive` when `isActive` is false
  - `expired` when `isActive` is true and `expiresAt != null && expiresAt <= now`
  - `active` otherwise
- add an `expiring soon` helper state when expiry is within the next 7 days

### 7. Dual-secret overlap names and window

These names and behaviors are frozen:
- site-data previous secret env: `SITE_API_SHARED_SECRET_PREVIOUS`
- Telegram previous secret env: `TELEGRAM_WEBHOOK_SECRET_PREVIOUS`
- overlap window target: 24 hours
- senders and registration flows continue emitting the current secret only
- receivers accept current or previous secret during the overlap window

### 8. CORS deny contract

`SEC-08` must implement exactly this behavior:
- allowed origin: return `Access-Control-Allow-Origin` for that origin
- disallowed `OPTIONS` preflight with foreign `Origin`: return `403` and no `Access-Control-Allow-Origin`
- disallowed non-`OPTIONS` request with foreign `Origin`: return the normal app response without `Access-Control-Allow-Origin`
- request with no `Origin`: preserve current non-browser behavior

Test architecture decision:
- add a focused CORS test file under `worker/src/handlers/http/__tests__/cors.test.ts`
- do not rely only on the broad `worker/src/__tests__/index.fetch.test.ts` surface

### 9. SQL-safety guardrail regression matrix

`SEC-09` must add:
- `scripts/__tests__/sql-interpolation-safety.test.ts`
- fixtures under `scripts/__tests__/fixtures/sql-safety/`

The fixture matrix must cover:
- safe allowlisted dynamic table-name site
- safe `// SAFETY:` comment site
- unsafe `worker/src/**` interpolation site
- unsafe `worker/scripts/**` interpolation site

### 10. Secret-scanning control

`SEC-10` is frozen to this preventive control:
- add `.github/workflows/secret-scan.yml`
- trigger on:
  - weekly schedule
  - `workflow_dispatch`
- run `gitleaks` from a shell step with an explicit pinned version, not `latest`
- document the control in `docs/testing.md`

`SEC-10` must also create:
- [2026-04-04-hartdrawss-closure-matrix.md](/Users/ahirice/Documents/git/stablecoin-dashboard/agents/audits/2026-04-04-hartdrawss-closure-matrix.md)

Required closure-matrix columns:
- `finding`
- `final status`
- `evidence`
- `reopen trigger`

## Dispatch Packets

### `CTRL-00`

Branch:
- none; orchestrator-owned prerequisite

Owner:
- orchestrator only

Blocked by:
- none

Write scope:
- [2026-04-04-hartdrawss-ctrl-00-decision-record.md](/Users/ahirice/Documents/git/stablecoin-dashboard/agents/plans/2026-04-04-hartdrawss-ctrl-00-decision-record.md)

Forbidden files:
- all application code
- all workflow files
- all docs except the decision record

Acceptance criteria:
- every field in the decision record is concrete
- evidence references are filled for the Pages header behavior
- token owners are assigned by role, not by person-name only

Validation:
- manual Cloudflare/account evidence only

Completion artifact:
- completed decision record

Rollback note:
- none; this is a prerequisite record, not a runtime change

### `SEC-01`

Branch:
- `hartdrawss/sec-01-https-transport`

Suggested owner:
- `worker` agent using `gpt-5.4`

Blocked by:
- `CTRL-00`

Write scope:
- `scripts/smoke-transport.mjs`
- `package.json`
- `.github/workflows/deploy-cloudflare.yml`
- `.github/workflows/rebuild-pages.yml`
- `docs/testing.md`
- `docs/deployment-process.md`
- `docs/scripts.md`
- `docs/operator-origin-access.md`

Forbidden files:
- `scripts/smoke-api.mjs`
- worker runtime code
- Pages Functions auth files

Acceptance criteria:
- dedicated `npm run test:smoke-transport` exists
- transport smoke asserts `308` and correct `Location` for `api` and `site-api`
- CI runs the transport smoke in the production-changing workflows
- the ticket does not implement redirect logic inside the Worker

Owner-run validation:

```bash
npm run test:smoke-transport
```

Orchestrator live verification:

```bash
npm run test:smoke-api
npm run test:smoke-ops
npm run test:smoke-ui -- --url https://pharos.watch --mode live
```

Docs required:
- `docs/testing.md`
- `docs/deployment-process.md`
- `docs/scripts.md`
- `docs/operator-origin-access.md`

Completion artifact:
- PR notes include the live `curl -I` results for `api` and `site-api`

Rollback note:
- rollback is the Cloudflare redirect rule and the smoke/workflow change together; do not move redirect behavior into app code

### `SEC-02`

Branch:
- `hartdrawss/sec-02-diagnostic-sanitization`

Suggested owner:
- single `worker` agent using `gpt-5.4`

Blocked by:
- none

Write scope:
- `worker/src/lib/public-health-assessment.ts`
- `worker/src/api/status-supplements.ts`
- `worker/src/lib/status/data-quality.ts`
- `worker/src/lib/status/evaluation-causes.ts`
- `worker/src/lib/status-evaluation.ts` if needed
- `worker/src/lib/status-reliability.ts` if needed
- `worker/src/lib/status-reliability-shared.ts` if needed
- `src/app/error.tsx`
- `worker/src/api/__tests__/health.test.ts`
- `worker/src/api/__tests__/status.test.ts`
- frontend error-boundary test surface if missing
- `docs/api-reference.md`
- `docs/worker-infrastructure.md`

Forbidden files:
- auth modules
- CORS modules
- API-key modules

Acceptance criteria:
- raw SQL fragments, table names, stack-like details, and upstream exception text do not appear in tested response bodies
- generic error codes and operator-useful safe summaries remain
- production root error boundary no longer renders raw `error.message`

Validation:

```bash
npm test -- worker/src/api/__tests__/health.test.ts worker/src/api/__tests__/status.test.ts
npm run build
```

Docs required:
- `docs/api-reference.md`
- `docs/worker-infrastructure.md`

Completion artifact:
- note the sanitized example responses used to validate the regression

Rollback note:
- keep raw detail in logs; if behavior breaks, rollback should revert response sanitization only, not error logging

### `SEC-03`

Branch:
- `hartdrawss/sec-03-shared-access-jwt`

Suggested owner:
- `worker` agent using `gpt-5.4-mini`

Blocked by:
- none

Write scope:
- `shared/lib/cloudflare-access-jwt.ts`
- `worker/src/lib/jwt-verify.ts`
- `worker/src/lib/auth.ts`
- `worker/src/lib/__tests__/auth.test.ts`
- `worker/src/lib/__tests__/jwt-verify.test.ts`
- verifier-specific test files if split

Forbidden files:
- Pages Functions files
- `functions/lib/ops-env.ts`
- admin proxy route files

Acceptance criteria:
- shared verifier is runtime-neutral and importable from Pages code
- worker behavior is unchanged except for the explicit team-domain requirement
- verifier and JWKS-cache tests cover the extracted implementation

Validation:

```bash
npm test -- worker/src/lib/__tests__/auth.test.ts worker/src/lib/__tests__/jwt-verify.test.ts worker/src/api/__tests__/telegram-webhook-auth.test.ts
cd worker && npx tsc --noEmit
npm run check:worker-boundary
```

Docs required:
- none unless the extraction changes a documented import boundary

Completion artifact:
- list the new shared module and the worker wrapper that now delegates to it

Rollback note:
- keep this ticket behavior-minimal; if rollback is needed, revert the extraction as a unit before `SEC-04` lands

### `SEC-04`

Branch:
- `hartdrawss/sec-04-pages-admin-proxy-hardening`

Suggested owner:
- single `worker` agent using `gpt-5.4`

Blocked by:
- `CTRL-00`
- `SEC-03`

Write scope:
- `functions/api/admin/[[path]].ts`
- `functions/lib/ops-env.ts`
- `functions/lib/ops-origin.ts` if helper expansion is required
- `functions/__tests__/ops-admin-proxy.test.ts`
- `functions/__tests__/ops-env.test.ts`
- `scripts/smoke-ops.mjs`
- `docs/operator-origin-access.md`
- `docs/api-reference.md`
- `docs/testing.md`
- `docs/worker-infrastructure.md`

Forbidden files:
- worker-side API-key logic
- transport smoke files
- unrelated Pages routes

Acceptance criteria:
- missing or invalid UI JWT returns `401` before upstream fetch
- mutating requests with missing or foreign `Origin` return `403` before upstream fetch
- same-origin mutating requests continue to work
- host mismatch remains `404`
- Pages env validation no longer treats `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_OPS_UI_AUD` as merely reserved
- `scripts/smoke-ops.mjs` covers `/api/admin/status`

Owner-run validation:

```bash
npm test -- functions/__tests__/ops-admin-proxy.test.ts functions/__tests__/ops-env.test.ts
npm run build
```

Orchestrator live verification:

```bash
npm run test:smoke-ops
```

Docs required:
- `docs/operator-origin-access.md`
- `docs/api-reference.md`
- `docs/testing.md`
- `docs/worker-infrastructure.md`

Completion artifact:
- PR notes include the request-matrix test cases exercised

Rollback note:
- do not partially revert only origin or only JWT checks; this ticket defines one trust boundary and should roll back as one unit

### `SEC-05`

Branch:
- `hartdrawss/sec-05-api-key-expiry-backend`

Suggested owner:
- `worker` agent using `gpt-5.4`

Blocked by:
- `CTRL-00`

Write scope:
- `worker/migrations/*`
- `worker/migrations/MANIFEST.md`
- `worker/src/lib/api-keys.ts`
- `worker/src/handlers/http/gates.ts`
- `worker/src/api/api-keys.ts`
- `worker/src/route-registry.ts`
- `shared/types/api-keys.ts`
- `worker/src/lib/__tests__/api-keys.test.ts`
- `worker/src/api/__tests__/api-keys.test.ts`
- `docs/api-reference.md`

Forbidden files:
- API-key React components
- admin Pages proxy files
- Telegram rotation files

Acceptance criteria:
- schema migration is backward-compatible and keeps existing keys non-expiring
- backend exposes `expiresAt` per the frozen contract
- omitted `expiresAt` on create defaults to 90 days
- explicit `expiresAt: null` is preserved as non-expiring
- rotate preserves current expiry and does not accept expiry input
- expired keys fail in the real public gate path with `401`

Owner-run validation:

```bash
npm run check:migrations
npm test -- worker/src/lib/__tests__/api-keys.test.ts worker/src/api/__tests__/api-keys.test.ts
cd worker && npx tsc --noEmit
```

Docs required:
- `docs/api-reference.md`

Completion artifact:
- migration name, API contract summary, and the fetch-level expired-key test path

Rollback note:
- if rollback is needed after migration lands, preserve nullable `expires_at`; revert handler behavior before considering schema cleanup

### `SEC-06`

Branch:
- `hartdrawss/sec-06-api-key-expiry-ui`

Suggested owner:
- `worker` agent using `gpt-5.4-mini`

Blocked by:
- `SEC-05`

Write scope:
- `src/components/status/api-keys-panel.tsx`
- `src/hooks/use-api-keys.ts`
- `src/app/admin/sections/control-section.tsx` if wiring changes are required
- matching component tests for the API-key panel
- `src/app/admin/__tests__/client.test.tsx` only if the shell mock contract changes
- `docs/api-reference.md` only if operator workflow details must be clarified

Forbidden files:
- worker migrations
- worker auth gates
- secret-rotation tickets

Acceptance criteria:
- operators can set a concrete expiry or choose an explicit non-expiring exception
- omitted expiry in create flow is represented as “default 90 days”, not as blank ambiguity
- expired and expiring-soon states are visually distinct
- rotate flow does not add expiry controls

Validation:

```bash
npm test -- src/app/admin src/components
npm run build
```

Docs required:
- `docs/api-reference.md` only if user-visible operator workflow changed materially

Completion artifact:
- screenshots or text notes of the create, edit, expired, and expiring-soon states

Rollback note:
- UI rollback must preserve backend contract; do not alter `SEC-05` semantics to simplify the UI

### `SEC-07A`

Branch:
- `hartdrawss/sec-07a-site-secret-overlap`

Suggested owner:
- `worker` agent using `gpt-5.4-mini`

Blocked by:
- `CTRL-00`

Write scope:
- `worker/src/lib/auth.ts`
- `worker/src/lib/env.ts`
- `worker/src/lib/__tests__/env.test.ts`
- `worker/src/lib/__tests__/auth.test.ts`
- `docs/operator-origin-access.md`
- `docs/worker-infrastructure.md`

Forbidden files:
- `functions/_site-data/[[path]].ts`
- `functions/__tests__/site-data-proxy.test.ts`
- `.github/workflows/pages-prepare.yml`
- `scripts/serve-static-export.mjs`
- Telegram webhook files
- API-key files
- admin proxy files

Acceptance criteria:
- receiver accepts `SITE_API_SHARED_SECRET` or `SITE_API_SHARED_SECRET_PREVIOUS`
- Pages proxy and smoke tooling continue emitting only the current secret
- docs define a 24-hour overlap window and explicit cutover sequence

Owner-run validation:

```bash
npm test -- worker/src/lib/__tests__/auth.test.ts worker/src/lib/__tests__/env.test.ts
cd worker && npx tsc --noEmit
```

Docs required:
- `docs/operator-origin-access.md`
- `docs/worker-infrastructure.md`

Completion artifact:
- documented rotation sequence for current -> previous -> remove previous

Rollback note:
- if rollback is needed, keep the previous-secret env name reserved in docs until the deployed runtime is confirmed back on single-secret logic

### `SEC-07B`

Branch:
- `hartdrawss/sec-07b-telegram-secret-overlap`

Suggested owner:
- `worker` agent using `gpt-5.4`

Blocked by:
- `CTRL-00`

Write scope:
- `worker/src/api/telegram-webhook.ts`
- `worker/src/route-registry.ts`
- `worker/src/handlers/http/context.ts`
- `worker/src/handlers/scheduled/five-minute-telegram.ts`
- `worker/src/lib/telegram-webhook-registration.ts`
- `scripts/register-telegram-webhook.sh`
- Telegram webhook tests
- `docs/telegram-alerts.md`
- `docs/worker-infrastructure.md`

Forbidden files:
- site-data proxy files
- API-key files
- admin proxy files

Acceptance criteria:
- receiver accepts `TELEGRAM_WEBHOOK_SECRET` or `TELEGRAM_WEBHOOK_SECRET_PREVIOUS`
- registration and reconciliation flows send only the current secret
- docs define the 24-hour overlap window and cutover sequence

Validation:

```bash
npm test -- worker/src/api/__tests__/telegram-webhook-auth.test.ts worker/src/api/__tests__/telegram-webhook-parsing.test.ts worker/src/api/__tests__/telegram-webhook.test.ts
cd worker && npx tsc --noEmit
```

Docs required:
- `docs/telegram-alerts.md`
- `docs/worker-infrastructure.md`

Completion artifact:
- note the registration path and the receiver path that now honor current-or-previous secrets

Rollback note:
- revert receiver and registration logic together; do not leave docs claiming an overlap model that runtime no longer supports

### `SEC-07C`

Branch:
- `hartdrawss/sec-07c-access-token-rotation-runbook`

Suggested owner:
- `worker` agent using `gpt-5.4-mini`

Blocked by:
- `CTRL-00`
- `SEC-07A`
- `SEC-07B`

Write scope:
- `docs/operator-origin-access.md`
- `docs/testing.md`
- `docs/deployment-process.md` only if deploy-run expectations must mention the rotation sequence

Forbidden files:
- all runtime code
- all workflow files

Acceptance criteria:
- Pages -> `ops-api` service-token rotation owner and sequence are documented
- CI `smoke-ops` token rotation owner and sequence are documented
- operator session-duration ownership from `CTRL-00` is recorded in the canonical docs

Validation:

```bash
npm run build
```

Docs required:
- `docs/operator-origin-access.md`
- `docs/testing.md`

Completion artifact:
- explicit runbook steps with owners and rollback notes for both token lanes

Rollback note:
- doc rollback must not erase owner assignments already adopted operationally; coordinate before reverting

### `SEC-08`

Branch:
- `hartdrawss/sec-08-cors-deny-tightening`

Suggested owner:
- `worker` agent using `gpt-5.4-mini`

Blocked by:
- none

Write scope:
- `worker/src/handlers/http/cors.ts`
- `worker/src/handlers/http/__tests__/cors.test.ts`
- `docs/api-reference.md`
- `docs/operator-origin-access.md`
- `docs/worker-infrastructure.md`

Forbidden files:
- admin proxy files
- transport smoke files
- SQL-safety checker files

Acceptance criteria:
- disallowed preflight returns `403` and no ACAO
- disallowed non-preflight foreign-origin requests omit ACAO
- no-`Origin` behavior is unchanged
- focused tests cover allowed, disallowed preflight, disallowed simple request, and no-`Origin`

Validation:

```bash
npm test -- worker/src/handlers/http/__tests__/cors.test.ts
cd worker && npx tsc --noEmit
```

Docs required:
- `docs/api-reference.md`
- `docs/operator-origin-access.md`
- `docs/worker-infrastructure.md`

Completion artifact:
- note the four-case test matrix

Rollback note:
- revert the CORS helper and focused tests together; do not keep docs on the tightened contract if runtime falls back

### `SEC-09`

Branch:
- `hartdrawss/sec-09-sql-safety-guardrail`

Suggested owner:
- `worker` agent using `gpt-5.4-mini`

Blocked by:
- none

Write scope:
- `scripts/check-sql-interpolation-safety.mjs`
- `scripts/__tests__/sql-interpolation-safety.test.ts`
- `scripts/__tests__/fixtures/sql-safety/`
- `docs/testing.md`
- `docs/scripts.md`

Forbidden files:
- runtime SQL call sites unless needed to adapt to the stricter checker
- workflow files unrelated to the existing validate gate

Acceptance criteria:
- checker covers `worker/src/**` and `worker/scripts/**`
- the four-case fixture matrix exists
- safe allowlist and explicit `// SAFETY:` sites still pass
- unsafe worker and worker-script sites fail with clear diagnostics

Validation:

```bash
npm run check:sql-safety
npm test -- scripts/__tests__/sql-interpolation-safety.test.ts
```

Docs required:
- `docs/testing.md`
- `docs/scripts.md`

Completion artifact:
- list the fixture files and the exact diagnostic example for an unsafe interpolation

Rollback note:
- if false positives force rollback, keep the dedicated regression fixtures so the next revision starts from the same corpus

### `SEC-10`

Branch:
- `hartdrawss/sec-10-closure-and-hygiene`

Suggested owner:
- single `worker` agent using `gpt-5.4`

Blocked by:
- `SEC-01`
- `SEC-04`
- `SEC-05`
- `SEC-07C`
- `SEC-08`
- `SEC-09`

Write scope:
- `.github/workflows/secret-scan.yml`
- `docs/testing.md`
- `docs/operator-origin-access.md`
- `README.md` only if a canonical security-posture pointer is genuinely needed
- [2026-04-04-hartdrawss-closure-matrix.md](/Users/ahirice/Documents/git/stablecoin-dashboard/agents/audits/2026-04-04-hartdrawss-closure-matrix.md)

Forbidden files:
- runtime code
- migrations
- Pages Functions
- worker handlers

Acceptance criteria:
- scheduled + manual secret scan exists and uses an explicit pinned `gitleaks` version
- dependency-audit ownership and response expectation are documented
- operator session-duration ownership is documented in canonical docs
- closure matrix exists and covers every remaining Hartdrawss finding with evidence and reopen trigger

Validation:

```bash
npm run lint
npm test
npm run build
```

Docs required:
- `docs/testing.md`
- `docs/operator-origin-access.md`
- closure matrix under `/agents/audits/`

Completion artifact:
- the closure matrix itself

Rollback note:
- this ticket is serial and convergence-only; if it needs rollback, revert the secret-scan workflow and doc claims together and keep the closure matrix history in the audit corpus

## Dispatch Order

Dispatch tickets in the same sequence as the sequenced backlog. For immediate execution, the recommended opening handoff remains:

1. `CTRL-00`
2. `SEC-01`
3. `SEC-02`
4. `SEC-03`

Do not dispatch `SEC-04` before `CTRL-00` and `SEC-03` are both complete.
