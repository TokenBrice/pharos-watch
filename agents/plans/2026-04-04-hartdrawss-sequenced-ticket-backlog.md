# 2026-04-04 Hartdrawss Remediation Sequenced Ticket Backlog

Inputs:
- [Hartdrawss thread assessment](/Users/ahirice/Documents/git/stablecoin-dashboard/agents/audits/2026-04-04-hartdrawss-thread-20-issue-assessment.md)
- [Hartdrawss remediation implementation plan](/Users/ahirice/Documents/git/stablecoin-dashboard/agents/plans/2026-04-04-hartdrawss-remediation-implementation-plan.md)

## Objective

Turn the Hartdrawss assessment into an execution-ready backlog that minimizes rollout risk, keeps each security claim independently testable, and preserves code quality by sequencing refactors before behavior changes where that matters.

This backlog is intentionally implementation-oriented:
- each ticket has one primary security claim
- each ticket has bounded write scope
- dependencies are explicit
- validation is specific
- merge order is canonical even where some work can start in parallel

Execution authority:
- This backlog is the canonical sequencing and merge-order document for Hartdrawss remediation.
- Packet-level execution contracts, frozen implementation decisions, forbidden-file boundaries, and dispatch instructions live in [2026-04-04-hartdrawss-dispatch-ready-ticket-packets.md](/Users/ahirice/Documents/git/stablecoin-dashboard/agents/plans/2026-04-04-hartdrawss-dispatch-ready-ticket-packets.md).
- Where the two documents differ, this backlog governs order and dependencies; the dispatch packet document governs ticket-level execution details.
- Earlier ticket numbering in [2026-04-04-hartdrawss-remediation-implementation-plan.md](/Users/ahirice/Documents/git/stablecoin-dashboard/agents/plans/2026-04-04-hartdrawss-remediation-implementation-plan.md) is superseded where it conflicts with this backlog.
- In particular, this backlog splits the former broad `SEC-07` secret-rotation lane into `SEC-07A`, `SEC-07B`, and `SEC-07C`.

## Program Rules

1. One ticket, one branch, one primary owner.
2. Do not combine unrelated findings just to reduce ticket count.
3. Pure refactors land before auth or behavior changes that depend on them.
4. External Cloudflare posture changes must be paired with repo-side verification where possible.
5. Any ticket that changes behavior, API contract, deploy workflow, or operator procedure must update the matching verified docs in the same ticket.
6. Every merged ticket must pass the relevant targeted checks plus the local merge gate before push.

## Orchestrator Model

This program is suitable for subagent-driven execution only if orchestration stays centralized.

Orchestrator responsibilities:
- own `CTRL-00` and any Cloudflare-account-side action
- assign one ticket owner at a time for each locked-file lane
- keep the execution authority in this backlog, not in ad hoc branch notes
- decide when a ticket is allowed to start despite eventual doc conflicts
- rebase sequentially into merge order
- resolve shared-doc collisions during integration
- run wave-end validation and final merge-gate validation
- perform the manual browser / live smoke checks for `SEC-01` and `SEC-04`

Subagent responsibilities:
- implement only the assigned ticket
- stay within the ticket’s write scope
- update the matching docs for that ticket, even if the orchestrator later has to rebase those doc edits
- report blockers instead of silently widening scope

Concurrency guardrails:
- never run two tickets concurrently if they both require the same locked implementation file
- treat `docs/api-reference.md`, `docs/testing.md`, `docs/operator-origin-access.md`, and `docs/worker-infrastructure.md` as orchestrator-mediated merge points even when code lanes are parallel-safe
- keep `SEC-02`, `SEC-04`, and `SEC-10` single-owner tickets; they are not good candidates for deeper sub-splitting

## Validation Baseline

Every code-bearing ticket should run its targeted checks and then, before merge:

```bash
npm run lint
npm run typecheck
npm test
npm run test:merge-gate
```

Additional required gates by surface:

- Worker/runtime changes:

```bash
cd worker && npx tsc --noEmit
```

