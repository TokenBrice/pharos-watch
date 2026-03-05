# 2026-03-05 Simplification Audit - Autonomous Execution Plan

Status: Planned (not implemented)  
Owner: Codex (autonomous execution after context reset)  
Source: Simplification/deduplication audit findings from 2026-03-05

## 1. Objective

Implement all accepted simplification/refactor recommendations from the audit, excluding explicitly deferred/skipped items.  
Primary target is lower maintenance cost, fewer duplicated patterns, and clearer module boundaries with behavior parity.

## 2. In Scope

All work packages below are in scope:

1. Endpoint contract/routing unification.
2. Shared paginated-event handler scaffold.
3. Shared stablecoin-history handler scaffold.
4. Centralized methodology envelope + shared response wrapper types.
5. Hook fetch/polling standardization on shared query primitives.
6. `status` client decomposition by responsibility.
7. `stablecoin-table` decomposition and pattern convergence.
8. Methodology changelog route/page consolidation.
9. Dead code removal (`tabs` component/dependency, unused hook export).
10. Route error wrapper consistency cleanup.
11. Legacy compatibility shim removal (with prechecks).
12. Continued `sync-stablecoins` stage decomposition.

## 3. Out of Scope (Explicitly Excluded)

1. Refactoring data-heavy catalog files purely for style (`shared/lib/stablecoins.ts`, `shared/lib/dead-stablecoins.ts`).
2. Introducing new generic plugin/framework layers beyond current concrete needs.

## 4. Non-Negotiable Invariants

1. No external API contract regression unless explicitly documented and approved.
2. No scoring/methodology formula changes in this plan.
3. Preserve route method-gating behavior, including `/api/audit-depeg-history?dry-run=true`.
4. Keep cron cadence assumptions and freshness semantics intact.
5. Preserve current Tailwind static-class constraints and shared classification sources.

## 5. Restart Protocol (After Context Reset)

Run this first to rehydrate context:

```bash
cd /home/ahirice/Documents/git/stablecoin-dashboard
git status -sb
git branch --show-current
rg -n "WP-[0-9]{2}" docs/plans/2026-03-05-simplification-audit-autonomous-execution-plan.md
```

Then execute baseline verification:

```bash
npm run build
npm run lint
npm test
cd worker && npx tsc --noEmit
```

If baseline fails, stop and fix baseline before refactor work.

## 6. Work Package Map

| ID | Work Package | Depends On | Primary Areas | Risk |
|----|--------------|------------|---------------|------|
| WP-01 | Dead code + dependency cleanup | none | `src/components/ui`, `src/hooks`, root `package.json` | Low |
| WP-02 | Route error wrapper consistency | none | `src/app/**/error.tsx`, `src/components/create-page-error.tsx` | Low |
| WP-03 | Changelog route/page consolidation | none | `src/app/methodology/*-changelog`, `src/app/methodology/changelog-page-utils.ts` | Low |
| WP-04 | Legacy shim removal (guarded) | WP-06 | `src/hooks/use-blacklist-events.ts`, `worker/src/api/dex-liquidity-history.ts` | Low-Med |
| WP-05 | Hook query/fetch standardization | none | `src/hooks`, `src/lib/api.ts`, `src/hooks/use-api-query.ts` | Med |
| WP-06 | Methodology envelope + shared response types | none | `shared/types`, `worker/src/api/*`, hook consumers | Med |
| WP-07 | Shared paginated-event scaffold | none | `worker/src/api/depeg-events.ts`, `blacklist.ts`, `mint-burn-events.ts`, `worker/src/lib/*` | Med |
| WP-08 | Shared history-endpoint scaffold | none | `worker/src/api/*history*.ts`, `worker/src/lib/api-utils.ts` | Med |
| WP-09 | Endpoint dispatch/routing unification | WP-07, WP-08 | `worker/src/router.ts`, `worker/src/handlers/http.ts`, `shared/lib/api-endpoints.ts` | Med-High |
| WP-10 | Status page decomposition | WP-05 | `src/app/status/client.tsx`, new `src/components/status/*` | Med |
| WP-11 | Stablecoin table decomposition | WP-05 | `src/components/stablecoin-table.tsx`, related hooks/components | Med-High |
| WP-12 | `sync-stablecoins` stage decomposition | none | `worker/src/cron/sync-stablecoins.ts`, `worker/src/cron/sync-stablecoins/stages.ts` | High |

