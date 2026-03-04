# Unified Simplification Implementation Plan - Tier 1 + Tier 2 + Tier 3

**Date:** 2026-03-04  
**Status:** Proposed (execution-ready)  
**Owner:** Engineering  
**Execution Mode:** Autonomous, reset-safe

## 1. Objective

Execute all three simplification tiers in one controlled program that:

1. Removes duplicated logic and dead code.
2. Converges repeated patterns to a single implementation per operation.
3. Reduces structural complexity in both frontend and worker code.
4. Preserves behavior and API contracts.
5. Can be resumed by any engineer after context reset with no hidden decisions.

## 2. Success Criteria

All conditions must be true:

1. Tier 1, Tier 2, and Tier 3 workstreams complete in locked order.
2. Full validation gates pass (`lint`, `test`, `build`, worker typecheck).
3. Contract-critical tests for router and mint/burn ingestion pass.
4. All required docs updates are merged in the same PRs as code changes.
5. Net line count decreases across targeted files (expected total reduction: 2,000-4,000 LOC).

## 3. Context-Reset Bootstrap (Read First)

If implementation context is lost, restart here:

1. Read this file first.
2. Read:
   - `docs/architecture.md`
   - `docs/api-reference.md`
   - `docs/worker-infrastructure.md`
   - `docs/mint-burn-flows.md`
   - `docs/testing.md`
3. Run baseline commands in section 8.
4. Execute workstreams strictly in section 6 order.
5. Do not introduce new architecture choices unless a stop condition is hit.

## 4. Scope

In scope:

1. Tier 1 quick wins:
   - W1 remove unused `use-yield-history`.
   - W2 deduplicate status types.
   - W3 shared stablecoin history query parser.
   - W4 route error wrapper factory.
   - W5 Radix dependency normalization.
2. Tier 2 medium refactors:
   - W6 methodology changelog page consolidation.
   - W7 feature page shell + metadata helper.
   - W8 shared endpoint registry across worker/frontend.
3. Tier 3 structural refactors:
   - T3-C schema/interface dedup with `z.infer`.
   - T3-B stablecoin detail client decomposition.
   - T3-A mint/burn cron+backfill convergence.

Out of scope:

1. New user-facing features.
2. API contract changes.
3. Scoring formula or methodology changes (unless explicitly required by parity bugs).
4. Worker external provider surface changes.

## 5. Non-Negotiable Guardrails

1. Prefer deletion over addition.
2. Preserve endpoint shapes/status codes.
3. Keep Tailwind classes static strings.
4. Preserve cron cadence, cache TTL semantics, admin auth semantics.
5. No worker fetch fan-out changes that can violate the 6-connection per-cron-trigger budget.
6. No temporary shims; land final state directly.
7. One pattern per operation: converge existing variants instead of adding a fourth.

## 6. Locked Execution Order

Do not reorder.

1. Wave A (Tier 1): W1 -> W2 -> W3 -> W4 -> W5
2. Wave B (Tier 2): W6 -> W7 -> W8
3. Wave C (Tier 3): T3-C -> T3-B -> T3-A

Rationale:

1. Tier 1 creates shared primitives and low-risk cleanup.
2. Tier 2 migrates repeated structures to shared implementations.
3. Tier 3 uses the cleaned surface and strongest test harness for high-risk changes.

## 7. Branching and PR Slicing

Suggested branch:

1. `refactor/simplification-unified-t1-t2-t3`

Required PR sequence:

1. `PR-01`: W1 + W2 + W3
2. `PR-02`: W4 + W5
3. `PR-03`: W6
4. `PR-04`: W7
5. `PR-05`: W8
6. `PR-06`: T3-C
7. `PR-07`: T3-B
8. `PR-08`: T3-A

Rule:

1. Do not begin next PR until previous PR validation gates pass locally.

## 8. Baseline Preflight (Run Once)

Commands:

```bash
npm run lint
npm test
npm run build
cd worker && npx tsc --noEmit
```

Capture evidence in first PR description:

1. `wc -l` for:
   - `worker/src/cron/sync-mint-burn.ts`
   - `worker/src/api/backfill-mint-burn.ts`
   - `src/app/stablecoin/[id]/client.tsx`
   - `src/lib/types.ts`
2. Green status for:
   - `worker/src/cron/__tests__/sync-mint-burn.test.ts`
   - `worker/src/api/__tests__/backfill-mint-burn.test.ts`

If baseline is red, stop and fix baseline first.

## 9. Workstream Inventory

| ID | Tier | Focus | Primary Modules | Impact | Effort |
| --- | --- | --- | --- | --- | --- |
| W1 | 1 | Dead code removal | `src/hooks` | High | Low |
| W2 | 1 | Type dedup | `worker/src/api/status.ts`, `src/lib/types.ts` | Medium | Low |
| W3 | 1 | Parser extraction | `worker/src/api/*-history.ts`, `worker/src/lib/api-utils.ts` | High | Medium |
| W4 | 1 | Error wrapper mutualization | `src/app/**/error.tsx`, `src/components` | Medium | Medium |
| W5 | 1 | Dependency normalization | `src/components/ui/sheet.tsx`, `package.json` | Medium | Low |
| W6 | 2 | Changelog renderer mutualization | `src/app/methodology/*-changelog` | High | Medium |
| W7 | 2 | Page shell and metadata standardization | `src/app/*/page.tsx`, `src/lib/page-metadata.ts` | High | Medium |
| W8 | 2 | Endpoint registry centralization | `worker/src/index.ts`, `worker/src/router.ts`, `src/hooks`, `src/app/status` | High | Medium |
| T3-C | 3 | Schema/interface convergence | `src/lib/types.ts` | Medium | Medium |
| T3-B | 3 | Stablecoin detail decomposition | `src/app/stablecoin/[id]`, `src/components/stablecoin-detail`, `src/hooks` | High | High |
| T3-A | 3 | Mint/burn pipeline convergence | `worker/src/cron`, `worker/src/api`, `worker/src/lib/mint-burn-pipeline` | Very High | High |

## 10. Detailed Plan

## 10.1 W1 - Remove Unused Yield History Hook

What to change:

1. Delete `src/hooks/use-yield-history.ts`.
2. Remove references from docs inventory.

Verification:

```bash
rg -n "useYieldHistory\\(" src
npm run lint
npm run build
```

Expected:

1. `rg` returns no hits.

Stop condition:

1. If runtime/dynamic import usage is discovered, document and re-scope W1.

## 10.2 W2 - Deduplicate Status Types

What to change:

1. Remove local interfaces from `worker/src/api/status.ts`.
2. Use type-only imports from `src/lib/types.ts`:
   - `StatusResponse`
   - `CronRun`
   - `CronStatus`
   - `DataQuality`

Verification:

```bash
cd worker && npx tsc --noEmit
npm run test -- worker/src/api/__tests__/status.test.ts
npm run build
```

Stop condition:

1. If shared types force runtime imports (non-type import leakage), pause and re-plan import boundaries.

## 10.3 W3 - Shared Stablecoin History Query Parser

What to change:

1. Add parser helper in `worker/src/lib/api-utils.ts`:
   - `parseStablecoinHistoryQuery(url, opts)`
2. Migrate:
   - `worker/src/api/supply-history.ts`
   - `worker/src/api/yield-history.ts`
   - `worker/src/api/dex-liquidity-history.ts`
3. Add tests:
   - `worker/src/lib/__tests__/api-utils.test.ts`

Locked behavior:

1. Preserve exact errors:
   - `Missing ?stablecoin= parameter`
   - `Invalid stablecoin ID`
2. Preserve defaults/ranges:
   - supply-history: default `365`, range `1..1825`
   - yield-history: default `90`, range `1..365`
   - dex-liquidity-history: default `90`, range `1..365`

