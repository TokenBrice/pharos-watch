# Tier 3 Remediation Implementation Plan

Date: 2026-03-20
Source audit: `agents/audits/2026-03-20-simplification-audit.md`
Scope: Tier 3 items only

## Objective

Implement the two Tier 3 remediations from the simplification audit:

1. Consolidate duplicated DEX crawling and normalization logic across discovery and liquidity.
2. Move large static stablecoin registries out of executable TypeScript into checked-in data assets with thin typed loaders.

The goal is deletion and ownership clarity, not new abstraction for its own sake. The exported behavior of the frontend, worker, and shared modules should remain unchanged.

## Success Criteria

- DEX-source rules live in one owner per concern:
  - CoinGecko onchain pool parsing/classification
  - CoinGecko tickers orderbook aggregation
  - token-price observation mapping for GT/CG token batches
- `worker/src/cron/dex-discovery/crawl-sources.ts`, `worker/src/cron/dex-liquidity/fetch-crawlers.ts`, `worker/src/cron/dex-liquidity/fetch-fallbacks.ts`, and `worker/src/cron/dex-liquidity/fetch-primary.ts` are materially smaller and keep only orchestration plus output shaping.
- `@shared/lib/stablecoins` and `@shared/lib/dead-stablecoins` keep the same public exports used by current callers.
- Raw registry content is stored in non-executable assets, not in 6.8k lines of handwritten TS arrays.
- `npm run check:doc-counts` still passes after the registry move.
- No change to cron cadence, scoring methodology, source ordering, or API response shapes.

## Non-Goals

- No redesign of the DEX scoring algorithm.
- No change to discovery tiering, staging schema, or pool-identity semantics.
- No new plugin framework or generic source-engine layer.
- No migration of runtime-neutral metadata into the worker or frontend layers.
- No change to stablecoin IDs, canonical order, or current about/methodology content beyond path/tooling updates.

## Constraints

- Preserve the current connection-budget and pacing behavior documented in `docs/dex-liquidity.md` and `docs/worker-and-api-limits.md`.
- Keep discovery output as `StagedPool` and liquidity output as `GtNewPool` / `CgNewPool` / `DexPriceObs`; shared helpers should normalize source data, not hide domain-specific result shapes.
- JSON-backed registry data must preserve current optional-field semantics. Omit absent fields; do not replace `undefined` with `null` unless the current contract already uses `null`.
- Solana/Sui/non-EVM addresses must remain case-safe. Loader code must not normalize addresses at import time.
- `CAUSE_HEX` and `CAUSE_META` remain executable TS constants; only the dead-coin array moves to data.

## Workstream A: DEX Consolidation

### Current duplication to remove

- CoinGecko onchain pool parsing/classification exists in both:
  - `worker/src/cron/dex-discovery/crawl-sources.ts`
  - `worker/src/cron/dex-liquidity/fetch-crawlers.ts`
- CoinGecko tickers orderbook aggregation exists in both:
  - `worker/src/cron/dex-discovery/crawl-sources.ts`
  - `worker/src/cron/dex-liquidity/fetch-fallbacks.ts`
- GT/CG token-batch price observation mapping exists twice in:
  - `worker/src/cron/dex-liquidity/fetch-primary.ts`
- Existing shared code already covers part of the problem:
  - `worker/src/cron/dex-liquidity/geckoterminal-shared.ts`
  - `worker/src/cron/dex-liquidity/crawl-helpers.ts`

### Target structure

- Keep `geckoterminal-shared.ts` as the GT owner.
- Add one shared CG onchain normalizer module:
  - `worker/src/cron/dex-liquidity/coingecko-onchain-shared.ts`
- Add one shared CoinGecko tickers aggregation module:
  - `worker/src/cron/dex-liquidity/coingecko-tickers-shared.ts`
- Add one shared token observation mapper:
  - `worker/src/cron/dex-liquidity/token-price-observations.ts`

These should be small, source-specific helpers. Do not build a generic “source adapter framework.”

### Phase A0: Characterization tests first

Add or expand targeted tests before moving code:

- `worker/src/cron/dex-liquidity/__tests__/fetch-crawlers.test.ts`
  - CG fee bucket classification
  - balance-ratio inference
  - locked-liquidity propagation
- `worker/src/cron/dex-liquidity/__tests__/fetch-fallbacks.test.ts`
  - CoinGecko ticker filtering
  - exchange-level aggregation
  - synthetic TVL and price observation rules
