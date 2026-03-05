# Maintainability Audit Remediation Implementation Plan

**Date:** 2026-03-04  
**Status:** Proposed (execution-ready)  
**Owner:** Engineering  
**Scope:** Worker + shared frontend contract layers  
**Change policy:** Incremental, no downtime, no behavioral drift unless fixing a confirmed bug

## 1. Objective

Implement all maintainability-audit findings from the 2026-03-04 review in a controlled sequence that:

1. Removes silent-failure paths that can impact data accuracy or operator response.
2. Reduces duplicated business logic across worker cron and API modules.
3. Improves code structure and runtime efficiency without architectural rewrites.
4. Raises confidence through targeted test coverage on high-blast-radius paths.

## 2. Non-Goals

1. No new product features.
2. No scoring formula changes.
3. No API response contract changes (status code/body shape) unless explicitly listed below.
4. No downtime or large data migrations.

## 2.1 Context-Reset Bootstrap (Mandatory)

Use this exact sequence if implementation starts from zero context.

1. Read this file fully before touching code.
2. Read source-of-truth docs:
   1. `docs/architecture.md`
   2. `docs/api-reference.md`
   3. `docs/data-pipeline.md`
   4. `docs/worker-infrastructure.md`
   5. `docs/testing.md`
3. Capture current branch and dirty state:

```bash
git branch --show-current
git status --short
```

4. Create working branch:

```bash
git checkout -b refactor/audit-remediation-2026-03-04
```

5. Run baseline gates (must be green before WS-01):

```bash
npm run lint
npm test
npm run build
cd worker && npx tsc --noEmit
```

6. Record baseline evidence in PR description:
   1. gate outcomes.
   2. `npm run test:coverage` summary line.
   3. known build warnings (see section 2.2).

7. Execute workstreams strictly in section 6 order. Do not reorder.

## 2.2 Known Baseline Snapshot (2026-03-04)

This is the expected starting state for this plan:

1. `npm run lint`: pass.
2. `npm test`: pass (`937` tests).
3. `npm run build`: pass.
4. `cd worker && npx tsc --noEmit`: pass.
5. Build emits warnings to keep visible during remediation:
   1. Next.js static export warning for `rewrites` in `next.config.ts`.
   2. Recharts `width(-1)/height(-1)` prerender warnings.

If your baseline differs, stop and resolve baseline drift before implementing this plan.

## 2.3 Decision Defaults (When Ambiguous)

If a workstream leaves implementation choices open, apply these defaults:

1. Prefer test-first lock for contract-sensitive refactors.
2. Prefer extraction-only PR before behavior-altering PR.
3. Prefer explicit metadata/observability over silent fallback.
4. Prefer fail-closed cache write for core market data.
5. Prefer additive compatibility paths only when existing clients depend on them.

## 3. Findings-to-Workstream Mapping

| Finding ID | Audit Category | Severity | Workstream |
| --- | --- | --- | --- |
| C1 | Production Risk | Critical | WS-01 |
| C2 | Production Risk | Critical | WS-02 |
| C3 | Production Risk | Critical | WS-03 |
| C4 | Production Risk | Critical | WS-04 |
| R1 | Redundancy | High | WS-05 |
| R2 | Redundancy | High | WS-06 |
| R3 | Redundancy | Medium | WS-07 |
| R4 | Redundancy | Medium | WS-08 |
| R5 | Redundancy | Medium | WS-09 |
| Q1 | Code Quality | High | WS-10 |
| Q2 | Code Quality | High | WS-11 |
| Q3 | Code Quality | Medium | WS-12 |
| Q4 | Code Quality | Medium | WS-13 |
| Q5 | Sustainability | High | WS-14 |

## 4. Global Guardrails

1. Preserve all public API contracts; enforce with existing contract tests plus new targeted tests.
2. Prefer extraction and deletion over introducing new abstraction layers with runtime complexity.
3. Keep all refactors resumable: each PR must leave the codebase green and deployable.
4. Every reliability change must add or tighten observability (metadata, logs, or tests).
5. For worker cron changes, preserve lease semantics and subrequest budget behavior.

