# 2026-04-04 Hartdrawss Dispatch Packets

Inputs:
- [Hartdrawss remediation sequenced ticket backlog](/Users/ahirice/Documents/git/stablecoin-dashboard/agents/plans/2026-04-04-hartdrawss-sequenced-ticket-backlog.md)
- [Hartdrawss ticket verification and orchestration note](/Users/ahirice/Documents/git/stablecoin-dashboard/agents/plans/2026-04-04-hartdrawss-ticket-verification-and-orchestration.md)

Purpose:
- remove the last remaining implementation ambiguity from the Hartdrawss remediation train
- provide dispatch-ready ticket packets for subagent or branch-level execution
- freeze exact decisions so execution does not drift mid-ticket

Execution authority:
- This document is the packet-level authority for Hartdrawss remediation dispatch.
- Use the sequenced backlog for merge order and high-level wave planning.
- Use this file for exact ticket decisions, branch names, acceptance criteria, and forbidden-scope rules.

## Global Hard Decisions

These decisions are now fixed for the implementation train.

### D1. `CTRL-00` output artifact

`CTRL-00` must produce exactly:
- [2026-04-04-hartdrawss-ctrl-00-decisions.md](/Users/ahirice/Documents/git/stablecoin-dashboard/agents/plans/2026-04-04-hartdrawss-ctrl-00-decisions.md)

Required fields in that note:
- `transport_redirect_code_api`
- `transport_redirect_code_site_api`
- `pages_receives_cf_access_jwt_assertion_browser`
- `pages_receives_cf_access_jwt_assertion_service_token`
- `cf_access_team_domain`
- `cf_access_ops_ui_aud`
- `api_key_default_expiry_days`
- `operator_access_session_duration`
- `hard_fail_without_explicit_team_domain`
- `ops_api_service_token_rotation_owner`
- `smoke_ops_service_token_rotation_owner`

Allowed values:
- boolean-style fields must use `yes`, `no`, or `unknown`
- redirect code fields must use `301` or `308`

### D2. `SEC-01` transport verification structure

Decision:
- implement a dedicated `scripts/smoke-transport.mjs`
- do not fold transport assertions into `scripts/smoke-api.mjs`

Reason:
- transport checks are host/protocol-policy assertions, not API contract assertions
- keeping them separate avoids contaminating the HTTPS smoke with cross-host HTTP matrix logic

### D3. `SEC-04` mutating admin-request rule

Decision:
- `GET` and `HEAD` on `ops.pharos.watch/api/admin/*` require a valid UI Access JWT, but do not require `Origin`
- mutating requests on `ops.pharos.watch/api/admin/*` must have:
  - valid UI Access JWT
  - `Origin === OPS_UI_ORIGIN`
- no `Referer` fallback
- no silent downgrade to host-only trust

Failure order:
1. non-ops host => `404`
2. invalid or missing UI JWT => `401`
3. invalid path => `404`
4. method mismatch => `405`
5. mutating request with missing or foreign `Origin` => `403`
6. only then may proxying occur

### D4. `SEC-05` API-key expiry contract

Decision:
- add `expiresAt: number | null` to `ApiKeySummary`
- add `expiresAt?: number | null` to `ApiKeyCreateRequest`
- add `expiresAt?: number | null` to `ApiKeyUpdateRequest`
- `POST /api/api-keys` accepts `expiresAt`
- `POST /api/api-keys/:id/update` accepts `expiresAt`
- `POST /api/api-keys/:id/rotate` does not accept expiry input and preserves the existing `expiresAt`
- list endpoints return all keys, including expired and inactive ones
- auth validity rule is:
  - `isActive === true`
  - and `expiresAt === null || expiresAt > now`
- existing rows remain grandfathered with `expiresAt = null`

Timestamp format:
- UTC Unix epoch seconds

### D5. `SEC-06` API-key UI behavior

Decision:
- the UI surface is [api-keys-panel.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/components/status/api-keys-panel.tsx), not the route shell
- use `datetime-local` inputs in the UI and convert to UTC epoch seconds at the API boundary
- create and update forms expose expiry
- rotate does not change expiry
- token reveal behavior remains one-time and unchanged

Visual state rules:
- `inactive`: `isActive === false`
- `expired`: `isActive === true && expiresAt !== null && expiresAt <= now`
- `active`: `isActive === true && (expiresAt === null || expiresAt > now)`
- `expiringSoon`: `active` and `expiresAt <= now + 7 days`