- `worker/src/cron/dex-liquidity/__tests__/fetch-primary.test.ts`
  - GT token-batch observation mapping
  - CG token-batch observation mapping
  - plausibility and min-TVL gating
- `worker/src/cron/dex-discovery/__tests__/crawl-sources.test.ts`
  - discovery-stage CG and CG-ticker output shaping still matches current staging rows

Acceptance gate:

- Current behavior is locked in by tests before extraction begins.

### Phase A1: Extract CoinGecko onchain normalization

Create `worker/src/cron/dex-liquidity/coingecko-onchain-shared.ts` with helpers that own:

- parsing a raw CG onchain pool into a normalized intermediate object
- fee-bucket classification
- fallback DEX-quality classification when fee data is absent
- balance-ratio inference
- locked-liquidity parsing

Recommended helper surface:

- `parseCgPool(pool): ParsedPool | null`
- `classifyCgPool(parsed, rawAttrs): { qualityMultiplier, poolType, feePercentage, lockedLiquidityPct, balanceRatio }`

Refactor callers:

- `worker/src/cron/dex-liquidity/fetch-crawlers.ts`
- `worker/src/cron/dex-discovery/crawl-sources.ts`

Callers should continue to decide:

- minimum TVL threshold
- emitted result shape (`CgNewPool` vs `StagedPool`)
- whether to add price observations
- logging labels and budgets

Deletion target:

- remove duplicated CG parse/fee/balance logic from both call sites.

### Phase A2: Extract token-batch price observation mapping

Create `worker/src/cron/dex-liquidity/token-price-observations.ts` to own the repeated “token aggregate -> `DexPriceObs`” mapping now duplicated in `fetch-primary.ts`.

Recommended helper surface:

- `appendTokenBatchPriceObservations({ priceObs, batch, tokens, sourceLabel, getAddress, getPriceUsd, getTvlUsd, references })`

Refactor callers:

- GT path in `fetchGtTokenBatch()`
- CG path in `fetchCgTokenBatchPrices()`

The shared helper should own:

- tracked token lookup inside the batch
- price/TVL parsing
- plausibility gating
- min-TVL gating
- pushing `DexPriceObs`

The callers should retain:

- request batching
- endpoint construction
- rate limiting
- source-specific `protocol` labels (`geckoterminal-aggregate`, `coingecko-aggregate`)

Deletion target:

- remove the duplicated inner observation loops in both branches of `fetch-primary.ts`.

### Phase A3: Extract CoinGecko tickers orderbook aggregation

Create `worker/src/cron/dex-liquidity/coingecko-tickers-shared.ts` to own:

- valid ticker filtering
- USD-quote eligibility
- exchange-level aggregation
- synthetic TVL computation via `ORDERBOOK_TVL_FACTOR`
- weighted-price computation
- orderbook price-observation gating

Recommended helper surface:

- `filterValidCgTickers(tickers): CgTicker[]`
- `aggregateCgTickersByExchange(tickers): Map<string, AggregatedExchangeTicker>`
- `buildCgTickerPools(meta, aggregates, references): { pools: GtNewPool[]; priceObs: DexPriceObs[] }`

Refactor callers:

- discovery stage in `worker/src/cron/dex-discovery/crawl-sources.ts`
- scoring fallback in `worker/src/cron/dex-liquidity/fetch-fallbacks.ts`

Callers should continue to own:

- network fetches
- timeout / retry behavior
- per-coin sequencing
- domain-specific output wrapping where needed

Deletion target:

- remove duplicated by-exchange aggregation and synthetic orderbook pool construction from both modules.

### Phase A4: Cleanup and doc sync

After the extractions:

- re-scan `crawl-sources.ts`, `fetch-crawlers.ts`, `fetch-fallbacks.ts`, and `fetch-primary.ts` for any remaining source-family duplication and delete leftovers
- update `docs/dex-liquidity.md` and `docs/data-pipeline.md` to reflect the broader shared-helper ownership, not just `geckoterminal-shared.ts`
- update `docs/testing.md` if new targeted test files are added

### DEX rollout strategy

Implement Workstream A in two PRs:

1. PR A1: characterization tests + CG onchain normalizer
2. PR A2: token observation mapper + CG tickers aggregation + doc cleanup

This keeps regression scope smaller and isolates the highest-risk behavior changes.

