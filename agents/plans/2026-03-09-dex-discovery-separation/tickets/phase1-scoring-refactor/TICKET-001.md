---
title: "Strip optional discovery phases from syncDexLiquidity orchestrator"
agent: codex
model: gpt-5.3-codex
reasoning_effort: medium
done: false
---

## Goal

Remove all optional discovery phases from the scoring cron orchestrator. These are moving to the independent discovery cron.

## Context

The file `worker/src/cron/dex-liquidity/orchestrator.ts` currently contains a monolithic pipeline that both fetches primary sources AND runs optional discovery crawls (CG token batch, GT token batch, CG pool crawl, GT pool crawl, DexScreener fallback, CG tickers fallback). The optional phases are moving to a separate discovery cron. This ticket strips them from the scoring cron.

## Task

1. Read `worker/src/cron/dex-liquidity/orchestrator.ts` fully to understand the current structure.

2. Remove the following elements:

### Constants and budget logic to remove

- `OPTIONAL_DISCOVERY_BUDGET_MS` constant (around line 18)
- `optionalDiscoveryDeadlineMs` variable
- `optionalBudgetExhausted` variable
- `hasOptionalBudget()` function
- Any references to these in the return metadata

### Discovery phases to remove (blocks within the orchestrator function)

**Phase 4d — CG token batch prices:** The block starting with `if (useCg && hasOptionalBudget())` that calls `fetchCgTokenBatchPrices()`. Remove the entire try/catch block and the `cgTokenPriceObs` variable declaration. Also remove any code that merges `cgTokenPriceObs` into `priceObservations`.

**Phase 4e — GT token batch prices:** The block starting with `if ((!useCg || gtChainAddresses.size > 0) && hasOptionalBudget())` that calls `fetchGtTokenBatch()`. Remove the entire try/catch block and the `gtTokenPriceObs` variable. Remove merge into `priceObservations`.

**Phase 4f — CG pool crawl:** The block calling `fetchCgPools()`. Remove the entire try/catch block and `cgCrawlNewPools`, `cgCrawlPriceObs` variables. Remove merge into `priceObservations`.

**Phase 4g — GT pool crawl:** The block calling `fetchGtPools()`. Remove the entire try/catch block and `gtCrawlNewPools`, `gtCrawlPriceObs` variables. Remove merge into `priceObservations`.

**Phase 5a — CG pool merge:** `mergeCgPools(metrics, cgCrawlNewPools)` call. Remove entirely.

**Phase 5b — GT pool merge:** `mergeGtPools(metrics, gtCrawlNewPools)` call (the one right after mergeCgPools, NOT any other mergeGtPools calls). Remove.

**Phase 5c — DexScreener fallback:** The block starting with `if (hasOptionalBudget())` that calls `fetchDsFallbackPools()`. Remove the entire try/catch block. Remove subsequent `mergeGtPools(metrics, dsFallback.newPools)` and price observation merge.

**Phase 5d — CG tickers fallback:** The block starting with `if (hasOptionalBudget())` that calls `fetchCgTickersFallback()`. Remove the entire try/catch block. Remove subsequent merge calls.

### Price observation merge blocks to remove

After the discovery phases, there are merge loops (around lines 201-220) that iterate over `cgTokenPriceObs`, `gtTokenPriceObs`, `cgCrawlPriceObs`, and `gtCrawlPriceObs` to merge them into `priceObservations`. Since all four variables are removed, these merge loops become dead code. Remove them entirely.

### `useCg` and related cleanup

After removing discovery phases, check if `useCg` is still used. It was used to gate CG-vs-GT discovery. After removal, it may appear in:
- A console.log about "pool discovery source" — remove this log line
- The `fallbackMode` field in the return metadata (e.g., `useCg ? "cg-crawl-primary" : "gt-crawl-primary"`) — remove this entry from fallbackMode since the orchestrator no longer does any pool discovery

If `useCg` has no remaining usages, remove the variable declaration and the `cgApiKey` usage that computes it.