- Frontend or Pages-impacting changes:

```bash
npm run build
npm run seo:check
```

- Migration-bearing changes:

```bash
npm run check:migrations
```

- SQL safety changes:

```bash
npm run check:sql-safety
```

Live / deploy-path checks when the relevant ticket lands:

```bash
npm run test:smoke-api
npm run test:smoke-ops
npm run test:smoke-ui -- --url https://pharos.watch --mode live
```

## Locked Files And Merge Ownership

These files or zones should not be edited opportunistically by unrelated tickets:

- `functions/api/admin/[[path]].ts`
- `functions/lib/ops-env.ts`
- `functions/lib/ops-origin.ts`
- `shared/lib/cloudflare-access-jwt.ts` if introduced
- `worker/src/lib/auth.ts`
- `worker/src/lib/api-keys.ts`
- `worker/migrations/*`
- `src/app/admin/*` for API-key UI work
- `src/components/status/api-keys-panel.tsx`
- `src/hooks/use-api-keys.ts`
- `worker/src/handlers/http/cors.ts`
- `scripts/check-sql-interpolation-safety.mjs`
- `docs/operator-origin-access.md`
- `docs/api-reference.md`
- `docs/testing.md`
- `docs/deployment-process.md`
- `docs/scripts.md`
- `docs/worker-infrastructure.md`
- `docs/telegram-alerts.md`

If two tickets need the same locked file, the downstream ticket waits.

## Canonical Merge Order

This is the recommended merge order even if some work starts earlier on isolated branches.

| Order | Ticket | Primary finding coverage | Depends on |
| --- | --- | --- | --- |
| 0 | `CTRL-00` | external prerequisites for `#12`, `#13`, `#17`, `#18` | none |
| 1 | `SEC-01` | `#17` | `CTRL-00` |
| 2 | `SEC-02` | `#9` | none |
| 3 | `SEC-03` | prerequisite for `#7`, `#13`, `#18` | none |
| 4 | `SEC-04` | `#7`, `#13`, `#18` | `CTRL-00`, `SEC-03` |
| 5 | `SEC-05` | backend portion of `#12` | `CTRL-00` |
| 6 | `SEC-06` | admin-UI portion of `#12` | `SEC-05` |
| 7 | `SEC-07A` | site-data shared-secret rotation portion of `#12` | `CTRL-00` |
| 8 | `SEC-07B` | Telegram secret rotation portion of `#12` | `CTRL-00` |
| 9 | `SEC-07C` | ops / CI Access-token rotation docs for `#12` | `CTRL-00`, `SEC-07A`, `SEC-07B` |
| 10 | `SEC-08` | `#4` | none |
| 11 | `SEC-09` | `#3` | none |
| 12 | `SEC-10` | `#1`, `#2`, `#5`, `#6`, `#8`, `#10`, `#11`, `#14`, `#15`, `#16`, `#18`, `#19`, `#20` | `SEC-01`, `SEC-04`, `SEC-05`, `SEC-07C`, `SEC-08`, `SEC-09` |

## Optional Parallel Windows

These tickets can be developed in parallel if they stay on separate branches and respect the locked-file list:

- `SEC-01`, `SEC-02`, and `SEC-03`
- `SEC-05` can start once `CTRL-00` decides the API-key expiry policy, even if `SEC-04` is still in flight
- `SEC-07A` and `SEC-07B` can run in parallel after `CTRL-00`
- `SEC-08` and `SEC-09` can run in parallel after the auth-heavy tickets are no longer the critical path

Serial-only tickets:
- `CTRL-00`
- `SEC-04`
- `SEC-10`

Canonical merge order should still be preserved.

## Ticket Packets

### `CTRL-00` External Prerequisites And Policy Capture

Goal:
- Remove ambiguity before any auth, transport, or credential-lifecycle code lands.

Finding coverage:
- prerequisite control for `#12`, `#13`, `#17`, `#18`