### D6. `SEC-07A` and `SEC-07B` env-var names

Decision:
- site-data overlap env var: `SITE_API_SHARED_SECRET_PREVIOUS`
- Telegram overlap env var: `TELEGRAM_WEBHOOK_SECRET_PREVIOUS`

Overlap rule:
- current secret remains authoritative
- previous secret exists only for overlap rotation
- target removal window: within 24 hours after successful cutover verification

### D7. `SEC-08` disallowed-origin contract

Decision:
- request with allowlisted `Origin` => echo `Origin`
- request with no `Origin` => preserve current behavior
- request with non-allowlisted `Origin`:
  - `OPTIONS` => `403` with no `Access-Control-Allow-Origin`
  - non-`OPTIONS` => continue normal response path with no `Access-Control-Allow-Origin`

### D8. `SEC-09` SQL-safety fixture matrix

Required regression fixtures:
- safe allowlisted identifier interpolation using `.has(...)`
- safe interpolation with explicit `// SAFETY:` comment
- unsafe interpolation in `worker/src/**`
- unsafe interpolation in `worker/scripts/**`
- non-interpolated SQL should not trigger the check

### D9. `SEC-10` secret-scanning control

Decision:
- implement a repo-owned workflow:
  - `.github/workflows/secret-scan.yml`
- trigger:
  - weekly Monday schedule
  - `workflow_dispatch`
- command:
  - run `gitleaks detect --source . --no-banner --redact --exit-code 1`
- a Docker-based invocation is acceptable and preferred if it avoids repo dependency churn
- do not rely on GitHub-native secret scanning as the only control in this remediation train

Required closure artifact:
- [2026-04-04-hartdrawss-closure-matrix.md](/Users/ahirice/Documents/git/stablecoin-dashboard/agents/audits/2026-04-04-hartdrawss-closure-matrix.md)

## Packet Template Rules

Every ticket packet below defines:
- branch name
- owner mode
- blocked by
- write scope
- forbidden files
- exact decisions
- acceptance criteria
- required validation
- rollback boundary

If a subagent hits a need outside its packet, it must stop and hand control back to the orchestrator.

## Ticket Packets

### `CTRL-00`

Branch:
- `orch/ctrl-00-hartdrawss-preflight`

Owner mode:
- orchestrator only

Blocked by:
- none

Write scope:
- new [2026-04-04-hartdrawss-ctrl-00-decisions.md](/Users/ahirice/Documents/git/stablecoin-dashboard/agents/plans/2026-04-04-hartdrawss-ctrl-00-decisions.md)

Forbidden files:
- all repo code

Exact task:
- produce the decisions file with every required field from `D1`
- include the exact Cloudflare settings or unknown status if not yet discoverable
- if any field remains `unknown`, explicitly call out which downstream ticket is blocked

Acceptance criteria:
- all required fields present
- no prose-only summary without the required key/value fields

Validation:
- manual only

Rollback:
- none

### `SEC-01`

Branch:
- `orch/sec-01-https-transport`

Suggested agent:
- `worker` / `gpt-5.4` / `high`

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
- `docs/operator-origin-access.md` if needed

Forbidden files:
- worker runtime code
- Pages admin proxy files
- CORS files

Exact task:
- add dedicated transport smoke script
- wire it into production-changing workflows
- use the redirect code values captured in `CTRL-00`
- assert exact host/protocol matrix:
  - `http://pharos.watch/`
  - `http://api.pharos.watch/api/health`
  - `http://site-api.pharos.watch/api/stablecoins`
  - `http://ops.pharos.watch/admin/`
  - `http://ops-api.pharos.watch/api/health`

Acceptance criteria:
- `api.pharos.watch` and `site-api.pharos.watch` no longer serve plaintext app responses
- transport smoke checks status and `Location`
- docs name the transport smoke and its place in the deploy path

Validation:

```bash
npm run test:smoke-transport
npm run test:smoke-api
npm run test:smoke-ops
npm run test:smoke-ui -- --url https://pharos.watch --mode live
```

Rollback:
- Cloudflare rule rollback is external
- repo rollback is isolated to smoke/workflow/docs changes

### `SEC-02`

Branch:
- `orch/sec-02-diagnostic-sanitization`

Owner mode:
- single-owner ticket, do not sub-split

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
- one frontend error-boundary test if needed
- `docs/api-reference.md`
- `docs/worker-infrastructure.md`

Forbidden files:
- auth / proxy files
- migration files