## 4.1 Immutable Contracts and Invariants

The following are locked and must not drift during remediation:

1. Route/method behavior:
   1. mutating admin routes reject `GET` with `405`, except `/api/audit-depeg-history?dry-run=true`.
   2. unknown API routes still return worker-level `404`.
2. Common API validation errors:
   1. `Missing ?stablecoin= parameter`
   2. `Invalid stablecoin ID`
3. Core cache keys and semantics:
   1. `stablecoins` remains last-known-good canonical list cache.
   2. `yield-rankings`, `report_card_cache`, `fx-rates` key names unchanged.
4. Cron lease and timeout semantics in `worker/src/lib/db.ts` unchanged.
5. Existing response schema compatibility for:
   1. `/api/stablecoins`
   2. `/api/stablecoin/:id`
   3. `/api/status`
   4. `/api/health`

Enforce by running these tests for every PR:

```bash
npm run test -- worker/src/api/__tests__/router-contract.test.ts
npm run test -- worker/src/api/__tests__/cache-passthrough.test.ts
npm run test -- worker/src/api/__tests__/status.test.ts
npm run test -- worker/src/api/__tests__/health.test.ts
npm run test -- src/lib/__tests__/api-fetch-contracts.test.ts
```

## 4.2 Stop-and-Replan Triggers

Stop implementation and re-plan if any occur:

1. A workstream requires changing public API response shape to proceed.
2. Baseline gates fail after a supposedly no-behavior-change extraction.
3. D1 query strategy changes require schema/migration updates not listed here.
4. Worker subrequest budget behavior degrades (timeouts, 429 spikes, or lease churn).
5. Contract tests fail with no clear local fix within the workstream scope.

## 5. Baseline and Validation Gates

Run once before WS-01 and after each workstream PR:

```bash
npm run lint
npm test
npm run build
cd worker && npx tsc --noEmit
```

Targeted suites to use throughout:

```bash
npm run test -- worker/src/cron/__tests__/sync-stablecoins.test.ts
npm run test -- worker/src/api/__tests__/stablecoin-detail.test.ts
npm run test -- worker/src/cron/__tests__/sync-dex-liquidity.test.ts
npm run test -- worker/src/api/__tests__/router-contract.test.ts
npm run test -- worker/src/api/__tests__/status.test.ts
npm run test -- worker/src/api/__tests__/health.test.ts
```

Per-workstream minimum gate (run before moving to next WS):

```bash
npm run lint
npm run test -- worker/src/api/__tests__/router-contract.test.ts
cd worker && npx tsc --noEmit
```

## 6. Execution Order (Locked)

1. WS-02 (C2) - alert transport correctness.
2. WS-01 (C1) - fail-closed stablecoins cache writes.
3. WS-03 (C3) - stablecoin detail resilience and diagnostics.
4. WS-04 (C4) - degraded status propagation in dex-liquidity sync.
5. WS-09 (R5) - shared stablecoins cache loader/parser.
6. WS-08 (R4) - mint/burn staleness config unification.
7. WS-05 (R1) - shared safety score computation.
8. WS-06 (R2) - shared peg analytics derivation.
9. WS-11 (Q2) - sync-yield-data query batching and parse hardening.
10. WS-10 (Q1) - sync-stablecoins decomposition.
11. WS-07 (R3) - endpoint registry drift elimination.
12. WS-13 (Q4) - query hook policy unification.
13. WS-12 (Q3) - dead DB helper removal.
14. WS-14 (Q5) - critical-path coverage ratchet.

Rationale: critical data-integrity and observability risks first, then dedup and structural refactors, then cleanup and coverage ratchet.

## 7. Detailed Workstreams

## WS-01 (C1): Fail-Closed Stablecoins Cache Writes

### Problem

`worker/src/cron/sync-stablecoins.ts` writes schema-invalid payloads to the main `stablecoins` cache on validation failure.

### Files

