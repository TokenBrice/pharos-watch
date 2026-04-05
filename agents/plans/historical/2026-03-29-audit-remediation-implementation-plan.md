# Audit Remediation Implementation Plan

Date: 2026-03-29
Source audit: [`agents/audits/2026-03-29-codebase-audit.md`](/Users/ahirice/Documents/git/stablecoin-dashboard/agents/audits/2026-03-29-codebase-audit.md)
Goal: remediate all 27 findings from the 2026-03-29 full-codebase audit with staged, reviewable changes that preserve behavior unless a finding is explicitly a bug or operational hardening issue.

## Program Constraints

1. Do not attempt all 27 findings in one branch.
2. Ship in small PRs aligned to one workstream at a time.
3. Add or tighten regression tests before large structural splits.
4. Preserve API contracts and D1 compatibility unless a workstream explicitly changes an internal implementation detail only.
5. If a workstream changes methodology implementation surfaces, update `/methodology`, the relevant changelog/timeline doc, and `docs/`.
6. For every PR, run `npm run test:merge-gate` before push.

## Required Validation Baseline

Every workstream PR must pass:

- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run test:merge-gate`

Worker-heavy workstreams must also pass:

- `cd worker && npx tsc --noEmit`

Pages/frontend-heavy workstreams must also pass:

- `npm run build`

Documentation or methodology workstreams must also pass when touched:

- `npm run check:doc-sync`

## Sequencing Principles

1. Fix production-hardening and authentication/config gaps first.
2. Land low-risk dedupe and observability improvements before major file splits.
3. Consolidate shared semantics before migrating multiple consumers.
4. Treat hotspot decomposition as a follow-on once behavior is characterized by tests.
5. Update the hotspot ratchet baseline and hotspot backlog only after a decomposition workstream lands and stabilizes.

## Workstream Map

| Workstream | Findings Covered | PR Count | Priority |
| --- | --- | ---: | --- |
| WS1. Operational Hardening | `S1`, `S2` | 1 | Highest |
| WS2. Digest Parser + Observability Quick Wins | `R2`, `Q1`, `Q4`, `S9` | 1-2 | High |
| WS3. Client Persistence + UI Deduplication | `R3`, `R4`, `R6`, `R7`, `Q5` | 2-3 | High |
| WS4. Chain Health Canonicalization | `R5` | 1 | Medium |
| WS5. Route Metadata and Admin Route Unification | `R8`, `S7` | 1-2 | High |
| WS6. Status Reliability Decomposition | `Q3` | 1-2 | High |
| WS7. Digest Platform Consolidation | `R1`, `Q2`, `S4` | 2-3 | High |
| WS8. Stablecoin Sync Decomposition | `S3` | 2-3 | High |
| WS9. Blacklist Sync Decomposition | `S5` | 1-2 | High |
| WS10. Live Reserves Store Decomposition | `S6` | 2-3 | High |
| WS11. Frontend Hotspot Decomposition | `Q6`, `Q7`, `S8` | 2-3 | Medium |
| WS12. Test, Content, and Tooling Follow-Through | `Q8`, `Q9`, `S10` | 1-2 | Medium |

Total planned coverage: 27 of 27 findings.

## Finding-to-Workstream Index

| Finding | Workstream |
| --- | --- |
| `R1` | `WS7` |
| `R2` | `WS2` |
| `R3` | `WS3` |
| `R4` | `WS3` |
| `R5` | `WS4` |
| `R6` | `WS3` |
| `R7` | `WS3` |
| `R8` | `WS5` |
| `Q1` | `WS2` |
| `Q2` | `WS7` |
| `Q3` | `WS6` |
| `Q4` | `WS2` for decode standardization, `WS6` for status module follow-through |
| `Q5` | `WS3` |
| `Q6` | `WS11` |
| `Q7` | `WS11` |
| `Q8` | `WS12` |
| `Q9` | `WS12` |
| `S1` | `WS1` |
| `S2` | `WS1` |
| `S3` | `WS8` |
| `S4` | `WS7` |
| `S5` | `WS9` |
| `S6` | `WS10` |
| `S7` | `WS5` |
| `S8` | `WS11` |
| `S9` | `WS2` |
| `S10` | `WS12` |

## Phase Order

### Phase 1. Production Hardening and Low-Risk Consolidation

- `WS1`
- `WS2`
- `WS3`
- `WS4`

### Phase 2. Router and Shared Service Boundary Cleanup

- `WS5`
- `WS6`

### Phase 3. Core Worker Pipeline Consolidation

- `WS7`
- `WS8`
- `WS9`
- `WS10`

### Phase 4. Remaining Frontend Hotspots and Follow-Through

- `WS11`
- `WS12`

## Workstream Details

## WS1. Operational Hardening

Scope: `S1`, `S2`
Priority: Highest
Suggested PR count: 1
Risk: Low-to-moderate

### Objective

Close the two concrete operational gaps first: JWT verification after Cloudflare Access key rotation, and insecure rate-limit salt fallback behavior.

### Files In Scope

- `worker/src/lib/jwt-verify.ts`
- `worker/src/lib/__tests__/jwt-verify.test.ts`
- `worker/src/lib/env.ts`
- `worker/src/handlers/http/gates.ts`
- deploy/config validation surfaces touched by env contract checks
- `docs/worker-infrastructure.md`
- `docs/deployment-process.md`

### Implementation Steps

1. Update JWKS lookup flow.
   - Keep the current cache.
   - On unknown `kid`, bypass the cache once and refetch JWKS.
   - Retry key lookup using the refreshed key set.
   - Preserve fail-closed behavior if refetch still cannot resolve the key.

2. Tighten the public API rate-limit salt contract.
   - Keep the fallback only for explicit local/dev scenarios if needed.
   - Treat missing `PUBLIC_API_RATE_LIMIT_SALT` as a production config error.
   - Make validation/deploy surfaces fail fast instead of warning once and continuing.

3. Document the new env requirement and expected deploy behavior.

### Validation

- `npm test -- worker/src/lib/__tests__/jwt-verify.test.ts`
- `npm run lint`
- `npm run typecheck`
- `cd worker && npx tsc --noEmit`
- `npm run test:merge-gate`

### Definition Of Done

- Valid admin JWTs survive Cloudflare Access key rotation.
- Production no longer runs public rate limiting on a checked-in fallback salt.
- Deploy/docs reflect the stricter env contract.

## WS2. Digest Parser + Observability Quick Wins

Scope: `R2`, `Q1`, `Q4`, `S9`
Priority: High
Suggested PR count: 1-2
Risk: Moderate

### Objective

Remove duplicated digest parsing, standardize malformed-JSON observability, and add missing weekly recap behavior tests before larger digest refactors.

### Files In Scope

- `worker/src/cron/weekly-recap.ts`
- `worker/src/cron/daily-digest/response.ts`
- `worker/src/api/digest-archive.ts`
- `worker/src/lib/status-reliability.ts`
- `worker/src/lib/json-decode-observability.ts`
- `worker/src/lib/cache-json.ts`
- `worker/src/cron/__tests__/daily-digest.test.ts`
- new `worker/src/cron/__tests__/weekly-recap.test.ts`

### Implementation Steps

1. Generalize the shared digest response parser.
   - Support daily and weekly metadata shaping without separate parsing logic.
   - Preserve existing forbidden-dash and forbidden-phrase cleanup semantics.

2. Replace weekly inline parsing with the shared parser.
   - Emit explicit degraded metadata when raw-text fallback is used.
   - Log parse degradation once per run with enough context to debug prompt regressions.

3. Standardize malformed persisted JSON handling.
   - Convert `digest-archive` reads to structured decode + logging.
   - Convert `status-reliability` cause parsing to structured decode + logging where appropriate.

4. Add weekly recap coverage.
   - success path
   - malformed JSON fallback path
   - circuit-open skip path
   - Telegram posting behavior and metadata persistence

### Validation

- `npm test -- worker/src/cron/__tests__/daily-digest.test.ts`
- `npm test -- worker/src/cron/__tests__/weekly-recap.test.ts`
- `npm test -- worker/src/lib/__tests__/status-reliability.test.ts`
- `cd worker && npx tsc --noEmit`
- `npm run test:merge-gate`

### Definition Of Done

- One parser owns digest-model response decoding.
- Weekly fallback is observable and marked degraded.
- Silent malformed-JSON paths are removed from the touched modules.
- Weekly recap has a dedicated behavioral test suite.

## WS3. Client Persistence + UI Deduplication

Scope: `R3`, `R4`, `R6`, `R7`, `Q5`
Priority: High
Suggested PR count: 2-3
Risk: Moderate

### Objective

Consolidate browser persistence behavior, remove duplicated nav logic, and unify logo data access without changing product behavior.

### Files In Scope

- `src/hooks/use-preferences.ts`
- `src/hooks/use-command-palette-history.ts`
- `src/hooks/use-portfolio.ts`
- `src/hooks/use-start-here-callout.ts`
- `src/components/start-here-visit-marker.tsx`
- `src/components/header.tsx`
- `src/components/sidebar.tsx`
- `src/components/methodology-mode-toggle.tsx`
- `src/hooks/use-logos.ts`
- logo consumers under `src/app/` and `src/components/`
- `src/lib/start-here-callout.ts`
- new shared client storage helper(s) under `src/lib/`

### Implementation Steps

1. Introduce a shared safe storage layer.
   - `safeLocalStorageGet`
   - `safeLocalStorageSet`
   - `safeLocalStorageRemove`
   - optional `subscribeToStorageKey` or a small persisted-store adapter for `useSyncExternalStore`

2. Migrate persistence-heavy hooks.
   - `usePreference`
   - command palette history
   - portfolio
   - methodology mode
   - sidebar pinning
   - Start Here state

3. Extract shared Start Here write helper.
   - Replace duplicate `markStartHereOpened(read(...)); write(...)` flow.

4. Unify logo access.
   - Replace the trivial `useLogos()` wrapper plus direct JSON imports with one shared `logosById` data module.
   - Keep server/client consumers compatible.

5. Unify shared navigation behavior.
   - Extract `isRouteActive(pathname, href)` helper.
   - Extract shared command-palette action and theme-action components where the duplication is real.

### Validation

- `npm test -- src/hooks/__tests__/use-command-palette-history.test.ts`
- `npm test -- src/hooks/__tests__/use-preferences.test.ts`
- `npm test -- src/__tests__/portfolio-categorize.test.ts`
- `npm run build`
- `npm run test:merge-gate`

### Definition Of Done

- Client storage access is safe across all touched call sites.
- Duplicate Start Here persistence is removed.
- Header/sidebar no longer each own route-active semantics.
- One shared logo source is used across server and client consumers.

## WS4. Chain Health Canonicalization

Scope: `R5`
Priority: Medium
Suggested PR count: 1
Risk: Low

### Objective

Remove local chain-score threshold duplication by using the shared band model consistently.

### Files In Scope

- `src/app/chains/[chain]/client.tsx`
- `shared/lib/chain-health.ts`
- `src/lib/chain-ui.ts`
- related chain tests

### Implementation Steps

1. Convert raw score thresholds in chain detail to `getHealthBand(score)`.
2. Expand `chain-ui` helpers if needed so the detail page can render icon/text/badge state from the band rather than hand-written thresholds.
3. Preserve existing visual semantics unless an audit finding explicitly requires a change.

### Validation

- `npm test -- src/hooks/__tests__/use-chains.test.ts`
- `npm test -- worker/src/api/__tests__/chains.test.ts`
- `npm run build`
- `npm run test:merge-gate`

### Definition Of Done

- Chain detail no longer hardcodes score threshold bands locally.

## WS5. Route Metadata and Admin Route Unification

Scope: `R8`, `S7`
Priority: High
Suggested PR count: 1-2
Risk: Moderate

### Objective

Make route metadata authoritative again and stop embedding admin/business logic directly in the route registry and Pages proxy.

### Files In Scope

- `worker/src/route-registry.ts`
- `functions/api/admin/[[path]].ts`
- `shared/lib/api-endpoints.ts`
- new worker admin-action handler modules as needed
- router contract tests

### Implementation Steps

1. Extend shared endpoint metadata for dynamic admin paths or introduce a shared route matcher used by both the Worker and Pages proxy.
2. Move inline admin action logic out of `route-registry.ts`.
   - manual digest trigger
   - blacklist reset
   - sync-state debug
   - discovery dismiss dynamic handling
3. Keep the route registry declarative.
4. Preserve request/response contracts and idempotency behavior.

### Validation

- `npm test -- worker/src/api/__tests__/router-contract.test.ts`
- `npm test -- worker/src/api/__tests__/auth.test.ts`
- `cd worker && npx tsc --noEmit`
- `npm run test:merge-gate`

### Definition Of Done

- Dynamic admin route authorization is sourced from one contract.
- `route-registry.ts` is primarily routing, not business logic and SQL orchestration.

## WS6. Status Reliability Decomposition

Scope: `Q3`
Priority: High
Suggested PR count: 1-2
Risk: Moderate

### Objective

Split `status-reliability.ts` by responsibility without changing status semantics.

### Files In Scope

- `worker/src/lib/status-reliability.ts`
- new modules:
  - `worker/src/lib/status-state-store.ts`
  - `worker/src/lib/status-probe-store.ts`
  - `worker/src/lib/status-discrepancy-store.ts`
  - `worker/src/lib/status-discrepancy-view.ts`
- `worker/src/lib/__tests__/status-reliability.test.ts`

### Implementation Steps

1. Freeze behavior with characterization tests if needed.
2. Extract persistence stores first.
3. Extract discrepancy view-building and formatting last.
4. Keep one facade export if needed to minimize downstream churn, then simplify imports in a follow-up commit.

### Validation

- `npm test -- worker/src/lib/__tests__/status-reliability.test.ts`
- `cd worker && npx tsc --noEmit`
- `npm run test:merge-gate`

### Definition Of Done

- The current god module is split by responsibility.
- Existing status semantics remain unchanged.

## WS7. Digest Platform Consolidation

Scope: `R1`, `Q2`, `S4`
Priority: High
Suggested PR count: 2-3
Risk: Moderate-to-high

### Objective

Consolidate daily and weekly digest generation into one digest domain layer after the parser and tests are stabilized.

### Files In Scope

- `worker/src/cron/daily-digest.ts`
- `worker/src/cron/weekly-recap.ts`
- `worker/src/cron/daily-digest/collectors.ts`
- new digest-domain helpers under `worker/src/cron/digest/` or equivalent
- digest tests
- digest-related docs if behavior changes

### Implementation Steps

1. Introduce shared generation primitives.
   - prompt execution
   - persistence
   - delivery
   - circuit-breaker outcome handling

2. Split `generateDailyDigest()` into staged helpers.
   - freshness gate
   - input assembly
   - copy generation
   - storage
   - Twitter/Telegram fan-out

3. Convert weekly recap to the same shared machinery.
4. Keep daily and weekly input builders distinct where the domain differs.
5. After stabilization, reduce `daily-digest/collectors.ts` breadth by collector family only if the scope is still coherent in the same tranche.

### Validation

- `npm test -- worker/src/cron/__tests__/daily-digest.test.ts`
- `npm test -- worker/src/cron/__tests__/weekly-recap.test.ts`
- `cd worker && npx tsc --noEmit`
- `npm run test:merge-gate`

### Additional Follow-Through

- Update `scripts/lib/hotspot-ratchet-baseline.json` if the split materially reduces size/branch count.
- Update `agents/plans/2026-03-29-hotspot-decomposition-backlog.md` once the hotspot is no longer queued in its current form.

### Definition Of Done

- Daily and weekly digest flows share one generation and publish substrate.
- `generateDailyDigest()` is no longer the central monolith.
- Digest architecture no longer diverges by copy type.

## WS8. Stablecoin Sync Decomposition

Scope: `S3`
Priority: High
Suggested PR count: 2-3
Risk: High

### Objective

Reduce `syncStablecoins()` from a monolithic coordinator into explicit typed stages without changing output semantics.

### Files In Scope

- `worker/src/cron/sync-stablecoins.ts`
- existing helper modules under `worker/src/cron/sync-stablecoins/`
- `worker/src/cron/__tests__/sync-stablecoins.test.ts`
- hotspot baseline + backlog note

### Implementation Steps

1. Add characterization coverage around the current top-level result metadata if needed.
2. Split the workflow into stages:
   - intake
   - primary pricing
   - enrichment + probe
   - validation
   - cache publication
   - depeg pipeline
3. Keep the top-level function as a thin coordinator over typed stage results.
4. Preserve degraded-mode semantics and abort behavior exactly.

### Validation

- `npm test -- worker/src/cron/__tests__/sync-stablecoins.test.ts`
- `npm run test:invariants`
- `cd worker && npx tsc --noEmit`
- `npm run test:merge-gate`

### Additional Follow-Through

- Update hotspot baseline and backlog note after landing.

### Definition Of Done

- `syncStablecoins()` is a shell coordinator, not the implementation site for every stage.

## WS9. Blacklist Sync Decomposition

Scope: `S5`
Priority: High
Suggested PR count: 1-2
Risk: Moderate

### Objective

Separate blacklist source crawling from shared post-fetch processing and cursor advancement.

### Files In Scope

- `worker/src/cron/sync-blacklist.ts`
- blacklist helper modules
- `worker/src/cron/__tests__/sync-blacklist.test.ts`
- hotspot baseline + backlog note

### Implementation Steps

1. Extract a shared post-fetch pipeline:
   - enrich row balances
   - insert rows
   - sync current-balance cache
   - update counters
2. Keep only source-specific fetch/cursor logic in the Tron and EVM branches.
3. Preserve runtime-budget and partial-progress semantics.

### Validation

- `npm test -- worker/src/cron/__tests__/sync-blacklist.test.ts`
- `cd worker && npx tsc --noEmit`
- `npm run test:merge-gate`

### Additional Follow-Through

- Update hotspot baseline and backlog note after landing.

### Definition Of Done

- Tron and EVM branches differ only where source behavior differs.
- Shared enrich/persist/cache flow is no longer duplicated.

## WS10. Live Reserves Store Decomposition

Scope: `S6`
Priority: High
Suggested PR count: 2-3
Risk: Moderate-to-high

### Objective

Split live reserves storage, retrieval, integrity, and presentation concerns into discrete modules.

### Files In Scope

- `worker/src/lib/live-reserves-store.ts`
- existing parsing helpers
- new modules:
  - `worker/src/lib/live-reserves-write-store.ts`
  - `worker/src/lib/live-reserves-read-store.ts`
  - `worker/src/lib/live-reserves-integrity.ts`
  - `worker/src/lib/live-reserves-view.ts`
- `worker/src/lib/__tests__/live-reserves-store.test.ts`
- hotspot baseline + backlog note

### Implementation Steps

1. Move write-path functions out first.
2. Extract read/query batch loaders.
3. Centralize snapshot-consistency checks in one helper used by overview, metadata, and resolve-result flows.
4. Move presentation/view assembly to a view-layer module.

### Validation

- `npm test -- worker/src/lib/__tests__/live-reserves-store.test.ts`
- `cd worker && npx tsc --noEmit`
- `npm run test:merge-gate`

### Additional Follow-Through

- Update hotspot baseline and backlog note after landing.

### Definition Of Done

- Live reserves no longer rely on one multipurpose store module for every concern.

## WS11. Frontend Hotspot Decomposition

Scope: `Q6`, `Q7`, `S8`
Priority: Medium
Suggested PR count: 2-3
Risk: Moderate

### Objective

Reduce the largest remaining frontend composites into model/view boundaries that are easier to test and evolve.

### Files In Scope

- `src/components/yield-history-chart.tsx`
- `src/components/flow-machine-scene.tsx`
- `src/app/coverage/client.tsx`
- new supporting hooks/components as needed
- relevant frontend tests
- hotspot baseline + backlog note if tracked files materially change

### Implementation Steps

1. Extract `useYieldHistoryChartModel()` from `YieldHistoryChart`.
2. Split flow machine scene into:
   - printer model/render
   - shredder model/render
   - shared motion constants or CSS module
3. Split coverage page into:
   - page model hook
   - summary section
   - filters/legend section
   - desktop table
   - mobile cards

### Validation

- `npm test -- src/lib/__tests__/coverage.test.ts`
- `npm test -- src/lib/__tests__/liquidity-coverage.test.ts`
- `npm run build`
- `npm run test:merge-gate`

### Definition Of Done

- These files are no longer central hotspots mixing orchestration and rendering in one implementation unit.

## WS12. Test, Content, and Tooling Follow-Through

Scope: `Q8`, `Q9`, `S10`
Priority: Medium
Suggested PR count: 1-2
Risk: Low-to-moderate

### Objective

Close the remaining low-severity debt: missing stressed-grade coverage, executable methodology-content bulk, and scheduled toolchain drift.

### Files In Scope

- `shared/lib/report-cards.ts`
- `shared/lib/__tests__/report-cards.test.ts`
- `shared/lib/safety-score-version.ts`
- new structured content/manifests if adopted
- `package.json`
- `worker/package.json`
- relevant methodology docs and changelog surfaces

### Implementation Steps

1. Add the missing `computeStressedGrades()` behavioral tests.
2. Move versioned methodology content out of executable TS into a structured manifest or generated-content layer.
3. Update any docs/build tooling needed for that content move.
4. Schedule or execute the ESLint and TypeScript major upgrades in an isolated tooling PR.

### Validation

- `npm test -- shared/lib/__tests__/report-cards.test.ts`
- `npm run check:doc-sync`
- `npm run lint`
- `npm run typecheck`
- `npm run build`
- `npm run test:merge-gate`

### Definition Of Done

- Report-card stress logic is covered.
- Versioned methodology content is no longer maintained as large executable TS blobs.
- Tooling major-version work is either landed or captured in a dedicated follow-up PR with baseline verification.

## Suggested PR Sequence

1. PR-1: `WS1` Operational hardening
2. PR-2: `WS2` Digest parser + observability quick wins
3. PR-3: `WS3A` Safe storage + Start Here consolidation
4. PR-4: `WS3B` Logo + nav dedupe
5. PR-5: `WS4` Chain health canonicalization
6. PR-6: `WS5` Route metadata/admin route unification
7. PR-7: `WS6` Status reliability split
8. PR-8: `WS7A` Digest shared generation layer
9. PR-9: `WS7B` Daily/weekly migration onto shared layer
10. PR-10: `WS8` Stablecoin sync split
11. PR-11: `WS9` Blacklist sync split
12. PR-12: `WS10` Live reserves split
13. PR-13: `WS11A` Yield history + flow machine decomposition
14. PR-14: `WS11B` Coverage page decomposition
15. PR-15: `WS12` Tests/content/tooling follow-through

## Hotspot Program Alignment

These workstreams must update the hotspot ratchet artifacts when completed:

- `WS7` for `worker/src/cron/daily-digest.ts`
- `WS8` for `worker/src/cron/sync-stablecoins.ts`
- `WS9` for `worker/src/cron/sync-blacklist.ts`
- `WS10` for `worker/src/lib/live-reserves-store.ts`
- `WS11` for `src/app/coverage/client.tsx`

Update both:

- [`scripts/lib/hotspot-ratchet-baseline.json`](/Users/ahirice/Documents/git/stablecoin-dashboard/scripts/lib/hotspot-ratchet-baseline.json)
- [`agents/plans/2026-03-29-hotspot-decomposition-backlog.md`](/Users/ahirice/Documents/git/stablecoin-dashboard/agents/plans/2026-03-29-hotspot-decomposition-backlog.md)

Only do this after the code split is complete and validated.

## Exit Criteria

This remediation program is complete when all of the following are true:

1. All 27 findings are closed or explicitly superseded by an accepted implementation that resolves the underlying issue.
2. Production-hardening findings (`S1`, `S2`) are landed before structural refactors.
3. Weekly recap has dedicated behavioral tests.
4. Client persistence no longer relies on ad hoc localStorage access in touched surfaces.
5. Worker hotspots (`daily-digest`, `sync-stablecoins`, `sync-blacklist`, `live-reserves-store`) are reduced to shell/coordinator roles with helper modules owning implementation detail.
6. Frontend hotspots (`coverage`, `yield-history-chart`, `flow-machine-scene`) have clear model/view boundaries.
7. Hotspot baseline and backlog notes reflect the post-remediation state.