Exact task:
- sanitize all response-body error text, not just `sectionErrors`
- keep machine-readable codes
- keep raw details in logs only
- do not change response shapes unless absolutely necessary

Acceptance criteria:
- no tested failure path returns raw SQL, table names, or stack-like text
- `/api/status` no longer leaks raw strings through `causes`, `dataQuality.sourceFailures`, or persistence summaries
- production `src/app/error.tsx` no longer renders raw `error.message`

Validation:

```bash
npm test -- worker/src/api/__tests__/health.test.ts worker/src/api/__tests__/status.test.ts
npm run build
cd worker && npx tsc --noEmit
```

Rollback:
- code-only rollback

### `SEC-03`

Branch:
- `orch/sec-03-shared-access-jwt`

Suggested agent:
- `worker` / `gpt-5.4-mini` / `high`

Blocked by:
- none

Write scope:
- new `shared/lib/cloudflare-access-jwt.ts`
- `worker/src/lib/jwt-verify.ts`
- `worker/src/lib/auth.ts`
- `worker/src/lib/__tests__/auth.test.ts`
- `worker/src/lib/__tests__/jwt-verify.test.ts`

Forbidden files:
- Pages proxy files
- docs except if import path references force one precise doc touch

Exact task:
- extract verifier to shared runtime-neutral module
- keep worker behavior unchanged
- keep `worker/src/lib/jwt-verify.ts` as a thin wrapper if that reduces doc churn

Acceptance criteria:
- worker admin auth behavior unchanged
- shared verifier importable from Pages without boundary violations

Validation:

```bash
npm test -- worker/src/lib/__tests__/auth.test.ts worker/src/lib/__tests__/jwt-verify.test.ts worker/src/api/__tests__/telegram-webhook-auth.test.ts
npm run check:worker-boundary
cd worker && npx tsc --noEmit
```

Rollback:
- code-only rollback

### `SEC-04`

Branch:
- `orch/sec-04-pages-admin-proxy-auth`

Owner mode:
- single-owner ticket, do not sub-split

Blocked by:
- `CTRL-00`
- `SEC-03`

Write scope:
- `functions/api/admin/[[path]].ts`
- `functions/lib/ops-env.ts`
- `functions/lib/ops-origin.ts` if needed
- `functions/__tests__/ops-admin-proxy.test.ts`
- `functions/__tests__/ops-env.test.ts`
- `scripts/smoke-ops.mjs`
- `docs/operator-origin-access.md`
- `docs/api-reference.md`
- `docs/testing.md`
- `docs/worker-infrastructure.md`

Forbidden files:
- API-key files
- site-data proxy files

Exact task:
- implement the exact request matrix from `D3`
- activate Pages-side env contract for `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_OPS_UI_AUD`
- reject missing/invalid UI JWT before upstream fetch
- reject mutating requests with missing or foreign `Origin`
- extend live smoke to exercise `ops.pharos.watch/api/admin/status`

Acceptance criteria:
- no `/api/admin/*` request proxies upstream without first satisfying host + JWT requirements
- mutating cross-site requests fail with `403`
- same-origin valid operator requests still work

Validation:

```bash
npm test -- functions/__tests__/ops-admin-proxy.test.ts functions/__tests__/ops-env.test.ts
npm run build
```

Rollback:
- code-only rollback, but coordinate with Pages env if contract keys were activated

### `SEC-05`

Branch:
- `orch/sec-05-api-key-expiry-backend`

Suggested agent:
- `worker` / `gpt-5.4` / `high`

Blocked by:
- `CTRL-00`

Write scope:
- `worker/migrations/*`
- `worker/migrations/MANIFEST.md`
- `shared/types/api-keys.ts`
- `worker/src/lib/api-keys.ts`
- `worker/src/handlers/http/gates.ts`
- `worker/src/api/api-keys.ts`
- `worker/src/lib/__tests__/api-keys.test.ts`
- new `worker/src/api/__tests__/api-keys.test.ts`
- new focused gate test for expired-key rejection
- `docs/api-reference.md`

Forbidden files:
- `src/components/status/api-keys-panel.tsx`
- `src/hooks/use-api-keys.ts`

Exact task:
- implement the API contract from `D4`
- keep rotate request body unchanged
- add handler tests for list/create/update/rotate expiry fields
- add gate-level or fetch-level test proving expired keys return `401`

Acceptance criteria:
- expired keys fail auth in the real access gate
- create/update list and return expiry coherently
- grandfathered keys still work with `expiresAt = null`