1. `worker/src/cron/sync-stablecoins.ts`
2. `worker/src/lib/db.ts` (optional helper extraction)
3. `worker/src/cron/__tests__/sync-stablecoins.test.ts`
4. `docs/data-pipeline.md`
5. `docs/worker-infrastructure.md`

### Implementation Steps

1. Introduce a diagnostic cache key (for example `stablecoins:invalid-last`) to store failed normalized payloads.
2. In both schema-failure branches in `syncStablecoins`:
   1. Stop writing invalid payload to `stablecoins`.
   2. Write invalid payload to diagnostic key with timestamp.
   3. Return cron result with `status: "degraded"` and `metadata.validationFailures > 0`.
3. Keep existing alerting call but include:
   1. Validation context (`main` vs `fallback` path).
   2. Truncated issue summary.
   3. Current cache age of last-known-good `stablecoins`.
4. Ensure happy path still writes validated payload to `stablecoins` exactly as today.

### Tests

1. Extend `sync-stablecoins` tests:
   1. Assert main cache key remains unchanged on validation failure.
   2. Assert diagnostic cache key is written.
   3. Assert returned status is `degraded`.
2. Add regression test that valid payload path is unaffected.

### Rollout Safety

1. No schema or endpoint changes.
2. If validation failures spike, rollback is one-commit revert with no data migration.

### Acceptance

1. No code path writes schema-invalid payload to `stablecoins`.
2. Validation failure is visible in cron status + metadata + alert.

## WS-02 (C2): Alert Transport Must Not Fail Silently

### Problem

`worker/src/lib/alerts.ts` treats non-2xx webhook responses as success.

### Files

1. `worker/src/lib/alerts.ts`
2. `worker/src/lib/__tests__/alerts.test.ts` (new)
3. `docs/worker-infrastructure.md`

### Implementation Steps

1. Change `sendAlert` to capture webhook response.
2. If `!res.ok`, log:
   1. HTTP status.
   2. Truncated response text (for example max 300 chars).
   3. Alert title.
3. Return boolean (`true` on accepted send, `false` on failure) while preserving call-site compatibility.
4. Keep send failures non-throwing to avoid cascading cron failures.

### Tests

1. Add unit tests:
   1. returns false and logs on 500 response.
   2. returns true on 2xx.
   3. returns false on thrown fetch error.

### Rollout Safety

1. No behavior change for callers that ignore return value.
2. Improves only observability and correctness of alert delivery accounting.

### Acceptance

1. Non-2xx webhook responses are always logged as failures.
2. Alert transport result is machine-checkable in tests.

## WS-03 (C3): Harden `/api/stablecoin/:id` Upstream Resilience

### Problem

`worker/src/api/stablecoin-detail.ts` uses raw `fetch` in multiple branches without unified retry/timeout policy and drops error context in catch blocks.

### Files

1. `worker/src/api/stablecoin-detail.ts`
2. `worker/src/lib/fetch-retry.ts` (reuse only, no semantic change required)
3. `worker/src/api/__tests__/stablecoin-detail.test.ts`
4. `docs/api-reference.md`

### Implementation Steps

1. Replace raw upstream calls with `fetchWithRetry` and explicit timeout options for:
   1. commodity detail price/protocol fetches.
   2. CoinGecko market chart paths.
   3. default DefiLlama detail fetch.
2. Standardize failure logs with source + stablecoin ID + status.
3. In catch blocks, log structured context before stale-cache fallback or 502.
4. Keep existing cache TTL and fallback behavior unchanged.

### Tests

1. Add/extend tests to cover:
   1. upstream timeout with stale cache fallback.
   2. commodity branch upstream failure without stale cache returns 502.
   3. parse failure path logs and returns stale cache.
2. Verify response shape and status codes unchanged.

### Rollout Safety

1. No contract changes; only resilience and diagnostics improvements.
2. Retry count remains low to avoid load amplification.

### Acceptance

1. All external calls in this handler use unified retry/timeout logic.
2. Failures include source-tagged logs.

## WS-04 (C4): Propagate Degraded Status in DEX Liquidity Cron

### Problem

