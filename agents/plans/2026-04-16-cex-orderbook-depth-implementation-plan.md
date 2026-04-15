# CEX orderbook depth implementation plan

Date: 2026-04-16

## Goal

Upgrade the existing CoinGecko ticker/orderbook fallback from volume-only synthetic liquidity to depth-informed orderbook liquidity, while preserving the current conservative behavior when depth fields are missing.

This implements Phase 1 from `agents/research/2026-04-16-cex-orderbook-liquidity-modalities.md`.

## Non-goals

- Do not add direct Binance/Coinbase/Kraken clients in this pass.
- Do not add a new paid market-data provider.
- Do not rework the main DEX Liquidity Score formula.
- Do not make CEX depth a standalone Safety Score component yet.
- Do not add D1 migrations unless unavoidable.

## Existing path to extend

Existing source path:

- `worker/src/cron/dex-liquidity/coingecko-tickers-shared.ts`
- `worker/src/cron/dex-liquidity/fetch-fallbacks.ts`
- `worker/src/cron/dex-discovery/crawl-sources.ts`
- `worker/src/cron/dex-liquidity/staging-merge.ts`
- `worker/src/cron/dex-liquidity/pool-contribution.ts`

Current behavior:

- Calls CoinGecko `/coins/{id}/tickers?...&depth=false`.
- Filters stale/anomalous/non-USD/low-volume tickers.
- Aggregates all valid tickers by exchange.
- Creates one synthetic `orderbook` pool per exchange.
- Uses `syntheticTvlUsd = converted_volume.usd * ORDERBOOK_TVL_FACTOR`.
- Marks rows as synthetic with `poolType = "orderbook"` and `qualityMultiplier = 0.6`.

## Proposed behavior

Use `depth=true` in both CoinGecko ticker callers.

Read these optional fields from each ticker:

- `cost_to_move_down_usd`
- `cost_to_move_up_usd`

For each exchange aggregate:

- `volumeUsd = sum(converted_volume.usd)`
- `priceUsd = volume-weighted converted_last.usd`
- `volumeDerivedTvlUsd = volumeUsd * ORDERBOOK_TVL_FACTOR`
- `depthDownUsd = sum(valid cost_to_move_down_usd)` when at least one valid depth value exists
- `depthUpUsd = sum(valid cost_to_move_up_usd)` when at least one valid depth value exists
- `syntheticTvlUsd = depthDownUsd != null ? min(volumeDerivedTvlUsd, depthDownUsd) : volumeDerivedTvlUsd`
- `tvlBasis = "coingecko-depth-2pct-capped-by-volume"` when depth exists, else `"volume-derived"`

Why `min(volumeDerivedTvlUsd, depthDownUsd)`:

- It avoids increasing score from an unvalidated new field on day one.
- It uses measured downside depth to reduce overstated volume-derived books.
- It preserves existing coverage when CoinGecko omits depth fields.

## Metadata propagation

Direct scoring fallback:

- Add optional `orderbookDepthUsd`, `orderbookDepthUpUsd`, and `orderbookTvlBasis` to `GtNewPool`.
- `addSecondaryPoolContribution()` writes them into `PoolEntry.extra`.
- Keep `measurement.synthetic = true`.
- Set `measurement.tvlMeasured = true` when depth exists, otherwise `false`.

Discovery staging path:

- Store orderbook depth metadata in `StagedPool.rawJson` for `cg_tickers` rows.
- Include `raw_json` in the staging merge SELECT.
- Parse the JSON only for `cg_tickers` staged rows.
- Forward parsed metadata into `GtNewPool` before `addSecondaryPoolContribution()`.

No D1 migration is needed because `raw_json` already exists in `dex_pool_staging`.

## Docs

Update `docs/dex-liquidity.md`:

- CoinGecko tickers now requests `depth=true`.
- Synthetic TVL uses measured 2% downside orderbook depth when available, capped by the existing volume-derived estimate.
- Rows remain centralized/synthetic orderbook entries with the existing quality and synthetic-share penalties.

Update `agents/research/2026-04-16-cex-orderbook-liquidity-modalities.md` only if implementation diverges from the selected Phase 1 design.

## Tests

Update/add:

- `worker/src/cron/dex-liquidity/__tests__/fetch-fallbacks.test.ts`
  - parses depth fields
  - uses depth-capped TVL when available
  - falls back to volume-derived TVL when depth is absent
  - keeps price observations gated by the used TVL
- `worker/src/cron/dex-discovery/__tests__/crawl-sources.test.ts`
  - expected request URL uses `depth=true`
  - staged `rawJson` contains depth metadata
  - `tvlUsd` uses depth-capped value
- `worker/src/cron/dex-liquidity/__tests__/staging-merge.test.ts`
  - staged `cg_tickers` raw JSON depth metadata survives into top-pool `extra`

## Review loop

### Review round 1

Findings:

1. Major: A naive `depthUsd` replacement could reduce existing coverage to zero when CoinGecko omits depth fields.
   - Fix: preserve volume-derived fallback when depth fields are missing.
2. Major: Using `depthDownUsd` directly could inflate scores if the field is much larger than existing volume-derived synthetic TVL.
   - Fix: cap measured depth by `volumeUsd * ORDERBOOK_TVL_FACTOR` for Phase 1.
3. Minor: Discovery staging would lose depth metadata unless it is persisted.
   - Fix: use existing `raw_json` column; no migration needed.
4. Minor: Calling `depth=true` may increase response payload size.
   - Fix: keep current fallback target set and shared deadline; no broadening of target universe.

### Review round 2

Findings:

1. Minor: The field name `syntheticTvlUsd` becomes less precise once it can be depth-capped.
   - Fix: keep the existing field for compatibility but add `tvlBasis` and explicit orderbook depth metadata.

Open issues above minor: none.

This satisfies the implementation gate: fewer than two minor issues remain.

## Commit plan

1. Plan batch:
   - this implementation plan
2. Code batch:
   - depth parsing, TVL basis, fallback URL changes, metadata propagation
   - focused tests
3. Docs batch if code batch is large enough to warrant separate review:
   - `docs/dex-liquidity.md`
   - any research note amendments

## Validation

Run at minimum:

- `npm test -- worker/src/cron/dex-liquidity/__tests__/fetch-fallbacks.test.ts worker/src/cron/dex-discovery/__tests__/crawl-sources.test.ts worker/src/cron/dex-liquidity/__tests__/staging-merge.test.ts`
- `npm run lint`
- `npm run typecheck`
- `npm run check:doc-sync`
- `npm run build`
- `npm run test:merge-gate`