Validation:

```bash
npm run check:migrations
npm test -- worker/src/lib/__tests__/api-keys.test.ts worker/src/api/__tests__/api-keys.test.ts worker/src
cd worker && npx tsc --noEmit
```

Rollback:
- code rollback plus migration remains backward-compatible because new columns are nullable

### `SEC-06`

Branch:
- `orch/sec-06-api-key-expiry-ui`

Suggested agent:
- `worker` / `gpt-5.4-mini` / `high`

Blocked by:
- `SEC-05`

Write scope:
- `src/components/status/api-keys-panel.tsx`
- `src/hooks/use-api-keys.ts`
- `src/app/admin/sections/control-section.tsx` if needed
- new component tests for API-key panel behavior
- `src/app/admin/__tests__/client.test.tsx` only if shell contract changes

Forbidden files:
- worker auth files
- migrations

Exact task:
- implement the UI behavior from `D5`
- add expiry field to create and update flows
- keep rotate flow expiry-neutral
- preserve one-time token reveal

Acceptance criteria:
- create and update send the correct expiry payload
- rotate does not send expiry changes
- active / inactive / expired / expiring-soon states render correctly

Validation:

```bash
npm test -- src/app/admin src/components
npm run build
```

Rollback:
- UI-only rollback after backend is already live-safe

### `SEC-07A`

Branch:
- `orch/sec-07a-site-secret-rotation`

Suggested agent:
- `worker` / `gpt-5.4-mini` / `high`

Blocked by:
- `CTRL-00`

Write scope:
- `worker/src/lib/auth.ts`
- `worker/src/lib/env.ts`
- `worker/src/lib/__tests__/env.test.ts`
- `worker/src/lib/__tests__/auth.test.ts`
- `functions/_site-data/[[path]].ts` only if truly required
- `functions/__tests__/site-data-proxy.test.ts`
- `docs/operator-origin-access.md`
- `docs/worker-infrastructure.md`

Forbidden files:
- `.github/workflows/pages-prepare.yml`
- `scripts/serve-static-export.mjs`
- Telegram files

Exact task:
- implement `SITE_API_SHARED_SECRET_PREVIOUS`
- Worker accepts current or previous
- sender keeps sending current only
- document 24-hour overlap removal target

Acceptance criteria:
- both secrets accepted on worker during overlap
- no sender-side dual-secret logic introduced

Validation:

```bash
npm test -- functions/__tests__/site-data-proxy.test.ts worker/src/lib/__tests__/auth.test.ts worker/src/lib/__tests__/env.test.ts
cd worker && npx tsc --noEmit
```

Rollback:
- code-only rollback

### `SEC-07B`

Branch:
- `orch/sec-07b-telegram-secret-rotation`

Suggested agent:
- `worker` / `gpt-5.4` / `high`

Blocked by:
- `CTRL-00`

Write scope:
- `worker/src/api/telegram-webhook.ts`
- `worker/src/route-registry.ts`
- `worker/src/handlers/http/context.ts`
- `worker/src/handlers/scheduled/five-minute-telegram.ts`
- `worker/src/lib/telegram-webhook-registration.ts`
- `scripts/register-telegram-webhook.sh`
- `worker/src/api/__tests__/telegram-webhook-auth.test.ts`
- `worker/src/api/__tests__/telegram-webhook.test.ts`
- `worker/src/api/__tests__/telegram-webhook-parsing.test.ts`
- `docs/telegram-alerts.md`
- `docs/worker-infrastructure.md`

Forbidden files:
- site-data secret files

Exact task:
- implement `TELEGRAM_WEBHOOK_SECRET_PREVIOUS`
- registration and reconciliation write only the current secret
- request acceptance allows current or previous during overlap
- document 24-hour overlap removal target

Acceptance criteria:
- both secrets accepted during overlap
- registration tooling remains current-secret-only

Validation:

```bash
npm test -- worker/src/api/__tests__/telegram-webhook-auth.test.ts worker/src/api/__tests__/telegram-webhook-parsing.test.ts worker/src/api/__tests__/telegram-webhook.test.ts
cd worker && npx tsc --noEmit
```

Rollback:
- code-only rollback

### `SEC-07C`

Branch:
- `orch/sec-07c-ops-ci-token-runbook`

Suggested agent:
- `worker` / `gpt-5.4-mini` / `medium`

Blocked by:
- `CTRL-00`
- `SEC-07A`
- `SEC-07B`

