# Maintainability Audit - Remediation Implementation Plan

Date: 2026-03-13

> Detailed implementation plan for the maintainability audit completed on 2026-03-13.
> Scope is intentionally incremental: fix operator-path correctness first, then remove shared-runtime duplication, then decompose the largest modules, then harden tests and docs.

## Objective

Resolve every issue identified in the 2026-03-13 maintainability audit without downtime, broad architectural rewrites, or unnecessary public contract churn.

The target outcome is:

- one canonical implementation of status data-quality logic
- operator endpoints that degrade explicitly instead of failing before they can report degraded state
- one shared admin-auth interpretation across request classification and endpoint auth
- one shared EVM JSON-RPC / Etherscan / dRPC call stack
- smaller, easier-to-change worker modules in the highest-risk surfaces
- stronger boundary validation for external payloads that feed price, peg, and status data
- tighter regression protection around the production-critical paths that were identified in the audit

## Source Findings Covered

This plan resolves all findings raised in the 2026-03-13 audit:

1. `worker/src/api/status.ts` duplicates the full data-quality implementation that already exists in `worker/src/api/status-data-quality.ts`, and the extracted module is currently dead code.
2. `/api/status` and `/api/health` can fail before they reach their own degraded-mode logic because expensive cache/cron/data queries happen before or outside a safe sentinel path.
3. Admin-auth handling is inconsistent between `worker/src/lib/auth.ts` and `worker/src/handlers/http.ts`, and discovery routes bypass standard error-handling and query-param helpers.
4. EVM `eth_call` / JSON-RPC / Etherscan / dRPC logic is duplicated across multiple worker modules with diverging timeout, fallback, and logging behavior.
5. `worker/src/api/telegram-webhook.ts` is an oversized multi-responsibility module coupling transport, command parsing, state transitions, persistence, and formatting.
6. `worker/src/api/mint-burn-flows.ts` duplicates cache fallback, query orchestration, and response-shaping logic between aggregate and per-coin modes.
7. Small helper logic is copied locally in multiple places (`sumPegBuckets`, `createLeaseOwner`, `rethrowIfAborted`, and similar utility seams).
8. Several small but production-critical collectors (`sync-fx-rates`, `sync-bluechip`, `sync-usds-status`) cast upstream payloads directly instead of validating the boundary with schemas.
9. The worker test harness is still too permissive for the critical paths because `mock-d1.ts` is substring-based and the global Vitest line threshold is only 55%.

## Non-Goals

- No redesign of the worker/router architecture.
- No endpoint removals or path renames.
- No scoring-methodology changes to PSI, DEWS, mint/burn scoring, report cards, liquidity scoring, or peg scoring.
- No broad D1 schema redesign.
- No frontend redesign outside of behavior-preserving API consumer hardening.
- No major dependency upgrades during the same remediation sequence.

## Baseline Confirmation

The following commands passed on the audit baseline before planning:

```bash
npm run lint
npm test
cd worker && npx tsc --noEmit
npm run build
```

This baseline means the remediation plan should be executed as behavior-preserving refactors plus targeted correctness hardening, not as general defect triage.

## Execution Principles

- Prefer additive safeguards before subtractive cleanup.
- Preserve existing endpoint shapes unless the current behavior is actively unsafe or misleading.
- When a helper is introduced, it must replace real duplication or eliminate a production-risk divergence.
- Keep connection-pool behavior unchanged unless a step explicitly improves it and is tested.
- Update application docs whenever operator expectations, API semantics, or module ownership changes.
- Keep router entrypoints and public endpoint paths stable while modules are decomposed underneath them.
- Break the work into independently shippable phases so the plan remains usable after a context reset.

## Verification Gates

### Mandatory gate after every completed phase

```bash
npm run lint
npm test
cd worker && npx tsc --noEmit
npm run build
```

### Targeted suites while developing the relevant phases

