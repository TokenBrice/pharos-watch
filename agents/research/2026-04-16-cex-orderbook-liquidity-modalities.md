# CEX / orderbook liquidity implementation modalities

Date: 2026-04-16

## Scope

Research implementation paths for adding centralized exchange / orderbook depth to Exit Liquidity without overstating weak venues or thin books.

This follows the primary-market exit + core settlement rail work. No implementation was done in this research pass.

## Current repo baseline

Pharos already has two orderbook-like surfaces:

- `worker/src/lib/cex-tickers.ts` fetches direct CEX ticker prices from Binance, Kraken, Bitstamp, and Coinbase for pricing corroboration.
- `worker/src/cron/dex-liquidity/coingecko-tickers-shared.ts` turns CoinGecko `/coins/{id}/tickers` rows into synthetic orderbook pools for missing/weak DEX coverage. Current synthetic TVL is `converted_volume.usd * ORDERBOOK_TVL_FACTOR`, with `ORDERBOOK_TVL_FACTOR = 3`, `poolType = "orderbook"`, and quality multiplier `0.6x`.

The current limitation: this is volume-derived synthetic liquidity, not measured executable depth.

## Modality A — CoinGecko depth=true, extend existing ticker fallback

Sources:

- CoinGecko `/coins/{id}/tickers`: https://docs.coingecko.com/reference/coins-id-tickers
- CoinGecko `/exchanges/{id}/tickers`: https://docs.coingecko.com/reference/exchanges-id-tickers

CoinGecko already exposes the fields we need for a measured-but-aggregated depth proxy:

- `cost_to_move_up_usd`
- `cost_to_move_down_usd`
- `bid_ask_spread_percentage`
- `converted_volume.usd`
- `is_stale`
- `is_anomaly`
- `last_fetch_at`

The docs state `depth=true` includes 2% orderbook depth. That maps well to stablecoin exit depth because for a stablecoin the cost to move down 2% is a direct stress-side liquidity proxy.

Implementation sketch:

1. Change existing CoinGecko ticker calls from `depth=false` to `depth=true`.
2. Extend `CgTicker` types to read `cost_to_move_down_usd` / `cost_to_move_up_usd` when present, while preserving the existing volume-derived fallback when CoinGecko omits depth fields.
3. Build two values per exchange:
   - measured downside depth: sum or max of `cost_to_move_down_usd` across accepted stablecoin/USD-equivalent markets
   - volume sanity: keep the current converted-volume filter and possibly require a minimum depth/volume ratio
4. Replace or blend synthetic TVL:
   - conservative selected option: `tvlUsd = min(volume * 3, costToMoveDownUsd)` when downside depth is available; otherwise keep `volume * 3`
   - depth-forward option: `tvlUsd = costToMoveDownUsd`
   - hybrid option: `tvlUsd = sqrt(costToMoveDownUsd * volume * 3)`
5. Keep `poolType = "orderbook"`, source family `cg_tickers`, quality multiplier at or below `0.6x`.

Pros:

- Smallest code change; reuses existing fallback, metadata, staging merge, synthetic penalties, and rate-limit budget.
- Broad venue coverage without bespoke per-exchange clients.
- No new provider dependency if the current CoinGecko plan supports depth fields.
- Good first implementation for USDC/USDT because it should preserve DEX floor while recognizing real venue depth.

Cons:

- Depth is only ±2%, not full book inventory.
- CoinGecko is an aggregator; venue methodology is less transparent than direct orderbook reads.
- The endpoint is paginated to 100 tickers, so top-volume ordering and pagination strategy matter.
- Need to verify whether the current configured API key tier returns depth fields consistently.

Risk controls:

- CEX depth cannot count when `is_stale` or `is_anomaly`.
- Require USD-equivalent quote assets and plausible stablecoin price.
- Cap CEX/orderbook contribution as a share of total liquidity score.
- Continue marking rows synthetic/orderbook and penalize synthetic share.

Recommendation:

Best first implementation. It upgrades an existing lane from volume-implied to depth-informed with minimal scheduler and schema risk.

## Modality B — Direct public exchange orderbook polling

Sources:

- Binance Spot order book endpoint: https://developers.binance.com/docs/binance-spot-api-docs/rest-api/market-data-endpoints
- Coinbase Exchange product book endpoint: https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-book
- Kraken order book endpoint: https://docs.kraken.com/api/docs/rest-api/get-order-book/

Official docs confirm public orderbook endpoints:

- Binance: `GET /api/v3/depth`, `limit` up to 5000, request weight rises sharply with limit.
- Coinbase: `GET /products/{product_id}/book`, `level=2` returns aggregated full order book and is recommended for polling.
- Kraken: `GET /public/Depth`, L2 order book with aggregated quantities.

Implementation sketch:

1. Add `worker/src/lib/cex-orderbooks.ts` beside `cex-tickers.ts`.
2. Start with an allowlist:
   - Binance: `USDCUSDT`, `USDCFDUSD`, maybe `USDTFDUSD` / `USDTUSDC` where available
   - Coinbase: `USDC-USD`, `USDT-USD`
   - Kraken: `USDC/USD`, `USDT/USD`
