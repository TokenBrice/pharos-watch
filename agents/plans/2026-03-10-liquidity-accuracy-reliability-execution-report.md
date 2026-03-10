# Liquidity Accuracy & Reliability — Execution Report

Date: 2026-03-10  
Source: end-to-end `/liquidity` page + liquidity cron audit performed on 2026-03-10  
Primary surfaces: `/liquidity`, `/stablecoin/[id]` liquidity card, `sync-dex-liquidity`, `sync-dex-discovery`, `/api/dex-liquidity`, `/api/dex-liquidity-history`, `/status`

## Execution Summary

This report converts the audit findings into an execution-ready plan.

The implementation should be driven by four workstreams, in this order:

1. **Freshness and operator truth**
2. **Coverage correctness and source fidelity**
3. **Confidence-aware history and scoring**
4. **UI transparency and aggregate hygiene**

This order matters:

- Workstream 1 fixes the most visible reliability bug immediately.
- Workstream 2 raises real coverage without loosening standards.
- Workstream 3 prevents incorrect trend and durability math from low-confidence history.
- Workstream 4 makes the page honest about uncertainty instead of hiding it.

## Baseline

Baseline verification already completed during the audit:

| Gate | Result |
|---|---|
| Targeted liquidity tests | ✅ 43/43 |
| Frontend build | ✅ `npm run build` |

Targeted suites used:

```bash
npm test -- \
  worker/src/cron/__tests__/sync-dex-liquidity.test.ts \
  worker/src/cron/__tests__/dex-liquidity-scoring.test.ts \
  worker/src/cron/__tests__/dex-liquidity-fallbacks.test.ts \
  worker/src/cron/__tests__/dex-liquidity-process-pools.test.ts \
  worker/src/cron/__tests__/dex-liquidity-price-sanity.test.ts \
  worker/src/cron/dex-discovery/__tests__/orchestrator.test.ts \
  worker/src/cron/dex-discovery/__tests__/crawl-sources.test.ts \
  worker/src/api/__tests__/dex-liquidity.test.ts \
  worker/src/api/__tests__/dex-liquidity-history.test.ts \
  src/components/__tests__/liquidity-table.test.ts \
  src/components/__tests__/liquidity-stats.test.ts
```

## Goals

- Make `/liquidity` show the real freshness and quality of the dataset.
- Increase true coverage on DS-only / fallback chains without relaxing filters.
- Prevent placeholder or degraded history from contaminating score durability and trend outputs.
- Surface NR and fallback-only states explicitly instead of silently removing them.
- Add operator-facing guardrails that detect value coverage loss, not just row-count loss.

## Non-Goals

- No new upstream providers.
- No redesign of the cron split between discovery and scoring.
- No full visual redesign of the liquidity page.
- No change to the core Liquidity Score component weights unless required by data-correctness fixes.

## Verification Standard

Every merged phase must end with:

```bash
npm run build
npm run lint
npm test
cd worker && npx tsc --noEmit
```

Minimum targeted suites during implementation:

```bash
npm test -- \
  worker/src/cron/__tests__/sync-dex-liquidity.test.ts \
  worker/src/cron/__tests__/dex-liquidity-scoring.test.ts \
  worker/src/cron/__tests__/dex-liquidity-fallbacks.test.ts \
  worker/src/cron/__tests__/dex-liquidity-process-pools.test.ts \
  worker/src/cron/__tests__/dex-liquidity-price-sanity.test.ts \
  worker/src/cron/dex-discovery/__tests__/orchestrator.test.ts \
  worker/src/cron/dex-discovery/__tests__/crawl-sources.test.ts \
  worker/src/api/__tests__/dex-liquidity.test.ts \
  worker/src/api/__tests__/dex-liquidity-history.test.ts \
  src/components/__tests__/liquidity-table.test.ts \
  src/components/__tests__/liquidity-stats.test.ts
```

## Findings Mapped To Workstreams

| ID | Severity | Finding | Workstream |
|---|---|---|---|
| F1 | High | Liquidity freshness banner is driven by client cache time, not worker freshness metadata | 1 |
| F2 | High | DexScreener fallback ignores quote-side pools | 2 |
| F3 | High | Placeholder / degraded history can distort trends and durability | 3 |
| F4 | Medium | Aggregate balance and organic stats are weighted by total TVL instead of measured TVL | 4 |
| F5 | Medium | The leaderboard hides NR / unobserved assets entirely | 4 |
| F6 | Medium | Cron guardrails are row-count based and can miss value-coverage degradation | 1, 3 |
| F7 | Low | Orderbook fallback uses inconsistent synthetic chain semantics | 2 |

## Workstream 1: Freshness And Operator Truth

### Goal

Make the page and operator tooling reflect the real dataset age and degraded-run status.

### Files