```bash
npx vitest run worker/src/api/__tests__/status.test.ts
npx vitest run worker/src/api/__tests__/status-history.test.ts
npx vitest run worker/src/api/__tests__/discovery.test.ts
npx vitest run worker/src/api/__tests__/telegram-webhook.test.ts
npx vitest run worker/src/api/__tests__/mint-burn-flows.test.ts
npx vitest run worker/src/api/__tests__/cache-passthrough.test.ts
npx vitest run worker/src/lib/__tests__/api-utils.test.ts
npx vitest run worker/src/lib/__tests__/auth.test.ts
npx vitest run worker/src/lib/__tests__/live-reserves-store.test.ts
npx vitest run worker/src/cron/__tests__/sync-blacklist.test.ts
npx vitest run worker/src/cron/__tests__/sync-usds-status.test.ts
npx vitest run worker/src/cron/__tests__/sync-fx-rates.test.ts
npx vitest run worker/src/cron/__tests__/sync-bluechip.test.ts
npx vitest run worker/src/cron/__tests__/dispatch-telegram-alerts.test.ts
```

### Smoke gates

Run after Phase 1 and again after Phase 3:

```bash
npm run test:smoke-api -- --base-url https://api.pharos.watch
npm run test:smoke-ui -- --url https://pharos.watch
```

## Docs Expected To Change

The exact set depends on how much behavior is made more explicit, but these documents should be treated as likely update targets:

- `docs/architecture.md`
- `docs/api-reference.md`
- `docs/status-dashboard.md`
- `docs/testing.md`
- `docs/worker-infrastructure.md`
- `docs/worker-and-api-limits.md`
- `docs/blacklist-tracker.md`
- `docs/mint-burn-flows.md`
- `docs/yield-intelligence.md`
- `docs/telegram-alerts.md`

## Recommended Execution Order

```text
Phase 0: Baseline and change isolation
  P0-A capture fixtures and current degraded/failure behavior

Phase 1: Operator-path correctness
  A1 status data-quality consolidation
  A2 status/health degradation hardening
  A3 admin-auth and discovery route convergence

Phase 2: Shared runtime primitives
  B1 EVM call-stack unification
  B2 upstream schema validation for small critical collectors
  B3 low-level helper deduplication

Phase 3: Module decomposition
  C1 telegram webhook decomposition
  C2 mint/burn flows endpoint decomposition

Phase 4: Sustainability closure
  D1 test harness hardening
  D2 critical-path coverage tightening
  D3 docs, file-tree cleanup, and artifact closeout
```

Phase 1 is mandatory before any larger refactor. Phase 4 should not begin until Phases 1-3 have stabilized and baseline fixtures still match intended behavior.

---

## Phase 0 - Baseline And Change Isolation

### P0-A. Capture representative fixtures and failure behavior

**Purpose**

Freeze current behavior before changing degraded-mode logic, auth interpretation, and module boundaries.

**Required actions**

1. Save representative JSON fixtures for:
   - `GET /api/health`
   - `GET /api/status` with a valid admin key
   - `GET /api/status-history?limit=5` with a valid admin key
   - `GET /api/discovery-candidates?status=active` with a valid admin key
   - `GET /api/mint-burn-flows`
   - `POST /api/telegram-webhook?...` using an existing test fixture payload
2. Record current behavior for the three highest-risk semantics that will change:
   - partial D1/query failure handling in `/api/status`
   - admin request classification in `handleHttpRequest()`
   - invalid discovery `limit` / `offset` handling
3. Save the current output of targeted tests before modifications:
   - `status.test.ts`
   - `discovery.test.ts`
   - `telegram-webhook.test.ts`
   - `mint-burn-flows.test.ts`
4. Save a current list of files importing or duplicating:
   - `sumPegBuckets`
   - `createLeaseOwner`
   - `rethrowIfAborted`
   - direct `eth_call` request builders

**Why it matters**

Several phases intentionally change failure semantics without changing primary success responses. Fixtures prevent accidental contract drift.

---

## Phase 1 - Operator-Path Correctness

### A1. Consolidate status data-quality logic and threshold ownership

**Problem**

`worker/src/api/status.ts` carries a full copy of the data-quality logic that already exists in `worker/src/api/status-data-quality.ts`, and the extracted module is unused. The duplicated code also leaves on-chain freshness/divergence thresholds in two places instead of centralizing them.

**Primary files**

- `worker/src/api/status.ts`
- `worker/src/api/status-data-quality.ts`
- `worker/src/lib/status-thresholds.ts`
- `worker/src/api/__tests__/status.test.ts`

**Target state**

- `status.ts` imports `getDataQuality()` and `emptyDataQuality()` from one canonical module.
- `status-data-quality.ts` owns the on-chain stale-window and divergence thresholds used during data-quality synthesis.
- `status.ts` owns policy synthesis, not raw data-quality collection.