## 7. Execution Order (Mandatory)

1. Phase A: WP-01, WP-02, WP-03.
2. Phase B: WP-05, WP-06.
3. Phase C: WP-07, WP-08.
4. Phase D: WP-09.
5. Phase E: WP-10, WP-11.
6. Phase F: WP-04.
7. Phase G: WP-12.

Reason: low-risk deletions first, then type/query standardization, then backend scaffold extraction, then route convergence, then large UI decompositions, then shim removal, then final cron structural work.

## 8. Detailed Work Packages

### WP-01 - Dead code and dependency cleanup

Targets:

1. Remove `src/components/ui/tabs.tsx`.
2. Remove `@radix-ui/react-tabs` from root `package.json`.
3. Remove unused `useStablecoinsWithMeta` from `src/hooks/use-stablecoins.ts`.

Acceptance:

1. No imports reference removed symbols.
2. Build/lint/tests pass.
3. Net deletion only.

Docs update:

1. If architecture tree references removed files, update `docs/architecture.md`.

### WP-02 - Route error wrapper consistency

Targets:

1. Convert `src/app/stablecoin/[id]/error.tsx` to `createPageError(...)`.
2. Convert `src/app/stablecoins/[peg]/error.tsx` to `createPageError(...)`.

Acceptance:

1. Same rendered error behavior and titles.
2. No duplicate wrapper boilerplate remains for these routes.

Docs update:

1. None expected unless route error docs mention implementation details.

### WP-03 - Methodology changelog page consolidation

Targets:

1. Consolidate six near-identical changelog route wrappers into config-driven generation.
2. Keep route URLs and metadata/canonical paths unchanged.

Acceptance:

1. Existing changelog URLs still resolve.
2. Rendered page content is equivalent.
3. LOC reduced across route wrappers.

Docs update:

1. Update `docs/architecture.md` file-tree notes if route file structure changes.
2. Update `docs/methodology-page.md` if changelog route implementation notes are impacted.

### WP-05 - Hook fetch/query pattern standardization

Targets:

1. Extend shared fetch/query utilities for optional headers/init while preserving current behavior.
2. Migrate manual hooks (`useStatus`, `useHealth`, `useEndpointProbes`, `useBlacklistEvents`, `useDigestSnapshot`) to shared primitives where appropriate.
3. Preserve intentional divergences (`staleTime: Infinity`, probe timeout/abort handling).

Acceptance:

1. Polling timings remain aligned with cron rules.
2. Error/retry behavior is explicit and consistent.
3. No endpoint response shape regressions in consumers.

Docs update:

1. `docs/testing.md` if hook test patterns/fixtures change.
2. `docs/status-dashboard.md` if status polling behavior notes change.

### WP-06 - Methodology envelope + shared response wrapper types

Targets:

1. Add shared response wrappers for depeg/blacklist (and associated schemas if needed) in `shared/types`.
2. Remove duplicated hook-local interfaces for those responses.
3. Add helper(s) for repeated methodology envelope construction across worker handlers.

Acceptance:

1. One canonical methodology envelope shape per domain.
2. Frontend and worker compile against shared types without local redefinition.
3. API response bodies remain backward-compatible unless intentionally revised.

Docs update:

1. `docs/api-reference.md` only if observable response shape changes.
2. `docs/architecture.md` for shared-type ownership notes.

### WP-07 - Shared paginated-event handler scaffold

Targets:

1. Extract shared pagination/query execution scaffold for event endpoints.
2. Migrate depeg, blacklist, and mint-burn event handlers to the scaffold.
3. Keep endpoint-specific validation and mapping logic local.

Acceptance:

1. SQL semantics and pagination behavior stay identical.
2. Freshness header behavior unchanged.
3. Reduced duplicated COUNT/SELECT boilerplate.

Docs update:

1. `docs/api-reference.md` only if behavior changes.
2. `docs/architecture.md` and `docs/worker-infrastructure.md` for new worker helper placement.

### WP-08 - Shared stablecoin-history scaffold

Targets:

1. Extract helper/factory for stablecoin history endpoints.
2. Migrate `supply-history`, `yield-history`, `dex-liquidity-history`, `safety-score-history`.
3. Preserve per-endpoint day bounds and freshness specifics.

Acceptance:

1. Query-param validation remains identical.
2. Response ordering/field naming unchanged.
3. Repeated mapping/response boilerplate reduced.

Docs update:

1. `docs/api-reference.md` only if behavior changes.
2. `docs/architecture.md` for helper placement.

### WP-09 - Endpoint dispatch/routing unification

Targets:

1. Remove split-path handling between `router.ts` and `handlers/http.ts` for static endpoints.
2. Use one dispatch registry for concrete static routes.
3. Keep shared endpoint definitions as metadata contract (method/probe/admin/cache flags).

Acceptance:

1. All current routes still resolve and gate methods/auth correctly.
2. No route path exists in one place but not the other.
3. Existing method-validation tests remain green.

Docs update:

1. `docs/architecture.md` endpoint handling notes.
2. `docs/worker-infrastructure.md` route flow description.

### WP-10 - Status page decomposition

Targets:

1. Split `src/app/status/client.tsx` into focused components under `src/components/status/`.
2. Keep auth-gate and orchestration minimal in page client.
3. Preserve current UI behavior and refresh flow.

Acceptance:

1. No functional diff in status page interactions.
2. Smaller, isolated files with single responsibility.
3. Existing tests/smoke checks for status page pass.

Docs update:

1. `docs/architecture.md` file-tree entries.
2. `docs/status-dashboard.md` if component organization notes exist.

### WP-11 - Stablecoin table decomposition

Targets:

1. Separate row-derivation/sorting/export logic from render code.
2. Align with existing table pattern utilities where feasible.
3. Preserve virtualization and keyboard/prefetch behavior.

Acceptance:

1. Sorting/filtering/export outputs match prior behavior.
2. Virtualization performance is not degraded.
3. Main component complexity is reduced.

Docs update:

1. `docs/architecture.md` component breakdown.
2. `docs/design-language.md` or `docs/testing.md` only if testing/UI conventions change.

### WP-04 - Legacy compatibility shim removal (guarded)

Precondition:

1. WP-06 completed with canonical response typing in place.
2. Confirm production DB schema includes `methodology_version` for `dex_liquidity_history`.
3. Confirm `/api/blacklist` object response is the only supported contract.

Targets:

1. Remove array-response fallback from `use-blacklist-events.ts`.
2. Remove missing-column catch fallback in `dex-liquidity-history.ts`.

Acceptance:

1. No runtime fallback branches remain for deprecated contracts.
2. All related tests pass with current schema/contracts.

Docs update:

1. `docs/api-reference.md` contract clarification if needed.
2. `docs/data-pipeline.md` if fallback behavior was previously documented.

### WP-12 - `sync-stablecoins` continued decomposition

Targets:

1. Move remaining mixed responsibilities from `sync-stablecoins.ts` into stage/helper modules.
2. Keep orchestration in root file and pure transformations in stage files.
3. Preserve all circuit-breaker, fallback, validation, and alerting semantics.

Acceptance:

1. Output payload parity and cron metadata parity.
2. No change in fetch sequencing that violates worker connection budget constraints.
3. Large-file complexity reduced without behavior drift.

Docs update:

1. `docs/data-pipeline.md`.
2. `docs/worker-infrastructure.md`.
3. `docs/worker-and-api-limits.md` if concurrency/fetch strategy details change.

## 9. Validation Gates

Run at the end of each phase:

```bash
npm run build
npm run lint
npm test
cd worker && npx tsc --noEmit
```

Also run focused checks when relevant:

```bash
npm run test:critical-contracts
npm run test:invariants
```

If a gate fails:

1. Stop phase progression.
2. Fix regressions in the same branch before next work package.
3. Re-run full gate.

## 10. Commit Strategy

One commit per work package, in execution order:

1. `refactor(wp-01): remove dead tabs dependency and unused stablecoins meta hook`
2. `refactor(wp-02): standardize dynamic route error wrappers`
3. `refactor(wp-03): consolidate methodology changelog route wrappers`
4. `refactor(wp-05): standardize hook query/fetch primitives`
5. `refactor(wp-06): centralize methodology response envelope and shared wrappers`
6. `refactor(wp-07): extract paginated event endpoint scaffold`
7. `refactor(wp-08): extract stablecoin history endpoint scaffold`
8. `refactor(wp-09): unify worker endpoint dispatch flow`
9. `refactor(wp-10): decompose status page client`
10. `refactor(wp-11): decompose stablecoin table logic`
11. `refactor(wp-04): remove legacy compatibility shims`
12. `refactor(wp-12): continue sync-stablecoins stage extraction`

## 11. Final Definition of Done

1. All in-scope work packages completed.
2. Full validation gates pass.
3. Corresponding docs are updated for every behavior/structure change.
4. No deferred/skip items were touched.
5. Net code complexity and duplication are measurably reduced.

## 12. Appendix A - Exact Anchor Index (Audit Snapshot)

Use this to jump directly into the known hotspots without re-auditing.

Notes:

1. Line numbers are snapshot anchors from 2026-03-05 and can drift.
2. If line numbers moved, use the listed symbol/token search.

### WP-01 Anchors

1. `package.json:33` (`@radix-ui/react-tabs`)
2. `src/components/ui/tabs.tsx:1` (entire file candidate for deletion)
3. `src/hooks/use-stablecoins.ts:22` (`useStablecoinsWithMeta`)

### WP-02 Anchors

1. `src/components/create-page-error.tsx:10` (`createPageError`)
2. `src/app/stablecoin/[id]/error.tsx:5` (`StablecoinError`)
3. `src/app/stablecoins/[peg]/error.tsx:5` (`StablecoinsPegError`)
4. Reference pattern: `src/app/blacklist/error.tsx:5`

### WP-03 Anchors

1. `src/app/methodology/changelog-page-utils.ts:19` (`buildMethodologyChangelogMetadata`)
2. `src/app/methodology/changelog-page-utils.ts:36` (`mapMethodologyChangelogEntries`)
3. `src/app/methodology/depeg-changelog/page.tsx:11` (`PAGE_PATH`)
4. `src/app/methodology/liquidity-score-changelog/page.tsx:11` (`PAGE_PATH`)
5. `src/app/methodology/stability-index-changelog/page.tsx:11` (`PAGE_PATH`)
6. `src/app/methodology/blacklist-tracker-changelog/page.tsx:11` (`PAGE_PATH`)
7. `src/app/methodology/mint-burn-flow-changelog/page.tsx:11` (`PAGE_PATH`)
8. `src/app/methodology/yield-changelog/page.tsx:11` (`PAGE_PATH`)

### WP-05 Anchors

1. `src/hooks/use-api-query.ts:17` (`createPollingQueryOptions`)
2. `src/hooks/use-api-query.ts:43` (`useApiQuery`)
3. `src/hooks/use-api-query.ts:61` (`useApiQueryWithMeta`)
4. `src/hooks/use-status.ts:13`
5. `src/hooks/use-health.ts:13`
6. `src/hooks/use-endpoint-probes.ts:64`
7. `src/hooks/use-blacklist-events.ts:33`
8. `src/hooks/use-digest-snapshot.ts:30`
9. `src/lib/api.ts:97` (`apiFetch`)
10. `src/lib/api.ts:122` (`apiFetchWithMeta`)

### WP-06 Anchors

1. `src/hooks/use-depeg-events.ts:6` (local `DepegEventsResponse`)
2. `src/hooks/use-blacklist-events.ts:8` (local `BlacklistResponse`)
3. `shared/types/index.ts:876` (`DepegDewsMethodologySchema`)
4. `shared/types/index.ts:938` (`BlacklistEvent`)
5. `worker/src/api/depeg-events.ts:60` (`methodology`)
6. `worker/src/api/blacklist.ts:102` (`methodology`)
7. `worker/src/api/peg-summary.ts:202` (`methodology`)
8. `worker/src/api/stability-index.ts:49` and `:126` (`methodology`)
9. `worker/src/api/stress-signals.ts:96` and `:151` (`methodology`)

### WP-07 Anchors