Scope:
- Confirm Cloudflare ownership for redirect rules on `api.pharos.watch` and `site-api.pharos.watch`.
- Confirm whether Pages Functions on `ops.pharos.watch` receive `Cf-Access-Jwt-Assertion` for:
  - normal browser-authenticated operator traffic
  - service-token-backed access
- Record the actual `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_OPS_UI_AUD` values needed by Pages.
- Decide the default policy for new API-key expiry.
- Confirm desired Cloudflare Access session duration for operators.
- Decide whether Pages and Worker should hard-fail without explicit `CF_ACCESS_TEAM_DOMAIN` instead of relying on fallback/default behavior.
- Confirm the current service-token rotation owner for:
  - Pages -> `ops-api`
  - CI `smoke-ops`

Out of scope:
- repo code changes
- Cloudflare rule creation itself

Output:
- one short operator note in `/agents/` or issue tracker comment with the confirmed values, owners, and decisions

Validation:
- manual evidence only

Unlocks:
- `SEC-01`
- `SEC-04`
- `SEC-05`
- `SEC-07A`
- `SEC-07B`
- `SEC-07C`

### `SEC-01` HTTPS Enforcement And Transport Smoke

Goal:
- Close the open plaintext-transport gap on production API hosts and make it regress-proof.

Finding coverage:
- `#17`

Scope in:
- Cloudflare Redirect Rules or equivalent edge config for:
  - `api.pharos.watch`
  - `site-api.pharos.watch`
- repo-side transport verification integrated into the existing smoke surface by default
  - a dedicated transport smoke script is acceptable only if extending the current smoke surface proves materially less clear
- CI / deploy workflow integration for that smoke
- related docs

Scope out:
- app-layer redirect logic inside the Worker
- unrelated auth or CORS changes

Planned write scope:
- `scripts/smoke-api.mjs` or a dedicated `scripts/smoke-transport.mjs` if transport checks are split out intentionally
- `package.json`
- `.github/workflows/deploy-cloudflare.yml`
- `.github/workflows/rebuild-pages.yml`
- `docs/testing.md`
- `docs/deployment-process.md`
- `docs/scripts.md`
- `docs/operator-origin-access.md` if host ownership text needs adjustment

Acceptance criteria:
- `http://api.pharos.watch/...` no longer serves plaintext app responses
- `http://site-api.pharos.watch/...` no longer serves plaintext app responses
- transport smoke fails CI on regression
- redirect assertions verify both status (`301` or `308`) and `Location: https://...`
- the HTTP check happens before auth, so `site-api` no longer returns app-layer `401` over plaintext

Targeted validation:

```bash
npm run test:smoke-api
npm run test:smoke-ops
npm run test:smoke-ui -- --url https://pharos.watch --mode live
```

Manual verification:

```bash
curl -I http://pharos.watch/
curl -I http://api.pharos.watch/api/health
curl -I http://site-api.pharos.watch/api/stablecoins
curl -I http://ops.pharos.watch/admin/
curl -I http://ops-api.pharos.watch/api/health
```

Risk notes:
- This ticket mixes account-side and repo-side changes, so land it early and keep it isolated.
- Prefer `308` for API hosts to preserve method semantics.

### `SEC-02` Diagnostic Disclosure Sanitization

Goal:
- Remove raw internal error text from public and admin diagnostic surfaces.

Finding coverage:
- `#9`

Scope in:
- `/api/health` warning sanitization
- `/api/status` response-body error-text sanitization across:
  - `sectionErrors`
  - `dataQuality.sourceFailures`
  - `causes`
  - persistence or discrepancy summaries that currently embed raw error text
- `src/app/error.tsx` production-safe message behavior
- tests for disclosure regression
- matching API/docs updates

Scope out:
- changes to operator logging destinations
- auth changes

Planned write scope:
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
- add/update a frontend error-boundary test if missing
- `docs/api-reference.md`
- `docs/worker-infrastructure.md`

Acceptance criteria:
- tested failure cases do not expose raw SQL/table/stack detail in response bodies
- `/api/status` no longer leaks raw error strings outside the generic error wrappers
- operators still get stable codes and useful generic summaries