**Implementation steps**

1. Compare the duplicate blocks line-by-line and confirm no intentional drift exists.
2. Move the remaining hardcoded constants from `status.ts` / `status-data-quality.ts` into `status-thresholds.ts`.
   - On-chain monitoring active window
   - On-chain stale-row cutoff window
   - Per-coin divergence threshold
3. Delete the duplicate implementations from `status.ts`.
4. Import the shared helpers from `status-data-quality.ts`.
5. Ensure `status.ts` keeps all existing `StatusResponse` synthesis logic unchanged for the first pass.
6. If additional helper extraction becomes necessary, keep it internal to the status API area and do not start broader refactors yet.

**Required tests**

- `worker/src/api/__tests__/status.test.ts`
- add a focused unit test for `status-data-quality.ts` if shared logic grows beyond trivial extraction

**Docs to update**

- `docs/status-dashboard.md`
- `docs/architecture.md` if file responsibility descriptions change materially

**Downstream impacts**

- Any future fix to blacklist gaps, active depeg counts, or on-chain divergence behavior will now land in one place.
- This phase reduces merge-risk for A2 because status behavior will depend on one canonical data loader.

**Risk**

Low. This is primarily deletion of duplicated logic, but it should still be done before broader status hardening so the next phase does not fork behavior again.

### A2. Make `/api/status` and `/api/health` degrade explicitly instead of failing early

**Problem**

Both operator endpoints can fail before they reach their own degraded-mode logic because cache/cron/data queries occur too early or without best-effort wrappers. `buildCacheStatuses()` also suppresses table-query failures without surfacing why freshness went bad.

**Primary files**

- `worker/src/api/status.ts`
- `worker/src/api/health.ts`
- `worker/src/lib/api-utils.ts`
- `worker/src/lib/status-reliability.ts`
- `worker/src/api/__tests__/status.test.ts`
- `worker/src/api/__tests__/health.test.ts`

**Target state**

- A D1/query failure should not turn `/api/status` or `/api/health` into a generic 500 if a degraded payload can still be produced safely.
- Cache freshness failures should be explicit in status causes and health warnings.
- DB sentinel checks should happen before expensive dependent loaders.

**Implementation steps**

1. Introduce a small `bestEffort()` loader helper inside the status/health path or `api-utils.ts` that:
   - catches query failures
   - returns a fallback value
   - captures a structured warning string
2. Move the DB sentinel earlier in `computeRawStatus()` so downstream loaders are skipped or wrapped intentionally when DB health is already broken.
3. Refactor `buildCacheStatuses()` to return diagnostics for per-table freshness-query failures instead of silently swallowing them.
   - Preferred shape: `{ caches, worstRatio, failures }`
   - Keep existing cache entries compatible; add failure diagnostics separately.
4. Update `status.ts` to convert those failures into explicit `causes` entries rather than allowing them to surface only as stale ratios or 500s.
5. Update `health.ts` so query failures cannot present as healthy-looking zeros.
   - Preferred approach: add an additive `warnings` field to `HealthResponse`
   - If contract churn is undesirable, at minimum force degraded/stale status when subqueries fail
6. Keep endpoint paths and success-case field names stable.
7. Re-run smoke API tests before moving on.

**Required tests**

- `worker/src/api/__tests__/status.test.ts`
  - D1 sentinel failure still returns a response payload
  - cache freshness query failure creates an explicit operator-visible cause
  - cron-progress query failure does not crash the route
- `worker/src/api/__tests__/health.test.ts`
  - blacklist-query failure degrades status
  - mint/burn-query failure degrades status
  - warnings field, if added, is populated predictably
- `worker/src/lib/__tests__/api-utils.test.ts`
  - `buildCacheStatuses()` diagnostics behavior

**Docs to update**

- `docs/status-dashboard.md`
- `docs/api-reference.md`
- `docs/worker-infrastructure.md`

**Downstream impacts**

- The admin status page may show additional warning/cause data when internal queries fail.
- Smoke checks may need to account for additive fields in `/api/health`.
- On-call diagnosis improves because operators will see why the route is degraded instead of only seeing stale ratios or a 500.

**Risk**

Medium. This phase changes degraded/failure semantics. Use Phase 0 fixtures and targeted tests to ensure success responses stay stable.