1. `worker/src/lib/db.ts:22` (`buildPaginatedQuery`)
2. `worker/src/api/depeg-events.ts:42` / `:49` / `:60`
3. `worker/src/api/blacklist.ts:58` / `:65` / `:99`
4. `worker/src/api/mint-burn-events.ts:90` / `:95` / `:132`

### WP-08 Anchors

1. `worker/src/lib/api-utils.ts:161` (`parseStablecoinHistoryQuery`)
2. `worker/src/api/supply-history.ts:14`
3. `worker/src/api/yield-history.ts:21`
4. `worker/src/api/dex-liquidity-history.ts:17`
5. `worker/src/api/safety-score-history.ts:24`

### WP-09 Anchors

1. `worker/src/router.ts:53` (`STATIC_ROUTE_HANDLERS`)
2. `worker/src/router.ts:133` / `:139` / `:167` (route consistency checks and dispatch)
3. `worker/src/handlers/http.ts:55` (non-router comment/flow)
4. `worker/src/handlers/http.ts:73` / `:89` / `:136` / `:167` (special endpoint branches)
5. `worker/src/handlers/http.ts:190` (`route(...)` dispatch call)
6. `shared/lib/api-endpoints.ts:37` (`ENDPOINT_DEFINITIONS`)
7. `shared/lib/api-endpoints.ts:433` (`ROUTER_HANDLED_PATHS`)
8. `shared/lib/api-endpoints.ts:454` (`getEndpointDefinition`)
9. `shared/lib/api-endpoints.ts:477` (`validateEndpointMethod`)

### WP-10 Anchors

1. `src/app/status/client.tsx:775` (`StatusClient`)
2. `src/app/status/client.tsx:818` (`StatusDashboard`)
3. `src/app/status/client.tsx:634` (`AdminActionButton`)
4. `src/app/status/client.tsx:712` (`AdminActionsPanel`)
5. `src/app/status/client.tsx:733` (`AdminKeyForm`)
6. `src/app/status/client.tsx:467` (`EndpointHealthGrid`)
7. `src/app/status/client.tsx:569` (`CircuitBreakerTable`)

### WP-11 Anchors

1. `src/components/stablecoin-table.tsx:152` (`StablecoinTable`)
2. `src/components/stablecoin-table.tsx:88` (`ColumnVisibilityDropdown`)
3. `src/components/stablecoin-table.tsx:200` (`filtered`)
4. `src/components/stablecoin-table.tsx:210` (`sorted`)
5. `src/components/stablecoin-table.tsx:308` (`useVirtualizer`)
6. `src/components/stablecoin-table.tsx:326` (`handleCsvExport`)
7. `src/components/stablecoin-table.tsx:547` (`router.push`)

### WP-12 Anchors

1. `worker/src/cron/sync-stablecoins.ts:1` (orchestration + mixed responsibilities)
2. `worker/src/cron/sync-stablecoins.ts:140` (`fetchSilverTokens`)
3. `worker/src/cron/sync-stablecoins.ts:236` (`fetchGoldTokens`)
4. `worker/src/cron/sync-stablecoins.ts:347` (`fetchFiatCoinGeckoTokens`)
5. `worker/src/cron/sync-stablecoins/stages.ts:17` (`filterStructurallyValidAssets`)
6. `worker/src/cron/sync-stablecoins/stages.ts:28` (`normalizeChainCirculating`)
7. `worker/src/cron/sync-stablecoins/stages.ts:77` (`fillMissingSupplyHistory`)
8. `worker/src/cron/sync-stablecoins/stages.ts:177` (`detectPriceStaleness`)

## 13. Appendix B - Baseline Metrics Snapshot (Pre-Implementation)

Captured 2026-03-05.

1. Repository files (`rg --files`): `1283`.
2. Source TS/TSX LOC in main hotspots:
   1. `src/components`: `119 files / 19,556 LOC` (29.4%)
   2. `worker/src/cron`: `34 files / 10,569 LOC` (15.9%)
   3. `src/app`: `62 files / 10,080 LOC` (15.1%)
   4. `shared/lib`: `23 files / 8,504 LOC` (12.8%)
   5. `worker/src/lib`: `51 files / 6,985 LOC` (10.5%)
   6. `worker/src/api`: `43 files / 6,467 LOC` (9.7%)
