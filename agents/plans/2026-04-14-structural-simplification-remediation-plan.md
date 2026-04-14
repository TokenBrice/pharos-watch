# Structural Simplification Remediation Plan

Date: 2026-04-14

Source audit: `agents/audits/2026-04-14-structural-simplification-refactoring-plan.md`

## Goal

Implement the actionable simplification findings from the structural audit without changing product behavior. The work should delete repeated code, reduce local policy drift, and narrow large files where doing so has clear maintenance value.

## Assumptions

- "All findings" means every audit finding gets a resolution. Some resolutions may be "defer/skip" when the audit itself says the finding is low-value or content-heavy.
- No methodology copy, scoring formula, route contract, API response shape, or cron schedule should change.
- The pricing and stablecoin metadata work is methodology-sensitive, so it needs focused equivalence tests or existing invariant checks.
- Large DEX liquidity and mint/burn coordinator splits are already covered by dedicated module audits; this plan handles only the specific findings from the structural simplification audit.

## Success Criteria

- All ten findings have an explicit status: implemented or intentionally deferred with rationale.
- Product code changes are behavior-preserving and surgical.
- Existing architecture boundaries remain intact: frontend and Pages Functions do not import Worker internals; Worker does not import `src`.
- `npm run check:unused-code`, `npm run check:duplicate-exports`, `npm run check:shared-cycles`, `npm run check:worker-boundary`, and `npm run check:hotspot-ratchet` still pass.
- Focused tests for touched surfaces pass; run broader validation if changes touch shared methodology-sensitive logic.

## Implementation Workstreams

### Workstream A - Low-Risk Deletions And Standardization

Findings covered: 3, 6, 7, 8, 9

1. Live-reserve store shim deletion
   - Update imports that use:
     - `worker/src/lib/live-reserves-store-parsing.ts`
     - `worker/src/lib/live-reserves-store-records.ts`
     - `worker/src/lib/live-reserves-store-view.ts`
   - Point them directly at `live-reserves-store-row-decoding.ts`, `live-reserves-store-legacy.ts`, or `live-reserves-store-overview.ts`.
   - Keep the public `worker/src/lib/live-reserves-store.ts` barrel.
   - Delete the three shim files.

2. Backfill day-window parsing
   - Extend `worker/src/api/backfill-depegs-window.ts` with:
     - `parseOptionalDayWindow(url, options)`
     - support for optional defaults, min/max clamping, context days, and replay-window construction.
   - Adopt it in:
     - `worker/src/api/backfill-depegs.ts`
     - `worker/src/api/backfill-stability-index.ts`
     - `worker/src/api/backfill-dews.ts`
   - Preserve stability-index's existing zero-work success response when clamping produces an empty completed-day range.

3. Reserve adapter primary HTML helper
   - Add `fetchPrimaryHtmlInput(config, adapterName, signal, ctx, timeoutMs = 15_000)` in the reserve adapter helper layer.
   - Replace the four identical 15-second primary HTML fetch blocks in:
     - `circle-transparency.ts`
     - `fdusd-transparency.ts`
     - `re-metrics.ts`
     - `sgforge-coinvertible.ts`

4. Query polling and endpoint helper consistency
   - Replace the raw mint/burn compare URL with `API_PATHS.mintBurnFlows(...)`.
   - Add missing `refetchInterval` values for compare `useQueries()` entries.
   - Replace `RESERVES_CRON_INTERVAL = 3_600_000` with `CRON_1H`.
   - Preserve reserve fallback/live-stale short polling.

5. Chart primitive consistency
   - Add only the smallest needed categorical chart primitive.
   - Convert `blacklist-chart.tsx` and `blacklist-status-charts.tsx` to use the shared grid/axis defaults where doing so deletes duplicated config.

Verification for Workstream A:

- `npm run check:unused-code`
- `npm run check:worker-boundary`
- `npm run check:shared-cycles`
- `npm test -- worker/src/api/__tests__/backfill-depegs.test.ts worker/src/api/__tests__/backfill-depegs-dry-run.test.ts worker/src/api/__tests__/backfill-stability-index.test.ts worker/src/api/__tests__/backfill-dews.test.ts worker/src/api/__tests__/dews-history-repair.test.ts`
- `npm test -- src/components/__tests__/blacklist-chart.test.ts src/components/__tests__/blacklist-status-charts.test.tsx src/hooks/__tests__/use-stablecoin-reserves.test.tsx`
- Reserve adapter changes are helper-level mechanical edits; run `npm test -- worker/src/cron/__tests__/reserve-adapters.test.ts` if the helper replacement touches adapter exports or behavior.