`worker/src/cron/dex-liquidity/orchestrator.ts` logs many non-fatal source failures but still reports `ok`.

### Files

1. `worker/src/cron/dex-liquidity/orchestrator.ts`
2. `worker/src/cron/__tests__/sync-dex-liquidity.test.ts`
3. `worker/src/api/status.ts` (verify status handling only)
4. `docs/dex-liquidity.md`
5. `docs/status-dashboard.md`

### Implementation Steps

1. Track non-fatal source failures in an in-memory list during sync.
2. Define degradation policy:
   1. `status: "degraded"` if one or more critical source families fail (for example pool crawl + token batch), or if coverage guard nearly trips.
   2. keep `status: "ok"` only when all required source families succeed.
3. Include failure details in cron metadata (`failedSources`, `fallbackMode`, `coverage`).
4. Keep throw behavior for catastrophic failures unchanged.

### Tests

1. Add tests for:
   1. non-catastrophic source failure returns degraded result.
   2. clean run returns ok.
   3. catastrophic source failure still throws.

### Rollout Safety

1. No data-shape changes in API outputs.
2. Status dashboards become more truthful; expect initial increase in degraded statuses.

### Acceptance

1. Source degradation cannot be reported as `ok` silently.
2. Failure metadata is queryable in cron run history.

## WS-05 (R1): Extract Shared Safety Score Computation

### Problem

Safety score logic is duplicated in `sync-yield-data` and `daily-digest`.

### Files

1. `worker/src/lib/safety-scores.ts` (new)
2. `worker/src/cron/sync-yield-data.ts`
3. `worker/src/cron/daily-digest.ts`
4. `worker/src/lib/__tests__/safety-scores.test.ts` (new)
5. `docs/report-cards.md`
6. `docs/digest-pipeline.md`
7. `docs/yield-intelligence.md`

### Implementation Steps

1. Extract shared pipeline into `computeSafetyScoresSnapshot(db, options)`.
2. Support caller-specific options explicitly:
   1. include/exclude NAV tokens.
   2. output mode (`map` vs `full-grades`).
3. Migrate `sync-yield-data` and `daily-digest` to this shared function.
4. Keep existing thresholds and dependency-order behavior unchanged.

### Tests

1. Add parity tests using fixed fixtures:
   1. old call-site outputs vs new shared helper outputs.
2. Keep existing digest and yield tests green.

### Rollout Safety

1. First PR should be extraction + parity only.
2. No optimization changes in same PR.

### Acceptance

1. No copy-pasted scoring loops remain in these files.
2. Caller outputs are bitwise-equivalent on fixture data.

## WS-06 (R2): Extract Shared Peg Analytics Derivation

### Problem

Peg score/current deviation derivation is repeated across `peg-summary`, `report-cards`, and yield safety paths.

### Files

1. `worker/src/lib/peg-analytics.ts` (new)
2. `worker/src/api/peg-summary.ts`
3. `worker/src/api/report-cards.ts`
4. `worker/src/lib/__tests__/peg-analytics.test.ts` (new)
5. `docs/depeg-detection.md`
6. `docs/report-cards.md`

### Implementation Steps

1. Add shared helper to produce:
   1. `eventsByCoin`.
   2. `pegDataById`.
   3. summary counters where needed.
2. Migrate `peg-summary` and `report-cards` to helper.
3. Keep endpoint-specific fields (DEX cross-checks, response wrappers) in endpoint code.

### Tests

1. Contract tests for both endpoints remain unchanged.
2. Add fixture parity tests for shared peg data computation.

### Rollout Safety

1. Avoid touching response serialization in same commit.

### Acceptance

1. Shared peg analytics helper is single implementation path for core derivation logic.

## WS-07 (R3): Eliminate Endpoint Policy Drift

### Problem

Endpoint metadata (`src/lib/api-endpoints.ts`) and worker router/method guards are maintained separately.

### Files

1. `worker/src/router.ts`
2. `worker/src/index.ts`
3. `src/lib/api-endpoints.ts`
4. `worker/src/api/__tests__/router-contract.test.ts`
5. `docs/api-reference.md`