Verification:

```bash
npm run test -- worker/src/lib/__tests__/api-utils.test.ts
npm run test -- worker/src/api/__tests__/supply-history.test.ts worker/src/api/__tests__/yield-history.test.ts worker/src/api/__tests__/dex-liquidity-history.test.ts
npm run lint
```

Stop condition:

1. If any response message/status changes, revert helper and re-implement with strict parity.

## 10.4 W4 - Route Error Wrapper Factory

What to change:

1. Add `src/components/create-page-error.tsx` (`"use client"`).
2. Migrate repetitive `src/app/**/error.tsx` wrappers to one-liner factory usage.
3. Keep root `src/app/error.tsx` unchanged.

Verification:

```bash
npm run build
npm run lint
```

Stop condition:

1. If route-level error signature breaks in Next build, rollback migrated page and fix factory signature first.

## 10.5 W5 - Normalize Radix Dependency Usage

What to change:

1. Replace `radix-ui` import usage in `src/components/ui/sheet.tsx` with `@radix-ui/react-dialog`.
2. Remove `radix-ui` dependency from `package.json`.
3. Keep runtime behavior identical.

Verification:

```bash
rg -n 'from "radix-ui"' src worker
npm run build
npm run lint
```

Expected:

1. `rg` returns no hits.

## 10.6 W6 - Consolidate Methodology Changelog Pages

What to change:

1. Add shared renderer:
   - `src/components/methodology-changelog-page.tsx`
2. Optionally add shared card:
   - `src/components/methodology-version-card.tsx`
3. Migrate these pages:
   - `src/app/methodology/blacklist-tracker-changelog/page.tsx`
   - `src/app/methodology/depeg-changelog/page.tsx`
   - `src/app/methodology/liquidity-score-changelog/page.tsx`
   - `src/app/methodology/mint-burn-flow-changelog/page.tsx`
   - `src/app/methodology/stability-index-changelog/page.tsx`
   - `src/app/methodology/yield-changelog/page.tsx`
4. Keep `src/app/methodology/scoring-changelog/page.tsx` out of this package.

Input contract for shared renderer:

1. title
2. breadcrumb label/path
3. version label
4. accent class
5. normalized entries (`version`, `title`, `date`, `summary`, `impact[]`, `commits[]`, `reconstructed`)

Verification:

```bash
npm run build
```

Manual QA:

1. Check all six migrated pages for card rendering, ordering, and commit links.

Stop condition:

1. If a page requires bespoke structure beyond header/card patterns, keep it local and document exception.

## 10.7 W7 - Shared Feature Page Shell + Metadata Builder

What to change:

1. Add:
   - `src/lib/page-metadata.ts`
   - `src/components/feature-page-shell.tsx`
2. Migrate minimal-risk set:
   - `src/app/compare/page.tsx`
   - `src/app/dependency-map/page.tsx`
   - `src/app/portfolio/page.tsx`
   - `src/app/liquidity/page.tsx`
   - `src/app/depeg/page.tsx`
   - `src/app/yield/page.tsx`
   - `src/app/safety-scores/page.tsx`
   - `src/app/stability-index/page.tsx`

Metadata helper output contract:

1. consistent `alternates`
2. consistent `openGraph`
3. consistent `twitter`

Verification:

```bash
npm run build
```

Manual QA:

1. Confirm canonical URLs and OG image URLs in generated metadata.

Stop condition:

1. If shell abstraction forces page-specific hacks, rollback that page migration and keep shell usage to compatible pages only.

## 10.8 W8 - Central Endpoint Registry

What to change:

1. Add `src/lib/api-endpoints.ts` with typed endpoint registry:
   - path
   - allowed methods
   - admin-required
   - mutating-admin flag
   - cache-bypass flag
   - probe group (`public`, `admin`, `manual`)
   - status-page action eligibility