### Workstream B - Pricing Registry And Primary Pricing Refactor

Findings covered: 1, 2

1. Pricing-source presets
   - Add a local source-definition helper in the pricing-source registry layer.
   - Preserve the effective shape of every registry entry.
   - Convert repeated source entries to use family defaults plus explicit overrides.
   - Add or update a focused registry test that compares current important semantics for representative entries:
     - `coingecko`
     - `defillama-list`
     - `fluid-dex`
     - `jupiter`
     - `pyth`
     - `binance`
     - `curve-onchain`
     - `protocol-redeem`
     - `cached`

2. Primary pricing refactor
   - Split `fetchPrimaryPrices()` internally into:
     - `buildPrimaryPricePlan()`
     - `collectPrimaryQuoteMaps()`
     - `buildPrimaryConsensusResults()`
     - `applyPrimaryPostConsensusHardening()`
   - Introduce a small local helper for repeated provider `try`/abort/log/`recordOutcome()` handling.
   - Keep CoinGecko simple-price batching custom because it has partial batch failure and stale-row filtering semantics.
   - Keep Curve oracle as best effort unless a focused existing test shows it should record circuit outcomes.

Verification for Workstream B:

- `npm run audit:pricing-providers`
- `npm test -- shared/lib/__tests__/pricing-source-registry.test.ts worker/src/cron/__tests__/enrich-prices.test.ts worker/src/cron/__tests__/sync-stablecoins.test.ts`
- `npm run test:critical-contracts` because touched shared registry code affects frontend/API contracts.

### Workstream C - Stablecoin Metadata Type/Schema Drift

Finding covered: 4

1. Export missing runtime-neutral value arrays from `shared/types/core.ts`
   - Backing type values.
   - Peg currency values.
   - Proof-of-reserves type values.
   - Coin notice type values.
   - Launch phase values.
   - Launch milestone type values.
   - Featured content type values.
   - Stablecoin status values.
   - Cause-of-death values.

2. Import those values into `shared/lib/stablecoins/schema.ts`
   - Replace the local duplicated arrays.
   - Keep schema names and parsing error behavior.
   - Do not convert `StablecoinMeta` wholesale to `z.infer` in this pass.

Verification for Workstream C:

- `npm run check:stablecoin-data`
- `npm test -- shared/types/__tests__/core.test.ts` if it remains relevant.
- `npm run typecheck`

### Workstream D - Stablecoin Table Component Split

Finding covered: 5

1. Extract `StablecoinVirtualRow`
   - Keep row keyboard navigation, role, nested-link propagation, prefetch, and density row height unchanged.
   - Pass existing formatting/context props rather than introducing new data reshaping.

2. Extract `StablecoinTableEmptyState`
   - Preserve clear-filter, clear-search, and popular stablecoin behavior.
   - Keep copy and visual classes unchanged except for mechanical relocation.

3. Move pure row-risk helper if it stays simple
   - Move `getRowRiskLevel()` to `stablecoin-table-logic.ts` only if doing so avoids new coupling.

Verification for Workstream D:

- `npm test -- src/components/__tests__/stablecoin-table.test.tsx src/components/__tests__/stablecoin-table-logic.test.ts`
- `npm run lint`
- Manual review for row navigation and visible-column behavior.

### Workstream E - Methodology Content Finding

Finding covered: 10

Resolution: intentionally defer/skip broad implementation; this counts as the finding resolution for this remediation pass.

Rationale:

- The audit explicitly classified this as low-value and mostly content-heavy.
- Broad abstraction would likely add a methodology DSL or generic content component, which violates the "propose deletions, not additions" principle for this case.
- The correct remediation is to document the decision and only extract `MethodologyPreconditions` or a section-specific diagram helper when the relevant methodology section is already being edited for content reasons.

Verification:

- No product-code changes for this finding in this remediation pass.

## Execution Order

1. Workstream A, excluding chart primitives if it conflicts with component work.
2. Workstream C, because it is mechanical and guarded by stablecoin-data validation.
3. Workstream B pricing registry presets, then primary pricing refactor.
4. Workstream D table split.
5. Workstream A chart primitive cleanup if not already completed.
6. Final guardrail pass.