- `src/hooks/use-api-query.ts`
- `src/hooks/use-dex-liquidity.ts`
- `src/app/liquidity/client.tsx`
- `src/components/stale-data-banner.tsx`
- `src/lib/api.ts`
- `worker/src/api/dex-liquidity.ts`
- `worker/src/api/status.ts`
- `src/app/status/*`
- `shared/types/index.ts`

### Tasks

- [ ] Add a meta-aware polling hook path.
  - Introduce `useApiQueryWithMeta()` or a `withMeta` option in `useApiQuery()`.
  - Use `apiFetchWithMeta()` so liquidity consumers can read `X-Data-Age` / `_meta`.
  - Preserve existing hook behavior for endpoints that do not need freshness metadata.

- [ ] Switch `useDexLiquidity()` to the meta-aware path.
  - Return both `data` and `meta`.
  - Keep the existing zod validation behavior.

- [ ] Plumb worker freshness into `/liquidity`.
  - Pass `meta` into `StaleDataBanner`.
  - Stop treating TanStack Query `dataUpdatedAt` as the source of truth for dataset freshness.

- [ ] Surface degraded-run context from the worker.
  - If the latest `sync-dex-liquidity` run is `degraded`, add a `Warning` header or an explicit `_meta.warning` in `/api/dex-liquidity`.
  - Include critical `failedSources` and `nearCoverageGuard` state in a small page-level notice when present.

- [ ] Add a Liquidity Health operator card on `/status`.
  - Show:
    - current covered-coin count vs previous run
    - current global deduped TVL
    - latest run status
    - failed sources
    - near-guard state
    - fallback-only / unobserved counts once Workstream 3 lands

### Acceptance Criteria

- `/liquidity` shows stale/degraded status when the worker says the dataset is stale/degraded, even if the browser refetched recently.
- Operators can see whether a bad liquidity run was caused by source failure, guardrail drift, or both.
- The liquidity page never shows “fresh” solely because React Query fetched recently.

### Tests

- Add a frontend hook/component test where `X-Data-Age` is stale but `dataUpdatedAt` is recent; the banner must show degraded/stale.
- Add API tests covering warning propagation for degraded liquidity runs.
- Add `/status` tests for the new liquidity health payload.

## Workstream 2: Coverage Correctness And Source Fidelity

### Goal

Recover legitimate fallback coverage that is currently dropped, while preserving quality filters and source attribution.

### Files

- `worker/src/lib/dexscreener.ts`
- `worker/src/cron/dex-liquidity/fetch-fallbacks.ts`
- `worker/src/cron/dex-discovery/crawl-sources.ts`
- `worker/src/cron/dex-liquidity/crawl-helpers.ts`
- `worker/src/cron/dex-liquidity/fetch-crawlers.ts`
- `worker/src/cron/dex-liquidity/types.ts`
- `shared/types/index.ts`
- `docs/dex-liquidity.md`
- `docs/api-reference.md`

### Tasks

- [ ] Add quote-side DexScreener pool support for liquidity coverage.
  - Do not require `baseToken === tracked token`.
  - Resolve whether the tracked asset is base or quote.
  - Count the pool for liquidity coverage when either side matches.

- [ ] Only generate DS price observations when the tracked-token price is actually derivable.
  - Extend the DS pair type if the API exposes `priceNative`.
  - If the tracked token is base, use `priceUsd` as today.
  - If the tracked token is quote and a reliable inversion path exists, derive the quote-token USD price.
  - If quote-side price is not derivable, keep the pool for liquidity but skip the price observation.

- [ ] Unify side-resolution logic across discovery and scoring fallback.
  - Reuse a shared helper rather than duplicating base-only logic in:
    - discovery DexScreener stage
    - scoring DexScreener fallback

- [ ] Preserve true fallback source families in merged pool entries.
  - Replace the current coarse pool source taxonomy:
    - from: `dl | cg | gt | ds`
    - to: `dl | cg_onchain | gecko_terminal | dexscreener | cg_tickers`
  - This is required for accurate `sourceMix`, coverage badges, and operator visibility.

- [ ] Normalize orderbook venue semantics.
  - Use one canonical synthetic venue identifier everywhere.
  - Recommended:
    - internal `chain = "orderbook"`
    - UI label = `Offchain`
  - Do not mix `cex` and `orderbook`.

### Acceptance Criteria

- Legitimate quote-side DS pools appear in liquidity coverage.
- DS-only assets do not lose pool coverage purely because token ordering is reversed.
- Price observations remain strict: no inferred quote-side prices unless the derivation is explicit and tested.
- Current rows can distinguish `cg_onchain` vs `gecko_terminal` vs `dexscreener` vs `cg_tickers`.

### Tests