3. Normalize books into a shared shape:
   - venue
   - pair
   - bids / asks
   - fetchedAt
   - depthDown1Pct / depthDown2Pct
   - depthUp1Pct / depthUp2Pct
   - spreadBps
4. Compute stablecoin exit depth:
   - for base stablecoin vs USD quote, use bids within 1-2% below mid
   - for quote stablecoin vs USD/base, invert carefully
   - reject crossed, stale, sparse, or high-spread books
5. Persist as orderbook source rows or a new `cex_liquidity` table consumed by report cards.

Pros:

- Direct measurement, transparent and reproducible.
- Can compute custom bands: 10 bps, 50 bps, 100 bps, 200 bps.
- Better for blue-chip assets with deep books.
- Avoids aggregator opacity.

Cons:

- More maintenance: symbol mapping, rate limits, exchange outages, IP blocks, per-venue quirks.
- Worker connection budget matters. Directly polling many books in the DEX liquidity cron can compete with existing fetch-heavy work.
- Some deep venues do not list direct USD pairs or have jurisdiction-specific availability.
- Need durable venue quality rules so one questionable venue does not dominate.

Risk controls:

- Start with 3-4 high-quality venues only.
- Query only major assets first.
- Keep hard per-run request budget and per-venue timeout.
- Do not count any venue with stale timestamp, crossed book, spread above a threshold, or abnormal price divergence.
- Cap direct CEX contribution separately from DEX liquidity so centralized orderbooks do not dominate the whole dimension.

Recommendation:

Best second implementation after CoinGecko depth proves value. More accurate, but higher maintenance and scheduler risk.

## Modality C — Paid institutional market-data aggregator

Sources:

- Amberdata order books: https://docs.amberdata.io/data-dictionary/market/order-books
- Coin Metrics API v4 order books: https://docs.coinmetrics.io/api/v4

Amberdata docs describe order book endpoints across spot, futures, and options, with one-minute snapshots and full-depth/event data subject to venue limits. Coin Metrics docs expose market orderbook catalog and timeseries endpoints, including `depth_limit` options such as `100`, `full_book`, and percentage bands like `10pct_mid_price`.

Implementation sketch:

1. Add a provider abstraction, not venue-specific clients:
   - `fetchCexDepthProviderSnapshot(provider, coinIds)`
   - normalized `CexDepthRow`
2. Query a narrow universe first:
   - USDT, USDC, USDS/DAI, PYUSD, FDUSD, RLUSD, USD1
3. Normalize provider rows to:
   - exchange
   - pair
   - side
   - depth bands
   - snapshot timestamp / collect time
   - provider confidence
4. Persist to D1 with provider provenance and freshness.
5. Consume in report-card Liquidity / Exit as a separate component or bounded orderbook overlay.

Pros:

- Most complete and normalized coverage.
- Historical data enables durability, volatility, and backtestable liquidity stress metrics.
- Cleaner than maintaining many direct exchange clients.
- Good for institutional-grade methodology if budget is acceptable.

Cons:

- New paid vendor dependency and likely API keys/secrets.
- Could create licensing/display constraints.
- More operational surface: quotas, contract terms, coverage drift.
- Less transparent than direct public exchange reads unless provider provenance is surfaced carefully.

Risk controls:

- Treat paid provider data as `measured-cex-depth`, not DEX liquidity.
- Require provider timestamps and source exchange identity.
- Keep caps and venue diversification requirements.
- Document vendor coverage limits and display provenance.

Recommendation:

Best long-term option if Pharos wants durable institutional-grade exchange-depth history. Not the fastest path.

## Scoring integration options

Regardless of modality, do not simply add CEX depth to DEX TVL one-for-one.

Safer patterns:

1. Separate component in Liquidity / Exit:
   - `effectiveExit = max(dexScore, redemptionScore, cexDepthScore) + diversification bonuses`
   - CEX score capped around 70-75 unless multiple top venues agree
2. Orderbook overlay on DEX liquidity:
   - add only a bounded bonus to the DEX score
   - e.g. `dex + min(cexDepthScore, dex) * 0.10`
3. Report-card-only path:
   - keep `/liquidity` DEX-only
   - let Report Cards consume a separate `cexExitScore`
   - avoids rebranding DEX page as broader exit liquidity

Preferred scoring path:

- Keep the public DEX Liquidity Score DEX-first.
- Add a report-card-only `cexExitScore` or `centralizedDepthScore`.
- Blend it like the new primary-market exit bonus: a bounded second-path contribution unless the CEX source is multi-venue, fresh, and deeply measured.

## Suggested phased plan

Phase 1:

- Enable CoinGecko `depth=true` for the existing `cg_tickers` lane.
- Store measured downside 2% depth in orderbook metadata.
- Keep scoring impact as a small bounded bonus.

Phase 2:

- Add direct orderbook clients for Binance, Coinbase, and Kraken for USDC/USDT only.
- Compare direct depth against CoinGecko depth for 2-4 weeks.
- Do not change scoring until correlation and freshness are acceptable.

Phase 3:

- Decide whether a paid provider is worth it for broad coverage and history.
- If yes, use it as primary CEX depth and direct exchange reads as canaries.