Targeted validation:

```bash
npm test -- worker/src/api/__tests__/health.test.ts worker/src/api/__tests__/status.test.ts
npm run build
```

Risk notes:
- Keep raw details in logs; do not silently suppress failure reporting.
- Avoid changing response shape unless truly necessary; prefer changing message content only.

### `SEC-03` Shared Cloudflare Access JWT Verifier Extraction

Goal:
- Move Access JWT verification to a shared runtime-neutral module before Pages begins enforcing it.

Finding coverage:
- prerequisite for `#7`, `#13`, `#18`

Scope in:
- extract verifier from worker-only code into `shared/lib/`
- preserve existing worker behavior and tests
- no auth policy change intended

Scope out:
- Pages proxy enforcement itself
- CSRF/origin enforcement

Planned write scope:
- new `shared/lib/cloudflare-access-jwt.ts` or equivalent
- `worker/src/lib/jwt-verify.ts` or thin wrapper replacement
- `worker/src/lib/auth.ts`
- `worker/src/lib/__tests__/auth.test.ts`
- `worker/src/lib/__tests__/jwt-verify.test.ts`
- any verifier-specific tests migrated or added

Acceptance criteria:
- worker admin auth behavior is unchanged
- Pages can import the verifier without crossing the worker boundary

Targeted validation:

```bash
npm test -- worker/src/lib/__tests__/auth.test.ts worker/src/lib/__tests__/jwt-verify.test.ts worker/src/api/__tests__/telegram-webhook-auth.test.ts
cd worker && npx tsc --noEmit
npm run check:worker-boundary
```

Risk notes:
- Keep this ticket pure. If behavior changes, debugging downstream auth failures gets harder.

### `SEC-04` Pages Admin Proxy Hardening

Goal:
- Make the Pages admin proxy fail closed even if Cloudflare Access posture on `ops.pharos.watch` drifts.

Finding coverage:
- `#7`
- `#13`
- relevant trust-boundary portion of `#18`

Scope in:
- verify inbound UI `Cf-Access-Jwt-Assertion` inside `functions/api/admin/[[path]].ts`
- enforce same-origin evidence for mutating admin requests
  - require same-origin `Origin` for `POST` / `PUT` / `PATCH` / `DELETE`
  - exempt `GET` / `HEAD`
- update Pages env contract for `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_OPS_UI_AUD`
- tests for missing/invalid JWT and bad mutating origin
- related runbook/docs updates

Scope out:
- API-key expiry
- transport smoke

Planned write scope:
- `functions/api/admin/[[path]].ts`
- `functions/lib/ops-env.ts`
- `functions/lib/ops-origin.ts` if helper expansion is needed
- `functions/__tests__/ops-admin-proxy.test.ts`
- `functions/__tests__/ops-env.test.ts`
- `scripts/smoke-ops.mjs`
- `docs/operator-origin-access.md`
- `docs/api-reference.md`
- `docs/testing.md`
- `docs/worker-infrastructure.md`

Acceptance criteria:
- anonymous or invalid-JWT `/api/admin/*` requests on `ops.pharos.watch` fail before proxying
- cross-site mutating requests fail with `403`
- valid same-origin operator requests continue to work

Targeted validation:

```bash
npm test -- functions/__tests__/ops-admin-proxy.test.ts functions/__tests__/ops-env.test.ts
npm run build
```

Manual verification:
- browser verification on `https://ops.pharos.watch/admin/`
- confirm same-origin admin actions still work through the proxy
- verify live smoke covers `https://ops.pharos.watch/api/admin/status` and one safe mutating-path rehearsal

Risk notes:
- This is the highest app-layer auth-risk ticket. Keep it isolated.
- Do not merge until `CTRL-00` confirms the Pages-side Access env values and header behavior.

### `SEC-05` API Key Expiry Backend And Contract Surface

Goal:
- Add lifecycle control to public API keys without breaking existing integrations.

Finding coverage:
- backend portion of `#12`