### A3. Unify admin-auth interpretation and harden discovery routes

**Problem**

`requireAdmin()` accepts `X-Admin-Key` and `Authorization: Bearer`, but `handleHttpRequest()` only recognizes `X-Admin-Key` when classifying admin requests for rate limiting. Discovery handlers also bypass `withErrorHandler()` and manual `parseInt()` parsing differs from the rest of the API layer.

**Primary files**

- `worker/src/lib/auth.ts`
- `worker/src/handlers/http.ts`
- `worker/src/router.ts`
- `worker/src/api/discovery.ts`
- `worker/src/api/__tests__/discovery.test.ts`
- `worker/src/lib/__tests__/auth.test.ts`

**Target state**

- All admin request classification flows use one credential parser.
- Discovery handlers participate in the standard API helper layer.
- Invalid query params are handled consistently with the rest of the worker API.

**Implementation steps**

1. Extract a shared credential-reader helper in `auth.ts`.
   - It should parse both `X-Admin-Key` and `Authorization: Bearer`.
   - `requireAdmin()` and `isAdminRequest()` must use the same function.
2. Update `handleHttpRequest()` to use that shared logic when deciding whether to bypass public rate limiting.
3. Add `Authorization` to CORS allowed headers if bearer-auth should be usable cross-origin.
4. Wrap discovery handlers in `withErrorHandler()` or expose wrapped route handlers while keeping the same route wiring.
5. Replace discovery `limit` / `offset` parsing with `parseIntParam()`.
6. Decide and document whether invalid `limit` / `offset` should now return `400` instead of silently defaulting.
   - If changing behavior, update API docs and tests explicitly.
7. Ensure router behavior remains unchanged for valid calls.

**Required tests**

- `worker/src/lib/__tests__/auth.test.ts`
  - bearer and header parsing
  - parity between auth helper and admin request classification
- `worker/src/api/__tests__/discovery.test.ts`
  - invalid `limit`
  - invalid `offset`
  - wrapped error path
- add request-level tests around public rate limiting classification if none exist yet

**Docs to update**

- `docs/api-reference.md`
- `docs/status-dashboard.md` if admin access guidance mentions headers
- `docs/worker-infrastructure.md`

**Downstream impacts**

- Cross-origin admin tooling may need `Authorization` in request headers and CORS support.
- Any scripts or manual curl commands that relied on garbage `limit` / `offset` silently defaulting will need correction.

**Risk**

Low to medium. The code change is localized, but header/CORS behavior is security-sensitive and must be verified carefully.

---

## Phase 2 - Shared Runtime Primitives

### B1. Unify the EVM call stack behind `worker/src/lib/evm-rpc.ts`

**Problem**

Direct `eth_call` / JSON-RPC / Etherscan / dRPC logic is duplicated across `sync-blacklist`, `sync-usds-status`, reserve adapters, and yield sources. These copies diverge in retry policy, timeout handling, error logging, and fallback behavior.

**Primary files**

- `worker/src/lib/evm-rpc.ts`
- `worker/src/cron/sync-blacklist.ts`
- `worker/src/cron/sync-usds-status.ts`
- `worker/src/cron/reserve-adapters/helpers.ts`
- `worker/src/cron/yield-sync/sources.ts`
- any tests covering those callers

**Target state**

- `evm-rpc.ts` exposes the shared primitives needed by all current callers:
  - generic JSON-RPC call
  - `eth_call` returning hex
  - `eth_call` returning `uint256`
  - block-tag support, including historical tags
  - optional Etherscan-proxy fallback when appropriate
- callers keep their domain-specific semantics but stop rebuilding transport logic.

**Implementation steps**

1. Extend `evm-rpc.ts` with the missing primitives instead of creating a second shared file.
2. Preserve existing timeout defaults and fallback order per caller unless intentionally standardized.
3. Migrate callers one at a time:
   - reserve adapter helpers first
   - `sync-usds-status` second
   - `yield-sync/sources` third
   - `sync-blacklist` last, because it has the most domain-specific budget/rate-limit behavior
4. For `sync-blacklist`, keep the subrequest budget and rate-limit wrappers outside the shared helper.
5. Preserve response-body consumption patterns so Worker connection-pool behavior does not regress.
6. Add structured logging at the shared layer only where it does not erase source context.