Write scope:
- `docs/operator-origin-access.md`
- `docs/testing.md`
- `docs/deployment-process.md` only if needed

Forbidden files:
- all runtime code

Exact task:
- document Pages -> `ops-api` token rotation
- document CI `smoke-ops` token rotation
- document operator-session duration ownership

Acceptance criteria:
- runbook clearly states owners, sequence, and validation steps for token rotation

Validation:

```bash
npm run build
```

Rollback:
- docs-only rollback

### `SEC-08`

Branch:
- `orch/sec-08-cors-deny-tightening`

Suggested agent:
- `worker` / `gpt-5.4-mini` / `high`

Blocked by:
- none

Write scope:
- `worker/src/handlers/http/cors.ts`
- new `worker/src/handlers/http/__tests__/cors.test.ts`
- `docs/api-reference.md`
- `docs/operator-origin-access.md`
- `docs/worker-infrastructure.md`

Forbidden files:
- fetch-wide smoke/workflow files
- admin proxy files

Exact task:
- implement the disallowed-origin contract from `D7`
- add focused unit tests in `worker/src/handlers/http/__tests__/cors.test.ts`
- do not rely on the broad `worker/src/__tests__/index.fetch.test.ts` suite as the primary proof

Acceptance criteria:
- disallowed `OPTIONS` returns `403` with no ACAO
- disallowed non-OPTIONS browser-origin requests do not emit ACAO
- no-`Origin` behavior remains unchanged

Validation:

```bash
npm test -- worker/src/handlers/http/__tests__/cors.test.ts
cd worker && npx tsc --noEmit
```

Rollback:
- code-only rollback

### `SEC-09`

Branch:
- `orch/sec-09-sql-safety-guardrail`

Suggested agent:
- `worker` / `gpt-5.4-mini` / `high`

Blocked by:
- none

Write scope:
- `scripts/check-sql-interpolation-safety.mjs`
- new `scripts/__tests__/sql-interpolation-safety.test.ts`
- new `scripts/__tests__/fixtures/sql-safety/*`
- `docs/testing.md`
- `docs/scripts.md`

Forbidden files:
- application runtime modules unless a fixture import requires a tiny helper

Exact task:
- extend scanner scope to `worker/src/**` and `worker/scripts/**`
- implement the fixture matrix from `D8`
- keep false positives bounded

Acceptance criteria:
- unsafe interpolation in either scan surface fails
- safe allowlisted and `// SAFETY:` examples pass

Validation:

```bash
npm run check:sql-safety
npm test -- scripts/__tests__/sql-interpolation-safety.test.ts
```

Rollback:
- script/docs rollback only

### `SEC-10`

Branch:
- `orch/sec-10-closure-matrix-hygiene`

Owner mode:
- single-owner serial convergence ticket

Blocked by:
- `SEC-01`
- `SEC-04`
- `SEC-05`
- `SEC-07C`
- `SEC-08`
- `SEC-09`

Write scope:
- new `.github/workflows/secret-scan.yml`
- `docs/testing.md`
- `docs/operator-origin-access.md`
- optional `README.md` only if needed
- new [2026-04-04-hartdrawss-closure-matrix.md](/Users/ahirice/Documents/git/stablecoin-dashboard/agents/audits/2026-04-04-hartdrawss-closure-matrix.md)

Forbidden files:
- runtime code
- deploy workflows unrelated to secret scanning

Exact task:
- implement the secret-scanning workflow from `D9`
- document dependency-audit ownership and response expectation
- document Access-session duration ownership
- produce one canonical closure matrix with columns:
  - `finding`
  - `final status`
  - `evidence`
  - `reopen trigger`

Acceptance criteria:
- secret leakage has a repo-owned automated detection path
- closure matrix exists and covers every remaining non-applicable or already-mitigated finding
- this ticket stays doc/governance-only apart from the secret-scan workflow

Validation:

```bash
npm run lint
npm test
npm run build
```

Rollback:
- docs/workflow-only rollback

## Dispatch Order

1. `CTRL-00`
2. `SEC-01`, `SEC-02`, `SEC-03`
3. merge `SEC-03`
4. `SEC-04`, `SEC-05`
5. `SEC-06`, `SEC-07A`, `SEC-07B`
6. `SEC-07C`, `SEC-08`, `SEC-09`
7. `SEC-10`

## Final Note

If any packet conflicts with the broader backlog, the packet wins for implementation details and the backlog wins for merge ordering.