Scope in:
- backward-compatible D1 schema support for key expiry
- worker-side expiry enforcement
- API contract changes for list/create/update/rotate endpoints
- shared type updates
- tests and docs

Scope out:
- admin UI changes
- forced expiry of existing keys

Planned write scope:
- `worker/migrations/*`
- `worker/migrations/MANIFEST.md`
- `worker/src/lib/api-keys.ts`
- `worker/src/handlers/http/gates.ts`
- relevant admin API handlers for key list/create/update/rotate
- shared types under `shared/`
- `worker/src/lib/__tests__/api-keys.test.ts`
- add or update handler-contract tests for API-key endpoints
- add fetch-level tests that expired keys return `401`
- `docs/api-reference.md`

Acceptance criteria:
- expired keys are rejected
- existing non-expiring keys continue to work until explicitly updated
- list/create/update/rotate APIs expose the new expiry fields coherently
- expired keys are rejected in the actual public access gate, not only in helper-level tests

Targeted validation:

```bash
npm run check:migrations
npm test -- worker/src/lib worker/src/api
cd worker && npx tsc --noEmit
```

Risk notes:
- Keep `expires_at` nullable on first rollout.
- Do not bundle admin UI changes here.

### `SEC-06` API Key Expiry Admin UI And Operator Flows

Goal:
- Expose the new API-key lifecycle controls safely in the operator surface.

Finding coverage:
- UI / operator portion of `#12`

Scope in:
- API-key panel updates for key status, expiry setting, and expiring-soon visibility
- hook/query updates
- any operator-facing explanatory copy
- docs updates specific to key management

Scope out:
- backend schema or auth enforcement

Planned write scope:
- `src/components/status/api-keys-panel.tsx`
- `src/hooks/use-api-keys.ts`
- `src/app/admin/sections/control-section.tsx` if mount-time wiring changes are needed
- matching component tests for the API-key panel
- `src/app/admin/__tests__/client.test.tsx` only if the route-shell mock contract changes
- possibly `docs/api-reference.md` if UX changes reveal operator workflow changes

Acceptance criteria:
- operators can create or update expiries without ambiguity
- expired and expiring-soon keys are visually distinguishable
- the UI does not imply that old grandfathered keys were forcibly changed

Targeted validation:

```bash
npm test -- src/app/admin src/components
npm run build
```

Risk notes:
- Keep the UI aligned with the backend nullable-expiry rollout.
- Do not expand this ticket into broader admin redesign work.

### `SEC-07A` Site-Data Shared-Secret Overlap Rotation

Goal:
- Provide a safe overlap rotation path for `SITE_API_SHARED_SECRET`.

Finding coverage:
- site-data shared-secret portion of `#12`

Scope in:
- dual-secret acceptance for `SITE_API_SHARED_SECRET`
- worker env-contract updates and tests for the overlap model
- runbook documentation for rotating the site-data secret
- note any CI smoke secret-handling considerations for the site-data lane

Scope out:
- API-key expiry
- Pages admin proxy auth
- Telegram webhook secret rotation
- Access-token rotation docs

Planned write scope:
- `worker/src/lib/auth.ts`
- `worker/src/lib/env.ts`
- `worker/src/lib/__tests__/env.test.ts`
- `functions/_site-data/[[path]].ts` only if naming or forwarding changes are needed
- `functions/__tests__/site-data-proxy.test.ts`
- `worker/src/lib/__tests__/auth.test.ts`
- `docs/operator-origin-access.md`
- `docs/worker-infrastructure.md`
- `.github/workflows/pages-prepare.yml` and `scripts/serve-static-export.mjs` only if the overlap model requires smoke-lane adjustments

Acceptance criteria:
- Worker can accept current and previous site secret during rotation window
- documented rotation procedure allows zero- or low-downtime cutover for the site-data lane

Targeted validation:

```bash
npm test -- functions/__tests__/site-data-proxy.test.ts worker/src/lib/__tests__/auth.test.ts worker/src/lib/__tests__/env.test.ts
cd worker && npx tsc --noEmit
```