2. Migrate consumers:
   - `worker/src/index.ts`
   - `worker/src/router.ts`
   - `src/hooks/use-endpoint-probes.ts`
   - `src/app/status/client.tsx`
3. Add helpers:
   - `isMutatingAdminPath(path)`
   - `isCacheBypassPath(path)`
   - `getProbePaths(group)`

Locked special case:

1. Preserve `GET /api/audit-depeg-history?dry-run=true` allowance.

Verification:

```bash
npm run test -- worker/src/api/__tests__/router-contract.test.ts
npm run build
```

Stop condition:

1. If route guard behavior drifts from current contract, revert to previous sets and migrate incrementally with stronger tests.

## 10.9 T3-C - Schema/Interface Dedup with `z.infer`

What to change:

1. Convert these 10 schema-backed interfaces in `src/lib/types.ts`:
   - `DexLiquidityPool`
   - `DexPriceSource`
   - `DexLiquidityData`
   - `StabilityIndexComponents`
   - `StabilityContributor`
   - `StabilityIndexMethodology`
   - `StabilityIndexCurrent`
   - `StabilityIndexHistoryPoint`
   - `StabilityIndexResponse`
   - `DepegDewsMethodology`
2. Use `export type X = z.infer<typeof XSchema>`.
3. Keep these manual interfaces unchanged:
   - `ReportCardsResponse`
   - `AltYieldSource`
   - `YieldRanking`
   - `YieldRankingsResponse`
   - `StressSignalEntry`
   - `StressSignalsAllResponse`
   - `StressSignalDetailResponse`

Verification:

```bash
npm run build
cd worker && npx tsc --noEmit
npm run test -- src/lib/__tests__/api-fetch-contracts.test.ts src/lib/__tests__/strict-path-drift.test.ts
```

Stop condition:

1. If consumer code depends on wider manual types and cannot be reconciled without contract change, stop and re-plan.

## 10.10 T3-B - Stablecoin Detail Client Decomposition

What to change:

1. Add:
   - `src/hooks/use-stablecoin-detail-view-model.ts`
   - `src/lib/stablecoin-detail-derive.ts`
   - `src/lib/__tests__/stablecoin-detail-derive.test.ts`
   - `src/components/stablecoin-detail/hero-card.tsx`
   - `src/components/stablecoin-detail/overview-section.tsx`
   - `src/components/stablecoin-detail/chart-section.tsx`
   - `src/components/stablecoin-detail/info-section.tsx`
   - `src/components/stablecoin-detail/flows-section.tsx`
   - `src/components/stablecoin-detail/liquidity-section.tsx`
   - `src/components/stablecoin-detail/depeg-history-section.tsx`
   - `src/components/stablecoin-detail/notices-and-summary-section.tsx`
2. Keep modal local state in `src/app/stablecoin/[id]/client.tsx`.
3. Keep section IDs unchanged:
   - `report-card`
   - `overview`
   - `chart`
   - `info`
   - `flows`
   - `liquidity`
   - `history`
   - `flow-history`

Required order:

1. Add derivation tests first.
2. Extract pure helper functions.
3. Build view-model hook.
4. Split sections.
5. Thin client to orchestration layer.

Verification:

```bash
npm run build
npm run lint
npm run test -- src/lib/__tests__/stablecoin-detail-derive.test.ts
```

Manual QA routes:

1. `/stablecoin/2/`
2. `/stablecoin/237/`
3. `/stablecoin/147/`

Check:

1. render parity
2. anchor navigation
3. feedback modal behavior
4. NAV/non-NAV depeg visibility
5. same values for same cached data

Stop condition:

1. If parity requires broad API or component redesign outside scope, halt and split follow-up plan.

## 10.11 T3-A - Mint/Burn Pipeline Convergence

What to change:

1. Create shared pipeline under `worker/src/lib/mint-burn-pipeline/`:
   - `types.ts`
   - `parse.ts`
   - `classification.ts`
   - `context.ts`
   - `persistence.ts`
   - `sync-state.ts`