- Add a fallback test where the tracked token is quote-side and the pool must still count toward liquidity.
- Add a test where quote-side DS coverage is accepted but no price observation is written.
- Add a test where quote-side DS price is derived correctly only when the required fields are present.
- Update pool-source schema tests to assert the new source-family values.

## Workstream 3: Confidence-Aware Persistence, History, And Math

### Goal

Separate “observed confidently”, “observed via fallback”, and “not observed” so trends and durability stop over-trusting weak or placeholder history.

### Files

- `worker/migrations/<next>_liquidity_coverage_confidence.sql`
- `worker/src/cron/dex-liquidity/scoring.ts`
- `worker/src/cron/dex-liquidity/persistence.ts`
- `worker/src/cron/dex-liquidity/orchestrator.ts`
- `worker/src/api/dex-liquidity.ts`
- `worker/src/api/dex-liquidity-history.ts`
- `worker/src/lib/dex-liquidity.ts`
- `shared/types/index.ts`
- `src/components/dex-liquidity-card.tsx`
- `docs/dex-liquidity.md`
- `docs/api-reference.md`
- `docs/data-flow-map.md`

### Data Model

Add the following columns to `dex_liquidity`:

- `coverage_class TEXT NOT NULL DEFAULT 'unobserved'`
- `coverage_confidence REAL NOT NULL DEFAULT 0`
- `source_mix_json TEXT`
- `balance_measured_tvl_usd REAL`
- `organic_measured_tvl_usd REAL`

Add the following columns to `dex_liquidity_history`:

- `coverage_class TEXT NOT NULL DEFAULT 'unobserved'`
- `coverage_confidence REAL NOT NULL DEFAULT 0`
- `source_mix_json TEXT`

Recommended `coverage_class` enum:

- `primary`
- `mixed`
- `fallback`
- `legacy`
- `unobserved`

Recommended confidence defaults:

- `primary = 1.0`
- `mixed = 0.85`
- `fallback = 0.55`
- `legacy = 0.50`
- `unobserved = 0`

### Legacy Backfill Policy

Historical rows cannot be reconstructed exactly from current schema because old snapshots do not persist source-family composition.

Migration behavior should therefore be:

- existing history row with `liquidity_score IS NULL` or `total_tvl_usd = 0` -> `coverage_class = 'unobserved'`, `coverage_confidence = 0`
- existing history row with `liquidity_score IS NOT NULL` and `total_tvl_usd > 0` -> `coverage_class = 'legacy'`, `coverage_confidence = 0.5`

Do not attempt a fake backfill of source mix for old rows.

### Tasks

- [ ] Compute per-row source mix from the retained pool set.
  - Count both pool-count share and TVL share per source family.
  - Persist the compact representation in `source_mix_json`.

- [ ] Compute `coverageClass` and `coverageConfidence` at score time.
  - `primary`: only primary pools contribute materially
  - `mixed`: both primary and fallback pools contribute
  - `fallback`: only fallback pools contribute
  - `unobserved`: no score / no pools
  - `legacy`: migration-only state for historical rows

- [ ] Persist measurement denominators for summary correctness.
  - `balance_measured_tvl_usd`
  - `organic_measured_tvl_usd`

- [ ] Gate trend baseline selection.
  - 24h change:
    - require a baseline within a tolerance window of 12 hours
    - require `coverage_confidence >= 0.5`
  - 7d change:
    - require a baseline within a tolerance window of 36 hours
    - require `coverage_confidence >= 0.5`
  - If no valid baseline exists, return `null`, not a synthetic trend.

- [ ] Gate durability history inputs.
  - `depth_stability` and 30d volume consistency should only use snapshots with `coverage_confidence >= 0.75`.
  - If fewer than 7 confident rows exist, keep the current neutral fallback behavior rather than fabricating a stability score.

- [ ] Strengthen guardrails from row-count based to value-aware.
  - Add run metadata comparing:
    - current global deduped TVL vs previous run
    - current top-10 asset covered TVL vs previous run
    - coverage-class distribution vs previous run
  - Mark run `degraded` when major value coverage falls sharply, even if row count remains stable.

- [ ] Expose coverage in API responses.
  - `/api/dex-liquidity`
    - `coverageClass`
    - `coverageConfidence`
    - `sourceMix`
    - `balanceMeasuredTvlUsd`
    - `organicMeasuredTvlUsd`
  - `/api/dex-liquidity-history`
    - `coverageClass`
    - `coverageConfidence`
    - `methodologyVersion`

### Acceptance Criteria

- A newly discovered coin does not show a fake 7d surge simply because the last 7 days were placeholder rows.
- A degraded or fallback-only run does not overwrite durability history as if it were high-confidence coverage.
- Operators can detect value-coverage regression on majors even when row count looks normal.
- API consumers can distinguish high-confidence scored assets from fallback-only and unobserved assets.