Risk notes:
- Do not leave dual-secret overlap undocumented; otherwise it becomes permanent accidental complexity.

### `SEC-07B` Telegram Webhook Secret Overlap Rotation

Goal:
- Provide a safe overlap rotation path for the Telegram webhook secret.

Finding coverage:
- Telegram secret portion of `#12`

Scope in:
- dual-secret acceptance for Telegram webhook requests
- any route-context or runtime credential changes required to pass both current and previous secrets
- webhook registration / reconciliation tooling updates
- Telegram runbook updates

Scope out:
- site-data shared secret rotation
- Access-token rotation docs

Planned write scope:
- `worker/src/api/telegram-webhook.ts`
- `worker/src/route-registry.ts`
- `worker/src/handlers/http/context.ts`
- `worker/src/handlers/scheduled/five-minute-telegram.ts`
- `worker/src/lib/telegram-webhook-registration.ts`
- `scripts/register-telegram-webhook.sh`
- related Telegram webhook tests
- `docs/telegram-alerts.md`
- `docs/worker-infrastructure.md`

Acceptance criteria:
- Worker can accept current and previous Telegram webhook secret during rotation window
- manual and auto-registration flows align with the overlap model
- documented rotation procedure allows zero- or low-downtime cutover

Targeted validation:

```bash
npm test -- worker/src/api/__tests__/telegram-webhook-auth.test.ts worker/src/api/__tests__/telegram-webhook-parsing.test.ts worker/src/api/__tests__/telegram-webhook.test.ts
cd worker && npx tsc --noEmit
```

Risk notes:
- Keep the overlap window explicit and short-lived.
- Do not change Telegram delivery behavior beyond the credential acceptance contract.

### `SEC-07C` Ops And CI Access-Token Rotation Runbook

Goal:
- Make ops-host and CI service-token rotation explicit, documented, and independently executable.

Finding coverage:
- Access-token operational portion of `#12`

Scope in:
- document Pages -> `ops-api` service-token rotation
- document CI `smoke-ops` token rotation
- document operator-session duration ownership if not already closed in `CTRL-00`

Scope out:
- runtime auth code changes

Planned write scope:
- `docs/operator-origin-access.md`
- `docs/testing.md`
- `docs/deployment-process.md` only if the rotation procedure affects deploy-run expectations

Acceptance criteria:
- ops and CI token rotation has an explicit documented owner and sequence
- the runbook no longer depends on tribal knowledge

Targeted validation:

```bash
npm run build
```

### `SEC-08` CORS Deny Behavior Tightening

Goal:
- Stop returning a misleading allowlisted ACAO value to disallowed origins.

Finding coverage:
- `#4`

Scope in:
- change CORS behavior for disallowed `Origin`
- update preflight behavior for disallowed origins
- update tests and API docs

Scope out:
- transport enforcement
- admin CSRF protection

Planned write scope:
- `worker/src/handlers/http/cors.ts`
- add or update a focused CORS/request-dispatch test rather than relying only on the full fetch suite
- `docs/api-reference.md`
- `docs/operator-origin-access.md`
- `docs/worker-infrastructure.md`

Acceptance criteria:
- disallowed browser origins no longer receive a false `Access-Control-Allow-Origin`
- behavior is documented and tested
- the disallowed-`OPTIONS` contract is explicit and tested
- no-`Origin` requests retain the intended non-browser behavior

Targeted validation:

```bash
npm test -- worker/src
cd worker && npx tsc --noEmit
```

Risk notes:
- Preserve no-`Origin` behavior for non-browser clients unless there is a deliberate reason to change it.

### `SEC-09` SQL Interpolation Safety Guardrail Expansion

Goal:
- Broaden preventive coverage around dynamic SQL interpolation without changing current runtime behavior.

Finding coverage:
- `#3`

Scope in:
- expand `check-sql-interpolation-safety` coverage beyond current worker-src-only scope
  - explicitly include `worker/scripts/**`
- improve detection shape beyond the current line-based heuristic if feasible
- document the compliant safety pattern