2. Move duplicated logic from:
   - `worker/src/cron/sync-mint-burn.ts`
   - `worker/src/api/backfill-mint-burn.ts`
3. Remove any `backfill-mint-burn` import from `../cron/sync-mint-burn`.
4. Preserve semantics:
   - inserted vs ignored counters
   - burn counters (`effective`, `bridge`, `review`)
   - `nextFromBlock`, `done`, sync-state progression
   - hourly aggregate behavior

Required order:

1. Expand tests first.
2. Extract parse + classification.
3. Extract context loading.
4. Extract persistence SQL.
5. Extract sync-state helpers.
6. Delete duplicated inline logic.

Verification:

```bash
npm run test -- worker/src/lib/__tests__/mint-burn-pipeline.test.ts
npm run test -- worker/src/cron/__tests__/sync-mint-burn.test.ts
npm run test -- worker/src/api/__tests__/backfill-mint-burn.test.ts
npm run test -- worker/src/api/__tests__/mint-burn-events.test.ts worker/src/api/__tests__/mint-burn-flows.test.ts
npm run lint
npm run build
cd worker && npx tsc --noEmit
rg -n "from \"../cron/sync-mint-burn\"" worker/src/api/backfill-mint-burn.ts
rg -n "INSERT OR IGNORE INTO mint_burn_events|UPDATE mint_burn_events\\s+SET burn_type|INSERT OR REPLACE INTO mint_burn_hourly" worker/src/cron/sync-mint-burn.ts worker/src/api/backfill-mint-burn.ts
```

Expected:

1. No cron import in backfill file.
2. No duplicated SQL blocks remaining in cron/backfill entrypoints.

Stop condition:

1. If convergence requires endpoint contract changes or runtime dual-path toggles, halt and re-plan.

## 11. Required Docs Updates (Same PR as Code)

Update these as applicable:

1. `docs/architecture.md`
2. `docs/api-reference.md` (if W8 text changes are needed)
3. `docs/worker-infrastructure.md` (routing/method/cache classification updates from W8)
4. `docs/testing.md`
5. `docs/mint-burn-flows.md` (T3-A internal structure)

## 12. Validation Gates

## 12.1 Mandatory Per PR

```bash
npm run lint
npm test
npm run build
cd worker && npx tsc --noEmit
```

## 12.2 Contract-Critical Before Merge of W8 and T3-A

```bash
npm run test:critical-contracts
npm run test:invariants
```

If any gate fails, do not merge.

## 13. Rollback Strategy

1. Keep each workstream in isolated commits.
2. If W8 regresses routing, rollback W8 only while keeping completed W1-W7.
3. If T3-A regresses ingestion, rollback T3-A first and retain T3-B/T3-C.
4. For T3-A, keep a checkpoint commit right before duplicate deletion.

## 14. Definition of Done

Program is complete when:

1. All 11 workstreams are implemented in locked order.
2. All stop-condition checks passed or were explicitly resolved in follow-up plans.
3. No out-of-scope behavior changes were introduced.
4. All required documentation updates are merged.
5. Validation gates are green in CI.

## 15. Autonomous Run Log Template

Use this template in each PR description:

```md
### Scope
- [ ] Workstream ID(s):
- [ ] In-scope files:

### Baseline
- [ ] Baseline commands green
- [ ] Baseline line counts recorded

### Changes
- [ ] Duplicate logic removed:
- [ ] Shared module introduced:
- [ ] Legacy path deleted:

### Verification
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `cd worker && npx tsc --noEmit`
- [ ] Targeted tests:

### Contract/Parity Checks
- [ ] API shape parity validated
- [ ] UI parity/manual QA validated

### Docs
- [ ] Updated docs:

### Risk
- [ ] Stop conditions checked
- [ ] Rollback plan identified
```