### Implementation Steps

1. Introduce a route contract test matrix that validates:
   1. every endpoint definition is routable.
   2. declared methods map to actual 405/allowed behavior.
   3. mutating admin route GET restrictions are consistent.
2. Optionally move `allowAuditDryRunGet` exception into shared utility to avoid duplicate branch logic.
3. Keep router implementation stable in first pass; prioritize drift detection.

### Tests

1. Expand router-contract tests to iterate `ENDPOINT_DEFINITIONS`.
2. Add method-level assertions by path.

### Rollout Safety

1. Start with tests only; then refactor with contract lock in place.

### Acceptance

1. CI fails when endpoint metadata and route behavior diverge.

## WS-08 (R4): Unify Mint/Burn Staleness Config

### Problem

Major symbols and stale thresholds are duplicated in scheduler and health endpoint.

### Files

1. `worker/src/lib/mint-burn-health-config.ts` (new)
2. `worker/src/index.ts`
3. `worker/src/api/health.ts`
4. `worker/src/api/__tests__/health.test.ts`
5. `docs/mint-burn-flows.md`
6. `docs/status-dashboard.md`

### Implementation Steps

1. Create shared defaults/constants for:
   1. major symbol set.
   2. warn/critical staleness thresholds.
2. Import in both cron scheduler and health endpoint.
3. Keep env override behavior in scheduler; health remains default-based unless explicit extension is added.

### Tests

1. Update health tests for symbol and stale-count behavior with shared config.

### Rollout Safety

1. No endpoint contract changes.

### Acceptance

1. Single source of truth for mint/burn staleness constants.

## WS-09 (R5): Shared Stablecoins Cache Loader

### Problem

Repeated ad-hoc parsing of `stablecoins` cache causes inconsistent error handling and cognitive load.

### Files

1. `worker/src/lib/stablecoins-cache.ts` (new)
2. `worker/src/api/status.ts`
3. `worker/src/api/peg-summary.ts`
4. `worker/src/api/mint-burn-flows.ts`
5. `worker/src/cron/daily-digest.ts`
6. `worker/src/lib/__tests__/stablecoins-cache.test.ts` (new)
7. `docs/data-pipeline.md`

### Implementation Steps

1. Add loader API:
   1. strict mode (throws/returns error object on corrupt payload).
   2. lenient mode (returns empty safe defaults with error reason).
2. Migrate top consumers to loader.
3. Preserve each caller's current fallback semantics (no global behavior change).

### Tests

1. malformed cache.
2. missing keys.
3. legacy array shape fallback where currently required.

### Rollout Safety

1. Migrate in small batches (2-3 consumers per PR).

### Acceptance

1. No direct `JSON.parse(cached.value)` remains in migrated modules.

## WS-10 (Q1): Decompose `sync-stablecoins` Monolith

### Problem

`sync-stablecoins.ts` is oversized and mixes many concerns in one function.

### Files

1. `worker/src/cron/sync-stablecoins.ts`
2. optional split helpers:
   1. `worker/src/cron/sync-stablecoins/fetch-sources.ts`
   2. `worker/src/cron/sync-stablecoins/normalize.ts`
   3. `worker/src/cron/sync-stablecoins/pricing.ts`
   4. `worker/src/cron/sync-stablecoins/persist.ts`
3. `worker/src/cron/__tests__/sync-stablecoins.test.ts`
4. `docs/data-pipeline.md`

### Implementation Steps

1. Extract pure stage helpers without changing logic:
   1. source fetch and fallback decision.
   2. payload normalization and structural validation.
   3. pricing pipeline and fallback.
   4. supply_history backfill.
   5. cache write + post-write depeg jobs.
2. Keep orchestrator `syncStablecoins` as ordered stage runner.
3. Preserve metadata fields and names.

### Tests

1. Existing suite must remain green.
2. Add focused unit tests for newly extracted pure helpers where low cost.

### Rollout Safety

1. Extraction only first; optimization later.

### Acceptance