**Required tests**

- add `worker/src/lib/__tests__/evm-rpc.test.ts` if it does not already exist
- existing caller suites:
  - `worker/src/cron/__tests__/sync-blacklist.test.ts`
  - `worker/src/cron/__tests__/sync-usds-status.test.ts`
  - reserve adapter tests
  - yield source tests that cover on-chain reads

**Docs to update**

- `docs/worker-infrastructure.md`
- `docs/blacklist-tracker.md`
- `docs/yield-intelligence.md`
- `docs/live-reserves.md` if reserve adapters rely on the new shared helper

**Downstream impacts**

- Centralized timeout and fallback policy makes future RPC fixes cheaper and less risky.
- Shared logs may slightly change message text; test snapshots should avoid overfitting log strings.
- This phase lowers the long-term cost of adding future reserve adapters or RPC-based signals.

**Risk**

Medium. The unification touches multiple production-critical jobs, so migrate one caller at a time and keep behavior fixtures from Phase 0.

### B2. Add schema validation to small external collectors

**Problem**

`sync-fx-rates`, `sync-bluechip`, and `sync-usds-status` cast upstream payloads directly. These feeds influence peg references, market health, and cache-passthrough endpoints, so malformed responses should degrade explicitly instead of being trusted by shape assertion.

**Primary files**

- `worker/src/cron/sync-fx-rates.ts`
- `worker/src/cron/sync-bluechip.ts`
- `worker/src/cron/sync-usds-status.ts`
- `worker/src/lib/api-utils.ts`
- related cron tests

**Target state**

- Small external payloads are validated at the boundary.
- Schema failure becomes explicit degraded metadata, not silent coercion.
- Existing fallback paths remain in place.

**Implementation steps**

1. Add small local schemas for:
   - Frankfurter FX payload
   - secondary FX payload
   - Bluechip coin payload
   - USDS `eth_getStorageAt` / `eth_call` result envelope
2. Use `validatePayloadWithSchema()` where it fits, or a small `schema.safeParse()` wrapper if the payload is not stored directly.
3. On validation failure:
   - log a structured warning with source and reason
   - return degraded metadata when cached fallback exists
   - fail the cron only when no safe fallback exists
4. Do not expand this phase into large-schema work for already validated endpoints.

**Required tests**

- `worker/src/cron/__tests__/sync-fx-rates.test.ts`
- `worker/src/cron/__tests__/sync-bluechip.test.ts`
- `worker/src/cron/__tests__/sync-usds-status.test.ts`

**Docs to update**

- `docs/data-pipeline.md`
- `docs/worker-infrastructure.md`

**Downstream impacts**

- Operators will see more explicit degraded metadata when upstreams return malformed payloads.
- Some current malformed-response paths may become degraded instead of silently accepted.

**Risk**

Low. These collectors already have fallback modes; the primary change is making the boundary explicit and observable.

### B3. Deduplicate low-level helpers

**Problem**

Several low-level helpers are copied locally:

- `sumPegBuckets`
- `createLeaseOwner`
- `rethrowIfAborted`
- similar tiny utility seams

**Primary files**

- `shared/lib/supply.ts`
- `worker/src/cron/sync-stablecoins/stages.ts`
- `worker/src/lib/db.ts`
- `worker/src/handlers/scheduled/context.ts`
- `worker/src/lib/abort.ts`
- `worker/src/cron/dex-discovery/orchestrator.ts`
- `worker/src/cron/dex-liquidity/orchestrator.ts`

**Target state**

- Shared behavior lives in one helper per concern.
- Local copies disappear unless there is a deliberate domain-specific difference.

**Implementation steps**

1. Replace local `sumPegBuckets` copies with the shared helper from `shared/lib/supply.ts`.
2. Move `createLeaseOwner` into a single worker-level helper and consume it from both `db.ts` and scheduled runtime context.
3. Add a canonical `rethrowIfAborted()` helper in `worker/src/lib/abort.ts` that supports the stricter semantics needed by both orchestrators.
4. Re-run caller tests after each helper migration rather than doing a single sweep.

**Required tests**

- current caller suites
- add small unit coverage if helper logic becomes non-trivial

**Docs to update**

- only if file ownership or reusable runtime primitives are documented in `docs/architecture.md` or `docs/worker-infrastructure.md`

**Downstream impacts**