Scope out:
- rewriting existing safe dynamic SQL sites unless the check requires it
- unrelated query refactors

Planned write scope:
- `scripts/check-sql-interpolation-safety.mjs`
- dedicated regression tests under `scripts/__tests__/` for safe and unsafe examples
- `docs/testing.md`
- `docs/scripts.md`

Acceptance criteria:
- risky dynamic SQL in `worker/src/**` and `worker/scripts/**` fails the checker
- safe allowlisted sites still pass cleanly

Targeted validation:

```bash
npm run check:sql-safety
npm test -- scripts/__tests__
```

Risk notes:
- Keep false positives low enough that developers do not route around the guardrail with blanket comments.

### `SEC-10` Repo Hygiene, Posture Docs, And Explicit Finding Closures

Goal:
- Finish the remediation train with one serial governance ticket that records closure evidence and adds the minimum remaining preventive hygiene controls.

Finding coverage:
- `#1`
- `#2`
- `#5`
- `#6`
- `#8`
- `#10`
- `#11`
- `#14`
- `#15`
- `#16`
- residual documentation portion of `#18`
- `#19`
- `#20`

Scope in:
- add one preventive secret-scanning control or enable documented secret-scanning workflow
- document dependency-audit ownership and response expectations
- document Cloudflare Access session-duration ownership for operator logout/session questions
- add one canonical closure matrix:
  - `finding`
  - `final status`
  - `evidence`
  - `reopen trigger`
- preserve current safe posture for:
  - no frontend hardcoded privileged keys
  - no auth storage in browser storage
  - no open redirect relays

Scope out:
- new auth features
- new upload system
- user-account architecture

Planned write scope:
- one workflow or docs/config for secret scanning
- `docs/testing.md` or security/runbook docs for dependency ownership
- `docs/operator-origin-access.md`
- possibly `README.md` or another canonical security posture note if needed
- closure matrix in the Hartdrawss planning corpus under `/agents/`

Acceptance criteria:
- future secret leakage has an explicit automated detection path
- dependency-audit ownership is assigned
- operator session duration ownership is documented
- every remaining Hartdrawss finding is either remediated, preventively guarded, or explicitly closed as not applicable in one canonical matrix

Targeted validation:

```bash
npm run lint
npm test
npm run build
```

Risk notes:
- Keep this ticket doc-heavy and low-risk. Do not let it turn into a generic “security program” rewrite.
- Keep this ticket serial. It is a convergence lane, not a parallel implementation lane.

## Wave View

If branch isolation is available, execute in these waves:

### Wave 0

- `CTRL-00`

### Wave 1

- `SEC-01`
- `SEC-02`
- `SEC-03`

### Wave 2

- `SEC-04`
- `SEC-05`

### Wave 3

- `SEC-06`
- `SEC-07A`
- `SEC-07B`

### Wave 4

- `SEC-07C`
- `SEC-08`
- `SEC-09`
- `SEC-10` after the other Wave 4 tickets are ready

## Exit Criteria

The Hartdrawss remediation train is complete when all of the following are true:

1. `#17` is closed in live production and guarded by smoke.
2. `#9` no longer leaks raw internal detail through tested failure paths.
3. `ops.pharos.watch/api/admin/*` fails closed without relying solely on host-level Access posture.
4. Public API keys have lifecycle control, and long-lived shared secrets have documented rotation paths.
5. CORS deny behavior and SQL interpolation guardrails are stricter than today.
6. Secret scanning and dependency-audit ownership are explicit.
7. All non-applicable Hartdrawss findings are documented in one closure matrix with future-trigger conditions called out.

## Recommended First Three Tickets

If execution starts immediately, the lowest-risk opening sequence is:

1. `CTRL-00`
2. `SEC-01`
3. `SEC-02`

Why:
- `SEC-01` closes the only open P0 and depends on external posture more than code complexity.
- `SEC-02` is a bounded repo-only hardening ticket with a clear regression signature.
- `SEC-03` should follow early, but only after the transport and disclosure work stop competing for reviewer attention.