1. Top-level function has clear stage boundaries and reduced complexity.

## WS-11 (Q2): Remove N+1 Patterns in `sync-yield-data`

### Problem

Per-coin DB queries inside loops increase D1 load and runtime variability.

### Files

1. `worker/src/cron/sync-yield-data.ts`
2. `worker/src/cron/__tests__/sync-yield-data.test.ts`
3. `docs/yield-intelligence.md`
4. `docs/worker-and-api-limits.md`

### Implementation Steps

1. Batch preload previous exchange rates for all candidate IDs in one query.
2. Batch preload historical APY rows for all candidate IDs and group in memory.
3. Batch preload previous TVL rows for all candidate IDs.
4. Replace per-row `JSON.parse(warning_signals)` with safe parse helper.
5. Keep compute formulas identical.

### Tests

1. Existing yield sync tests unchanged.
2. Add regression fixture to assert rank ordering unchanged for fixed sample data.

### Rollout Safety

1. Compare runtime metadata before/after on staging data.

### Acceptance

1. No per-coin query loops for the three batched datasets above.

## WS-12 (Q3): Remove Dead DB Helpers

### Problem

`getOnchainSupply` and `upsertOnchainSupply` are unused in runtime code.

### Files

1. `worker/src/lib/db.ts`
2. `worker/src/lib/__tests__/db-utils.test.ts`
3. `docs/architecture.md`

### Implementation Steps

1. Remove dead exports and associated interfaces if truly unused.
2. Remove or adapt tests accordingly.
3. Confirm no runtime call sites exist.

### Tests

1. Full test suite.
2. `rg` confirmation:

```bash
rg -n "getOnchainSupply|upsertOnchainSupply" worker/src src
```

### Rollout Safety

1. Zero runtime behavior impact.

### Acceptance

1. Dead helpers removed or explicitly reintroduced through real runtime use.

## WS-13 (Q4): Unify Query Hook Polling Policy

### Problem

Some hooks bypass shared query abstractions and duplicate polling/retry settings.

### Files

1. `src/hooks/use-api-query.ts`
2. `src/hooks/use-health.ts`
3. `src/hooks/use-status.ts`
4. `src/hooks/use-endpoint-probes.ts`
5. `src/hooks/__tests__/` (add new tests)
6. `docs/testing.md`

### Implementation Steps

1. Add shared polling helper for non-standard query fns (for example admin headers/custom fetchers).
2. Migrate health/status/probes hooks to helper.
3. Keep endpoint-specific behavior:
   1. status/probes require admin key.
   2. retry counts remain endpoint-specific.

### Tests

1. Hook-level tests for configured `staleTime`, `refetchInterval`, and `retry`.

### Rollout Safety

1. UI-only code path; low production risk.

### Acceptance

1. Polling/retry policy is centralized and intentionally parameterized.

## WS-14 (Q5): Critical-Path Coverage Ratchet

### Problem

Coverage is low in critical modules (`alerts.ts`, `stablecoin-detail.ts`, dex-liquidity orchestrator path).

### Files

1. `worker/src/lib/__tests__/alerts.test.ts` (new)
2. `worker/src/api/__tests__/stablecoin-detail.test.ts` (expand)
3. `worker/src/cron/__tests__/sync-dex-liquidity.test.ts` (expand)
4. `scripts/check-critical-coverage.mjs` (if threshold updates needed)
5. `docs/testing.md`

### Implementation Steps

1. Define explicit per-file minimums for critical modules in coverage gate script.
2. Add tests to hit failure and fallback branches, not only happy paths.
3. Enforce gate in CI for critical files only (do not ratchet full repo in one step).

### Tests

```bash
npm run test:coverage
npm run coverage:critical
```

### Rollout Safety

1. Coverage gate applied only after tests are landed.

### Acceptance

1. Critical modules meet agreed minimum line and branch coverage.

## 8. PR Slicing Plan