- Mostly positive: future fixes will land in one place.
- Very low user-facing impact if behavior is preserved.

**Risk**

Low. This is cleanup, but it should still be batched carefully because some helpers live in hot worker paths.

---

## Phase 3 - Module Decomposition

### C1. Decompose `worker/src/api/telegram-webhook.ts`

**Problem**

The Telegram webhook handler is a 1.5k-line multi-responsibility module that mixes transport, dedup, command parsing, pending-disambiguation state, D1 writes, and reply formatting.

**Primary files**

- `worker/src/api/telegram-webhook.ts`
- `worker/src/api/__tests__/telegram-webhook.test.ts`
- `worker/src/lib/telegram-alerts.ts`
- optionally new helper modules under `worker/src/api/telegram-webhook/`

**Target state**

- The exported handler remains at the same route and keeps the same signature.
- Responsibilities are split into smaller internal modules:
  - command parsing
  - pending-action serialization/deserialization
  - D1 store operations
  - message builders/formatters
  - command handlers

**Implementation steps**

1. Start by extracting pure parsing/formatting helpers first.
2. Next extract D1 read/write helpers for subscribers, subscriptions, and pending disambiguation.
3. Then extract command-handler functions for:
   - `/list`
   - `/subscribe`
   - `/unsubscribe`
   - `/set`
   - `/mute`
   - `/unmutehours`
4. Keep the top-level exported `handleTelegramWebhook()` as a thin coordinator.
5. Do not change command semantics, message copy, or state transitions during the decomposition.

**Required tests**

- keep `worker/src/api/__tests__/telegram-webhook.test.ts` green throughout
- add focused unit tests for extracted parsers/store helpers where useful

**Docs to update**

- `docs/telegram-alerts.md`
- `docs/architecture.md`

**Downstream impacts**

- Easier future bot changes and incident fixes.
- Lower regression blast radius for subscription logic.
- No public endpoint contract changes expected.

**Risk**

Medium. The module is stateful and interaction-heavy; behavior-preserving extraction must be incremental.

### C2. Decompose `worker/src/api/mint-burn-flows.ts`

**Problem**

Aggregate and per-coin modes duplicate fallback-cache handling, query orchestration, hourly aggregation, and response shaping. The file is already large enough that future changes are likely to drift.

**Primary files**

- `worker/src/api/mint-burn-flows.ts`
- `worker/src/api/__tests__/mint-burn-flows.test.ts`
- optionally new helpers under `worker/src/api/mint-burn-flows/`

**Target state**

- Shared logic is extracted into internal helpers, not duplicated between modes.
- Response shapes remain unchanged.
- The top-level handler still dispatches by query mode.

**Implementation steps**

1. Extract cache fallback and freshness-header logic first.
2. Extract shared query helpers:
   - cron snapshot read
   - latest sync timestamp read
   - hourly row aggregation
   - chain aggregation
3. Extract response builders separately for aggregate and per-coin modes.
4. Keep aggregate-only features such as FTQ classification and baseline windows isolated from the simpler per-coin path.
5. Avoid changing SQL semantics in the same PR as module extraction unless a test proves the change is needed.

**Required tests**

- `worker/src/api/__tests__/mint-burn-flows.test.ts`
- any freshness-metadata tests tied to mint/burn endpoints

**Docs to update**

- `docs/mint-burn-flows.md`
- `docs/architecture.md` if internal file boundaries change materially

**Downstream impacts**

- Easier to evolve the endpoint without aggregate/per-coin drift.
- Lower chance of freshness/fallback logic changing in one mode but not the other.

**Risk**

Medium. The endpoint is production-visible and heavily tested; keep SQL and response shapes stable while extracting.

---

## Phase 4 - Sustainability Closure

### D1. Harden the D1 test harness and fill targeted test gaps

**Problem**

`worker/src/api/__tests__/helpers/mock-d1.ts` matches by SQL substring, which is fast but can let tests pass when query structure drifts unexpectedly. Several newly shared seams also deserve direct tests.

**Primary files**

- `worker/src/api/__tests__/helpers/mock-d1.ts`
- `worker/src/lib/__tests__/...`
- `worker/src/api/__tests__/...`

**Target state**

- The mock can support stricter query matching for critical tests.
- Newly extracted/shared logic has direct test coverage.

**Implementation steps**