### Tests

- Add API tests covering null trend output when the nearest valid historical baseline is outside tolerance.
- Add scoring tests proving low-confidence history is excluded from `depth_stability` and volume consistency.
- Add persistence tests for new coverage columns and legacy migration defaults.
- Add orchestrator tests for value-based degradation signals.

## Workstream 4: UI Transparency And Aggregate Hygiene

### Goal

Stop hiding uncertainty and fix the overview math so the page reflects measured coverage rather than implied precision.

### Files

- `src/app/liquidity/client.tsx`
- `src/components/liquidity-table.tsx`
- `src/components/liquidity-stats.tsx`
- `src/components/dex-liquidity-card.tsx`
- `src/components/__tests__/liquidity-table.test.ts`
- `src/components/__tests__/liquidity-stats.test.ts`
- `shared/types/index.ts`
- `docs/dex-liquidity.md`

### Tasks

- [ ] Fix overview weighting for balance and organic metrics.
  - Use `balanceMeasuredTvlUsd` and `organicMeasuredTvlUsd` from the API as denominators.
  - Do not weight by a coin’s total TVL when only part of that TVL has measured balance or organic data.

- [ ] Stop silently removing NR / unobserved rows.
  - Keep scored rows in the main leaderboard.
  - Add either:
    - a default-visible “Unrated / not observed” section below the main table, or
    - a `Show unrated` toggle that reveals them in-place
  - Recommended: a separate section to avoid degrading the main leaderboard UX.

- [ ] Add coverage badges per row and per detail card.
  - `Primary`
  - `Mixed`
  - `Fallback`
  - `NR`
  - Show source-family tooltips using `sourceMix`.

- [ ] Add a small confidence note to summary copy.
  - Example:
    - “Avg Liq Score” remains the mean of scored assets
    - add “High-confidence coverage” stat for `primary + mixed`

- [ ] Keep page layout stable.
  - No large redesign.
  - No change to table sort defaults.

### Acceptance Criteria

- Users can tell whether a coin is strongly covered, fallback-only, or not observed.
- The page no longer suggests that all visible averages are based on full measured coverage when they are not.
- NR assets remain discoverable from `/liquidity`.

### Tests

- Add table tests for unrated-row reveal behavior.
- Add stats tests covering new measured-weight denominators.
- Add component tests for coverage badge rendering and sort behavior with `null` score rows.

## Recommended Delivery Order

### Phase A: Freshness Truth

Ship Workstream 1 first.

Expected outcome:

- immediate user-facing reliability improvement
- no migration required
- low blast radius

### Phase B: Coverage Recovery

Ship Workstream 2 second.

Expected outcome:

- more accurate DS-chain coverage
- better source attribution
- still no history-model change yet

### Phase C: Coverage Confidence Model

Ship Workstream 3 third.

Expected outcome:

- correct trend and durability semantics
- new schema
- new operator guardrails

### Phase D: UI Honesty And Metric Hygiene

Ship Workstream 4 last.

Expected outcome:

- page reflects the new data model explicitly
- less ambiguity for both users and operators

## Rollout And Monitoring

### Deployment Notes

- The migration in Workstream 3 is additive and safe to deploy before app code reads the new columns.
- Current-row confidence data will self-heal on the next `sync-dex-liquidity` run.
- Historical confidence quality will improve gradually:
  - 24h trend confidence becomes reliable after 1 day
  - 7d trend confidence becomes reliable after 7 days
  - durability confidence becomes fully reliable after 30 days

### First 7 Days After Workstream 3

Monitor on `/status`:

- liquidity run status
- failed sources
- near-guard / value-guard state
- primary / mixed / fallback / unobserved distribution
- top-10 asset covered TVL delta
- global deduped TVL delta

### Abort Conditions

Revert or hotfix if any of the following occur:

- `sync-dex-liquidity` begins flagging degraded on every run without a real source outage
- high-confidence covered assets drop materially without corresponding market events
- liquidity page badges and history confidence diverge from actual run metadata

## Documentation Updates Required

Update on completion:

- `docs/dex-liquidity.md`
- `docs/api-reference.md`
- `docs/data-flow-map.md`
- `docs/worker-infrastructure.md`
- `docs/testing.md`

Update if methodology wording changes materially:

- `docs/methodology-page.md`
- `/methodology` page content for the liquidity section

## Final Success Criteria

This effort is complete when all of the following are true:

- `/liquidity` freshness reflects worker truth, not client fetch recency.
- DS fallback counts legitimate quote-side pools without inflating price confidence.
- 24h and 7d liquidity trends return `null` when no trustworthy baseline exists.
- durability uses only confident history, not placeholder rows.
- operators can see value-coverage degradation directly.
- users can see which assets are fallback-only or unrated instead of having them silently omitted.