3. Notable large files relevant to this plan:
   1. `src/app/status/client.tsx` (`935 LOC`)
   2. `src/components/stablecoin-table.tsx` (`742 LOC`)
   3. `worker/src/cron/sync-stablecoins.ts` (`881 LOC`)
   4. `src/app/methodology/scoring-changelog/page.tsx` (`856 LOC`) (separate from 40-line wrappers)

Use this snapshot to confirm net simplification trends after each phase.

## 14. Appendix C - Targeted Verification Matrix (Per Work Package)

Run these in addition to phase gates to reduce reruns.

| WP | Targeted verification |
|----|------------------------|
| WP-01 | `npm run build && npm run lint && npx vitest run src/lib/__tests__/strict-path-drift.test.ts` |
| WP-02 | `npm run build && npm run lint` |
| WP-03 | `npm run build && npm run lint` |
| WP-05 | `npx vitest run src/lib/__tests__/api-fetch-contracts.test.ts src/lib/__tests__/strict-path-drift.test.ts worker/src/api/__tests__/status.test.ts worker/src/api/__tests__/health.test.ts worker/src/api/__tests__/digest-snapshot.test.ts` |
| WP-06 | `npx vitest run worker/src/api/__tests__/depeg-events.test.ts worker/src/api/__tests__/blacklist.test.ts worker/src/api/__tests__/peg-summary.test.ts worker/src/api/__tests__/stability-index.test.ts worker/src/api/__tests__/stress-signals.test.ts` |
| WP-07 | `npx vitest run worker/src/api/__tests__/depeg-events.test.ts worker/src/api/__tests__/blacklist.test.ts worker/src/api/__tests__/mint-burn-events.test.ts` |
| WP-08 | `npx vitest run worker/src/api/__tests__/supply-history.test.ts worker/src/api/__tests__/yield-history.test.ts worker/src/api/__tests__/dex-liquidity-history.test.ts worker/src/api/__tests__/safety-score-history.test.ts` |
| WP-09 | `npx vitest run worker/src/api/__tests__/router-contract.test.ts src/lib/__tests__/strict-path-drift.test.ts src/lib/__tests__/api-endpoints.test.ts worker/src/api/__tests__/feedback.test.ts` |
| WP-10 | `npm run build && npm run lint && npm run test:smoke-ui` |
| WP-11 | `npm run build && npm run lint && npx vitest run src/components/__tests__/liquidity-table.test.ts src/components/__tests__/dews-summary.test.ts` |
| WP-04 | `npx vitest run worker/src/api/__tests__/blacklist.test.ts worker/src/api/__tests__/dex-liquidity-history.test.ts` |
| WP-12 | `npx vitest run worker/src/cron/__tests__/sync-stablecoins.test.ts worker/src/cron/__tests__/sync-yield-data.test.ts && npm run test:invariants` |

After targeted tests: always run full phase gates.

## 15. Appendix D - Locked Decisions and Assumptions

Do not re-open these during implementation unless tests force it:

1. Endpoint methods and auth policy come from `shared/lib/api-endpoints.ts`; behavior parity required.
2. Keep `/api/audit-depeg-history?dry-run=true` GET allowance intact.
3. Keep poll timing rule: `staleTime = cron interval`, `refetchInterval = 2x cron interval`.
4. Keep freshness header semantics and cache-bypass policy behavior.
5. No scoring/methodology formula recalibration in this plan.
6. No new abstraction layer unless there are at least 3 concrete migrated users in same PR.
7. For WP-04, only remove legacy shims after confirming production schema/contract readiness.
8. For WP-12, preserve worker connection-budget constraints; no added parallel fetch bursts.

## 16. Appendix E - Progress Ledger Template

Update this section while executing. Keep most recent entries first.

```md
### Execution Log

| Date (UTC) | WP | Branch | Status | Evidence | Notes |
|------------|----|--------|--------|----------|-------|
| YYYY-MM-DD | WP-XX | refactor/... | started/completed/blocked | commit SHA + key test command | blockers/decisions |
```

```md
### Open Blockers

1. [WP-XX] blocker description, owner, next action.
```

```md
### Resume Cursor

Current WP:
Next file to edit:
Last completed command:
Next command to run:
```