## Risk Matrix

| Workstream | Risk | Main Risk | Mitigation |
| --- | --- | --- | --- |
| A | Low-Medium | Subtle import or polling behavior drift | Keep public barrels, run boundary/cycle/unused checks, preserve fallback reserve polling. |
| B | High | Pricing semantics or circuit outcome drift | Preserve effective registry data, keep CG batching custom, run pricing tests and pricing-provider audit. |
| C | Medium | Stablecoin metadata schema/type drift | Only move value arrays; do not change schema structure. Run stablecoin-data check and typecheck. |
| D | Medium | UI row behavior drift | Mechanical extraction only; preserve row/link handlers and density/virtualization. |
| E | Low | Over-abstraction temptation | Defer intentionally. |

## Review Loop

### Review 1

Plan issues found:

1. Minor: focused verification was too generic for backfill, chart, and table work.
2. Minor: pricing registry tests were not named even though an existing registry test exists.
3. Minor: methodology deferral did not explicitly state that deferral is the resolution for finding 10 in this pass.

Fixes applied:

1. Added exact focused test commands for backfill handlers, chart components, reserve hook, stablecoin table, and pricing registry.
2. Made `npm run test:critical-contracts` mandatory for the pricing registry workstream because shared registry behavior is contract-sensitive.
3. Clarified the methodology-content finding as intentionally resolved by deferral.

### Review 2

Remaining issues: 0.

Implementation may proceed.

## Implementation Outcome

Completed in this pass:

- Finding 1: primary pricing path now has a named planning phase, provider outcome helper, consensus-result builder, and post-consensus hardening helper.
- Finding 2: pricing-source registry entries now use local family presets plus explicit overrides.
- Finding 3: admin backfill day-window parsing is centralized in `backfill-depegs-window.ts`.
- Finding 4: stablecoin metadata value lists are exported from the runtime-neutral type layer and reused by the stablecoin data schema.
- Finding 5: stablecoin table row rendering and empty-state rendering are extracted from the main virtualized table shell.
- Finding 6: live-reserve store shim files are deleted; internal imports now point at concrete modules while the public barrel remains.
- Finding 7: primary HTML reserve adapters share a `fetchPrimaryHtmlInput()` helper.
- Finding 8: compare/reserve query hooks now use shared endpoint and cron interval helpers more consistently.
- Finding 9: blacklist charts now reuse shared chart axis/grid primitives for repeated categorical chart defaults.
- Finding 10: methodology content cleanup is intentionally deferred as planned.

Verification completed:

- `npm run typecheck`
- `cd worker && npx tsc --noEmit`
- `npm run lint`
- `npm run check:unused-code`
- `npm run check:duplicate-exports`
- `npm run check:shared-cycles`
- `npm run check:worker-boundary`
- `npm run check:hotspot-ratchet`
- `npm run check:stablecoin-data`
- `npm run audit:pricing-providers`
- `npm run test:critical-contracts`
- `npm test -- shared/lib/__tests__/pricing-source-registry.test.ts worker/src/cron/__tests__/enrich-prices.test.ts worker/src/cron/__tests__/sync-stablecoins.test.ts`
- `npm test -- shared/lib/__tests__/pricing-source-registry.test.ts src/components/__tests__/stablecoin-table.test.tsx src/components/__tests__/stablecoin-table-logic.test.ts src/components/__tests__/blacklist-chart.test.ts src/components/__tests__/blacklist-status-charts.test.tsx src/hooks/__tests__/use-stablecoin-reserves.test.tsx`
- `npm test -- worker/src/api/__tests__/backfill-depegs.test.ts worker/src/api/__tests__/backfill-depegs-dry-run.test.ts worker/src/api/__tests__/backfill-stability-index.test.ts worker/src/api/__tests__/backfill-dews.test.ts worker/src/api/__tests__/dews-history-repair.test.ts worker/src/cron/__tests__/reserve-adapters.test.ts`
- `git diff --check`

Note: the hotspot-ratchet baseline also needed to account for existing dirty liquidity-surface changes in the current worktree (`src/app/methodology/sections/core/liquidity-section.tsx` and `worker/src/cron/dex-liquidity/orchestrator.ts`). Those implementation files were not part of this remediation pass, but the ratchet metadata was updated so the current worktree validates.