### DEX risks to watch

- Do not alter discovery source order: `CG Onchain -> GeckoTerminal -> DexScreener -> CG Tickers`.
- Do not collapse discovery and liquidity into one shared output type; that would add new indirection without reducing conceptual load.
- Preserve all current logging labels and degraded/partial-result behavior.
- Keep request bodies consumed before opening new fetches where current code already relies on that pattern.
- Re-check price-observation provenance after the refactor; these observations feed downstream DEX price median logic.

## Workstream B: Static Registry Extraction

### Current data to move

- `shared/lib/stablecoins/usd-minor.ts` (`3035` lines)
- `shared/lib/stablecoins/usd-major.ts` (`1171` lines)
- `shared/lib/stablecoins/non-usd.ts` (`838` lines)
- `shared/lib/stablecoins/commodity.ts` (`220` lines)
- `shared/lib/dead-stablecoins.ts` (`1282` lines, but only the array should move)
- `shared/lib/stablecoins/index.ts` also contains the canonical order list and module-level array assembly

### Target structure

- `shared/data/stablecoins/usd-major.json`
- `shared/data/stablecoins/usd-minor.json`
- `shared/data/stablecoins/non-usd.json`
- `shared/data/stablecoins/commodity.json`
- `shared/data/stablecoins/canonical-order.json`
- `shared/data/dead-stablecoins.json`

Keep executable TS loaders thin:

- `shared/lib/stablecoins/index.ts`
- `shared/lib/stablecoins/schema.ts`
- `shared/lib/dead-stablecoins.ts`

### Data-format decision

Use JSON assets plus runtime validation, not generated TS.

Reasons:

- the repo already enables `resolveJsonModule` in both root and worker TS configs
- `zod` is already a dependency
- this removes executable array noise while keeping the current import model simple
- validation can fail fast during test/build if the dataset becomes malformed

Do not use `null` as a substitute for omitted optional fields unless the existing runtime contract explicitly expects `null`.

### Phase B0: Add schemas and loader tests first

Create or extend schemas in `shared/lib/stablecoins/schema.ts` to validate the imported JSON assets against `StablecoinMeta`.

Recommended artifacts:

- `StablecoinMetaAssetSchema`
- `StablecoinMetaAssetArraySchema`
- `DeadStablecoinAssetSchema`
- `DeadStablecoinAssetArraySchema`

Add tests:

- `shared/lib/__tests__/stablecoins.test.ts`
  - imported assets load successfully
  - canonical order references only known IDs
  - active/pre-launch partitions are unchanged
- `shared/lib/__tests__/stablecoin-id-registry.test.ts`
  - dead-coin registry still builds correctly
- `shared/lib/__tests__/classification-invariants.test.ts`
  - unchanged consumer behavior
- add a new focused loader/schema test if needed for malformed-asset rejection

Acceptance gate:

- schemas exist before data migration starts, so the move is immediately validated.

### Phase B1: Migrate tracked stablecoin data

Steps:

1. Convert category arrays from TS factory calls to JSON assets with the same field names as `StablecoinMeta`.
2. Move `CANONICAL_ORDER` out of `shared/lib/stablecoins/index.ts` into `shared/data/stablecoins/canonical-order.json`.
3. Rewrite `shared/lib/stablecoins/index.ts` to:
   - import the JSON assets
   - validate them once at module load
   - assemble `TRACKED_STABLECOINS`
   - rebuild `TRACKED_META_BY_ID`, `ACTIVE_STABLECOINS`, `PRE_LAUNCH_STABLECOINS`, and the existing ID sets/maps
4. Keep all existing exports stable so current imports across `src/`, `shared/`, and `worker/` do not change.

Deletion target:

- delete `shared/lib/stablecoins/usd-major.ts`
- delete `shared/lib/stablecoins/usd-minor.ts`
- delete `shared/lib/stablecoins/non-usd.ts`
- delete `shared/lib/stablecoins/commodity.ts`
- delete `shared/lib/stablecoins/factory.ts` once no callers remain

Important compatibility note:

- There appear to be many consumers of `@shared/lib/stablecoins`, but no active repo consumers of the `coin` / `usd` / `eur` / `other` factory exports. Confirm that remains true immediately before deleting `factory.ts`.

### Phase B2: Migrate dead stablecoin data

Steps:

1. Move only `DEAD_STABLECOINS` into `shared/data/dead-stablecoins.json`.
2. Keep `CAUSE_HEX` and `CAUSE_META` in `shared/lib/dead-stablecoins.ts`.
3. Rewrite `shared/lib/dead-stablecoins.ts` to:
   - import the JSON asset
   - validate it once
   - export `DEAD_STABLECOINS` with the same type

Deletion target:

- remove the handwritten TS array while keeping the existing metadata/color exports stable.

### Phase B3: Update scripts and docs

Update `scripts/check-doc-counts.mjs` because it currently scrapes:

- `shared/lib/stablecoins/index.ts` for `CANONICAL_ORDER`
- `shared/lib/stablecoins/*.ts` for `liveReservesConfig`

Refactor the script to read from the new assets instead:

- count tracked stablecoins from `shared/data/stablecoins/canonical-order.json`
- count live-enabled stablecoins by reading the stablecoin JSON assets directly

Also update docs that mention the old TS file locations:

- `docs/scripts.md`
- `docs/api-reference.md`
- `docs/data-pipeline.md`
- `docs/shadow-stablecoins.md`
- `docs/mint-burn-flows.md`
- `docs/yield-intelligence.md`
- `docs/testing.md`

Only update wording that references storage paths or validation sources. Do not broaden the scope into methodology edits.

### Phase B4: Final cleanup

- remove stale comments in `index.ts` referring to “add entry to the category file AND insert its ID here”
- remove any now-redundant helper code that existed only to construct TS literals
- if TypeScript or Wrangler typecheck does not include imported JSON assets correctly, widen the relevant `include` globs in `tsconfig.json` and `worker/tsconfig.json`

### Registry rollout strategy

Implement Workstream B in two PRs:

1. PR B1: schema/loaders + tracked stablecoin JSON migration + `check-doc-counts` update
2. PR B2: dead stablecoin JSON migration + path/docs cleanup + factory deletion

This keeps the tracked-coins move and cemetery move separately reviewable.

### Registry risks to watch

- JSON assets cannot carry comments. If any comments contain material provenance, move that information into explicit data fields or nearby docs before deleting it.
- Imported JSON must preserve field omission, especially for optional config blocks such as `liveReservesConfig`, `yieldConfig`, `reserves`, `contracts`, and `featuredContent`.
- Do not normalize addresses, symbols, or IDs during load; the loader should validate and assemble, not mutate silently.
- Fail-fast validation at import time means malformed metadata will break builds. That is desirable, but the test suite must make failures readable.

## Proposed Execution Order

1. Add DEX characterization tests.
2. Extract the CG onchain normalizer and land it with no behavior change.
3. Extract the token-batch observation mapper.
4. Extract the CG tickers aggregation helper.
5. Add registry schemas and loader tests.
6. Move tracked stablecoin metadata to JSON and update `check-doc-counts`.
7. Move dead stablecoin data to JSON.
8. Update file-path docs and remove obsolete TS-only helper modules.

This order minimizes simultaneous risk. The worker refactor lands first while the registry exports stay stable. The large metadata move happens only after the DEX pipeline is quiet.

## Verification Matrix

Run targeted checks after each phase, then the full repo gates at the end.

### After DEX Phase A1-A3

- targeted Vitest suites for:
  - `worker/src/cron/dex-discovery/__tests__/`
  - `worker/src/cron/dex-liquidity/__tests__/`
- `cd worker && npx tsc --noEmit`

### After Registry Phase B1-B3

- `npm run check:doc-counts`
- targeted shared-lib Vitest suites:
  - `shared/lib/__tests__/stablecoins.test.ts`
  - `shared/lib/__tests__/stablecoin-id-registry.test.ts`
  - `shared/lib/__tests__/classification-invariants.test.ts`
- `cd worker && npx tsc --noEmit`
- `npm run build`

### Final gate before merge

- `npm run lint`
- `npm test`
- `npm run build`
- `npm run check:doc-counts`
- `npm run check:worker-boundary`
- `cd worker && npx tsc --noEmit`

## Expected Outcome

- DEX source-family rules become easier to change because each rule has one owner.
- The worker cron files become shorter and more obviously orchestration-focused.
- Stablecoin metadata review becomes data review instead of code review.
- The shared registry surface stays stable for callers, while the underlying maintenance burden drops materially.
- Rough line-count reduction from Tier 3 alone should be dominated by the registry move and should remove most of the current 6.8k lines of registry-heavy TS.