1. PR-01: WS-02.
2. PR-02: WS-01.
3. PR-03: WS-03.
4. PR-04: WS-04.
5. PR-05: WS-09 + WS-08.
6. PR-06: WS-05.
7. PR-07: WS-06.
8. PR-08: WS-11.
9. PR-09: WS-10.
10. PR-10: WS-07 + WS-13.
11. PR-11: WS-12 + WS-14.

Each PR must include:

1. Problem statement linked to finding IDs.
2. Before/after behavior notes.
3. Validation command output summary.
4. Docs updates in same PR.

## 9. Risk Register and Mitigations

1. **Risk:** Shared-helper extraction changes scoring output.  
   **Mitigation:** fixture parity tests and staged extraction-only PRs.
2. **Risk:** Fail-closed cache write increases stale-data serving frequency.  
   **Mitigation:** preserve last-known-good cache + explicit degraded metadata/alerts.
3. **Risk:** Query batching in yield sync alters ranking subtly.  
   **Mitigation:** deterministic ranking regression tests with fixed input fixtures.
4. **Risk:** Route policy unification breaks method guards.  
   **Mitigation:** contract test matrix before and after refactor.

## 10. Completion Checklist

1. All WS-01 through WS-14 merged.
2. Full validation gates green.
3. Critical coverage gate green.
4. Docs updated:
   1. `docs/data-pipeline.md`
   2. `docs/dex-liquidity.md`
   3. `docs/yield-intelligence.md`
   4. `docs/report-cards.md`
   5. `docs/api-reference.md`
   6. `docs/testing.md`
5. Post-merge operational review completed on status dashboard for one full daily cycle.

## 11. Per-Workstream Execution Protocol (Mandatory)

Apply this protocol for every WS-XX before moving to the next one.

### 11.1 Entry Checklist

1. Confirm previous workstream merged or cleanly committed.
2. Re-run minimum gate:

```bash
npm run lint
npm run test -- worker/src/api/__tests__/router-contract.test.ts
cd worker && npx tsc --noEmit
```

3. Confirm target files from that workstream are unchanged by unrelated local edits:

```bash
git status --short
```

4. Read the relevant docs listed under that workstream's "Files" section.

### 11.2 Exit Checklist

1. Run workstream-specific tests from that section.
2. Run full gates:

```bash
npm run lint
npm test
npm run build
cd worker && npx tsc --noEmit
```

3. Validate no unintended API drift:

```bash
npm run test -- worker/src/api/__tests__/router-contract.test.ts
npm run test -- worker/src/api/__tests__/cache-passthrough.test.ts
npm run test -- src/lib/__tests__/api-fetch-contracts.test.ts
```

4. Update listed docs in the same commit.
5. Capture a concise "what changed / what was verified" note using template in section 12.

### 11.3 Rollback Rule

If any exit gate fails and fix is not obvious within the current workstream scope:

1. Revert the in-progress changes for that workstream branch state.
2. Record failure reason and failing command output.
3. Re-plan before continuing; do not stack uncertain changes into next workstream.

## 12. Context-Free PR Log Template

Use this template in every PR description or implementation log so any engineer can resume without chat context.

```md
## Workstream
- ID: WS-XX
- Findings covered: C?/R?/Q?

## Scope
- Files changed:
  - path/a.ts
  - path/b.ts

## Contract Locks Checked
- [ ] router-contract
- [ ] cache-passthrough
- [ ] api-fetch-contracts

## Behavior Changes
- Expected:
- Not expected:

## Validation Evidence
- npm run lint: PASS/FAIL
- npm test: PASS/FAIL
- npm run build: PASS/FAIL
- worker tsc --noEmit: PASS/FAIL
- Workstream targeted tests: PASS/FAIL

## Risks / Follow-ups
- Risk:
- Mitigation:
```

## 13. Fast Resume Commands (After Context Wipe)

```bash
git branch --show-current
git status --short
rg -n "WS-0[1-9]|WS-1[0-4]" docs/plans/2026-03-04-maintainability-audit-remediation-implementation-plan.md
npm run lint && npm test && npm run build && (cd worker && npx tsc --noEmit)
```

Then continue from the next incomplete workstream in section 6.