Also check if `cgApiKey` itself is still needed in the function signature after all discovery removals. If it's only used for `useCg`, it can be removed from the signature.

### Imports to clean up

Remove now-unused imports. After stripping, the following should no longer be imported:
- `fetchCgPools`, `mergeCgPools`, `fetchGtPools`, `mergeGtPools` from `./fetch-crawlers`
- `fetchDsFallbackPools`, `fetchCgTickersFallback` from `./fetch-fallbacks`
- `fetchCgTokenBatchPrices` from `./fetch-primary` (if this was only used for the token batch phase)
- `fetchGtTokenBatch` from `./fetch-primary` or wherever it's imported from

**Be careful:** Some imports may still be needed. For example:
- `mergeGtPools` might be used elsewhere — check before removing
- `fetchDataSources` from `./fetch-primary` is definitely still needed (primary sources)
- All scoring, persistence, subgraph, and Curve imports are still needed

Check each import by searching for all usages in the file after the removal.

### Metadata to clean up

In the return `metadata` JSON object at the end of the function, remove:
- `optionalBudgetExhausted` (or equivalent field)
- Any fields related to discovery-specific tracking that no longer applies

Keep: `rowsRead`, `rowsWritten`, `rowsDropped`, `sourceCoverage`, `failedSources`, `fallbackMode`, `validationFailures`.

### Variables that may need cleanup

After removing the discovery blocks, check for variables that are now declared but never used:
- `cgChainAddresses`, `gtChainAddresses` — these were used to route CG vs GT discovery. Check if they're still used elsewhere (e.g., in buildKnownPoolAddresses or processPoolMetrics). If not used, remove them.
- `useCg` — check if still used after removal. It may still be relevant for other logic.

3. **Do NOT modify:**
   - Primary source fetching (DeFiLlama, Curve, UniV3, Aerodrome)
   - Pool processing, scoring, persistence, or history logic
   - The `buildKnownPoolAddresses()` call (this is still needed for dedup with staging merge in Phase 2)
   - Any other files

4. Verify the remaining orchestrator flow is:
   1. Fetch primary data sources (DL Yields, DL Protocols, Curve)
   2. Build symbol/address lookups
   3. Build Curve pool map + price observations
   4. Fetch UniV3 subgraph data
   5. Fetch Aerodrome subgraph data
   6. Build known pool address set
   7. Process pool metrics from DL pools
   8. Compute stablecoin scores
   9. Coverage guard
   10. Persist scores + DEX prices
   11. Write historical snapshots
   12. Compute depth stability
   13. Return result

## Acceptance Criteria

- `cd worker && npx tsc --noEmit` exits 0
- `npm run lint` exits 0 (no unused imports or variables)
- `grep -c "hasOptionalBudget" worker/src/cron/dex-liquidity/orchestrator.ts` returns `0`
- `grep -c "OPTIONAL_DISCOVERY_BUDGET_MS" worker/src/cron/dex-liquidity/orchestrator.ts` returns `0`
- `grep -c "fetchCgPools" worker/src/cron/dex-liquidity/orchestrator.ts` returns `0`
- `grep -c "fetchGtPools" worker/src/cron/dex-liquidity/orchestrator.ts` returns `0`
- `grep -c "fetchDsFallbackPools" worker/src/cron/dex-liquidity/orchestrator.ts` returns `0`
- `grep -c "fetchCgTickersFallback" worker/src/cron/dex-liquidity/orchestrator.ts` returns `0`
- `grep -c "fetchCgTokenBatchPrices" worker/src/cron/dex-liquidity/orchestrator.ts` returns `0`
- `grep -c "fetchGtTokenBatch" worker/src/cron/dex-liquidity/orchestrator.ts` returns `0`
- `grep -c "mergeCgPools" worker/src/cron/dex-liquidity/orchestrator.ts` returns `0`
- Primary source imports (`fetchDataSources`, `fetchUniV3Data`, `fetchAerodromeData`) are still present
- Scoring imports (`computeStablecoinScores`, `persistScores`) are still present
- `npm run build` exits 0
- `npm test` exits 0 (no regressions)