1. Add optional strict-mode support to `mock-d1.ts`.
   - exact SQL matcher or normalized SQL matcher
   - optional requirement that all configured statements are consumed
2. Migrate critical-path tests first:
   - status
   - discovery
   - mint-burn-flows
   - auth/routing
3. Add dedicated tests for:
   - unified admin credential parsing
   - `buildCacheStatuses()` diagnostics
   - shared EVM RPC helper behavior
   - extracted Telegram parser/store helpers

**Docs to update**

- `docs/testing.md`

**Downstream impacts**

- Test maintenance will be slightly stricter, but the suite will catch more real regressions in SQL shape and control flow.

**Risk**

Low to medium. The main risk is churn in existing tests, not runtime behavior.

### D2. Tighten coverage expectations incrementally

**Problem**

The global Vitest line threshold is only 55%, which is too permissive for the worker surfaces identified in the audit.

**Primary files**

- `vitest.config.ts`
- `scripts/check-critical-coverage.mjs`
- possibly package scripts if gates are adjusted

**Target state**

- Critical-path coverage is harder to regress.
- Any increase in global thresholds is modest and supported by real added tests.

**Implementation steps**

1. Prefer targeted critical-path tightening before large global threshold jumps.
2. Expand `coverage:critical` / `check-critical-coverage.mjs` to include the newly hardened paths:
   - status
   - discovery/admin auth
   - mint-burn-flows
   - EVM RPC shared helper
3. After those tests exist, consider raising the global line threshold from 55 to a modest next step, not a large leap.
4. Keep CI runtime reasonable; do not introduce an overly expensive coverage split in the same change.

**Docs to update**

- `docs/testing.md`

**Downstream impacts**

- Slightly stricter merge gate.
- Better long-term protection for the production-critical worker surfaces.

**Risk**

Low. This phase should come after new coverage is already in place.

### D3. Documentation, file-tree cleanup, and artifact closeout

**Problem**

The remediation changes file ownership, failure semantics, and shared helper locations. Docs and architecture notes must match the new state to keep the codebase maintainable.

**Primary files**

- whichever docs were touched by earlier phases
- `docs/architecture.md`
- `docs/api-reference.md`
- `docs/testing.md`

**Implementation steps**

1. Update docs that describe:
   - `/api/status` and `/api/health` semantics
   - admin auth expectations
   - shared worker runtime helpers
   - Telegram alert subsystem layout
   - mint/burn endpoint structure if internal ownership changed
2. Update architecture file-tree notes for any new helper folders/modules.
3. Delete dead files left behind by the refactors, including `status-data-quality.ts` only if its responsibilities fully move elsewhere.
4. Move this plan into `agents/plans/historical/` only after the work is implemented.

**Verification**

Run the standard gate, then:

```bash
npm run test:smoke-api -- --base-url https://api.pharos.watch
npm run test:smoke-ui -- --url https://pharos.watch
```

**Risk**

Low. This is the closeout phase that prevents the next context reset from losing the new module boundaries and operational expectations.

---

## Recommended PR / Worktree Breakdown

To reduce merge risk and keep the plan executable after a context reset, use this sequence:

1. PR 1: Phase 1 only
   - status duplication removal
   - status/health degradation hardening
   - admin auth + discovery route convergence
2. PR 2: Phase 2 only
   - shared EVM helper expansion and caller migration
   - schema validation for small collectors
   - low-level helper dedupe
3. PR 3: Phase 3 only
   - Telegram webhook decomposition
   - mint/burn flows decomposition
4. PR 4: Phase 4 only
   - stricter tests
   - coverage gate tightening
   - docs and cleanup

If capacity is limited, PR 1 and PR 4 are the minimum mandatory remediation set because they address the highest operational risk and keep the codebase from backsliding.

## Success Criteria

The remediation is complete when all of the following are true:

- there is one canonical implementation of status data-quality collection
- `/api/status` and `/api/health` no longer fail generically under recoverable partial-query failures
- admin request classification and endpoint auth share one credential interpretation
- direct EVM call logic is centralized in one shared worker helper layer
- `telegram-webhook.ts` and `mint-burn-flows.ts` have materially smaller coordination surfaces
- small critical collectors validate upstream payload shape explicitly
- critical-path tests and coverage gates include the newly hardened surfaces
- docs reflect the new ownership and degraded-mode semantics
