# Binance and Jupiter Price Circuit Investigation

Date: 2026-04-14
Investigator: Codex

## Scope

Investigate live `binance-prices` and `jupiter-prices` circuit breakers and decide whether Pharos needs operator or code action.

## Live State

- `/api/health` at 2026-04-14 16:22:39 UTC reported `status: healthy`, no warnings, and a fresh `stablecoins` cache (`ageSeconds: 369`, `maxAge: 600`).
- Open circuits:
  - `binance-prices`: open, 3 consecutive failures, last success 2026-04-14 15:35:36 UTC, opened/last failure 2026-04-14 16:01:49 UTC.
  - `jupiter-prices`: open, 3 consecutive failures, last success 2026-04-14 15:32:10 UTC, opened/last failure 2026-04-14 16:17:01 UTC.
- Later probe checks:
  - 2026-04-14 16:31 UTC run completed `ok`; `binance-prices` probe failed/reopened at 2026-04-14 16:35:18 UTC with 4 consecutive failures.
  - 2026-04-14 17:01 UTC run completed `ok`; `jupiter-prices` probe failed/reopened at 2026-04-14 17:01:56 UTC with 4 consecutive failures.
  - 2026-04-14 17:01 UTC run also failed/reopened `binance-prices` at 2026-04-14 17:05:22 UTC with 5 consecutive failures.
- Final `/api/health` check at 2026-04-14 17:10:39 UTC still reported `status: healthy`, no warnings, and `stablecoins` cache age 554s of max 600s.
- Other hard/market price circuits remained closed on the latest checked run:
  - `kraken-prices`: last success 2026-04-14 17:01:46 UTC.
  - `bitstamp-prices`: last success 2026-04-14 17:01:47 UTC.
  - `coinbase-prices`: last success 2026-04-14 17:01:49 UTC.
  - `pyth-prices`: last success 2026-04-14 17:01:46 UTC.
  - `redstone-prices`: last success 2026-04-14 17:01:52 UTC.
  - `curve-onchain`: last success 2026-04-14 17:01:46 UTC.

## Pipeline Impact

- Latest `sync-stablecoins` row checked at 2026-04-14 16:24 UTC:
  - started 2026-04-14 16:16:29 UTC
  - status `ok`
  - `item_count: 401`
  - `cacheWriteSucceeded: true`
  - `payloadAccepted: true`
  - `downstreamSafe: true`
  - `cacheWriteMode: main-write`
  - enrichment: `totalMissing: 61`, `pass1: 1`, `passCmc: 0`, `passJupiter: 0`, `passDex: 7`, `finalMissing: 53`, `failedPasses: []`
  - price validation: `attempted: 399`, `high: 97`, `singleSource: 224`, `cgOnly: 38`, `low: 30`
- Binance was not used in the latest cache (`binanceCount: 0`), but `USDT`/`USDC` still had high-confidence multi-source consensus through CoinGecko, DefiLlama list, Kraken, Bitstamp/Coinbase where available, Pyth, RedStone, Curve/on-chain, and DEX sources.
- Jupiter is fallback-only in this pipeline. It has resolved `0` assets for the recent checked window, including before the breaker opened.
- Latest cache had 54 missing-price rows by direct JSON query, 6 of which listed Solana in the cached chain list.
- Later checked rows continued to complete `ok` and write cache:
  - 2026-04-14 16:31 UTC: 401 assets, cache write succeeded, `binanceCount: 0`, `jupiterCount: 0`, `finalMissing: 60`.
  - 2026-04-14 16:46 UTC: 401 assets, cache write succeeded, `binanceCount: 0`, `jupiterCount: 0`, `finalMissing: 51`.
  - 2026-04-14 17:01 UTC: 401 assets, cache write succeeded, `binanceCount: 0`, `jupiterCount: 0`, `finalMissing: 60`.

## Endpoint Checks

- Binance local checks:
  - `https://data-api.binance.vision/api/v3/ticker/price` returned HTTP 200 and 3,562 ticker rows.
  - `USDTUSD` returned `1.00030000`.
  - `USDCUSD` returned `0.99970000`.
  - `exchangeInfo?symbols=["USDTUSD","USDCUSD"]` returned both symbols as `TRADING`.
  - Official Binance docs list `data-api.binance.vision` as a market-data-only host and include `GET /api/v3/ticker/price` as an allowed endpoint.
- Jupiter local checks:
  - `https://lite-api.jup.ag/price/v3?ids=2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH` returned HTTP 200 with USDG price, liquidity, and block metadata.
  - An invalid/old `price.jup.ag` probe failed DNS locally, but production code uses `lite-api.jup.ag`, not `price.jup.ag`.
  - Jupiter status page reported all services online; `API Gateway Lite` and `Price API V3` were operational.
  - Current Jupiter Price API V3 docs show `https://api.jup.ag/price/v3` with `x-api-key`; status deprecation notice flags old Price API V2 and `price.jup.ag`, not `lite-api.jup.ag/price/v3`.
- `npm run audit:pricing-providers` passed locally during the investigation:
  - Binance: OK (2 checked)
  - Kraken: OK (8 checked)
  - Bitstamp: OK (4 checked)
  - Coinbase: OK (6 checked)
  - RedStone: OK (21 checked)
- A temporary Wrangler tail during the 16:45 UTC run captured `Jupiter circuit open — skipping pass 3`; that run reached the breaker check before the probe was allowed to execute. The 17:01 UTC D1 row confirmed the later Jupiter probe did execute and failed.

## Assessment

- No immediate production user-facing outage was found. `/api/health` stayed healthy, the latest stablecoins cache wrote successfully, and major USDT/USDC pricing still had high-confidence independent consensus without Binance.
- The repeated failed probes make this more than a single transient breaker trip. It removes one hard primary venue (`binance-prices`) and one Solana fallback lane (`jupiter-prices`) from production until the next successful probe.
- The exact Worker-side failure status/body was not persisted in D1, so the investigation cannot distinguish Cloudflare Worker egress/rate/timeout from a transient provider edge issue using historical data alone.
- Both provider endpoints worked from the local environment during the investigation, so there is no evidence of a broad provider outage or an obvious stale URL for the currently configured endpoints.
- Because Kraken, Bitstamp, Coinbase, RedStone, CoinGecko, DefiLlama, Pyth/Curve/DEX paths continued producing usable data, this does not warrant an emergency rollback or manual circuit reset. A reset without fixing the cause would likely just consume another failing probe.

## Recommendation

- Do not manually reset the breakers and do not rollback. Current user-facing health is preserved by redundant pricing sources and successful cache writes.
- Do open follow-up action for observability/resilience:
  - persist per-provider non-OK status/error snippets in cron metadata for CEX/Jupiter fetches;
  - consider a Binance host fallback among official base endpoints if Worker-only failures repeat;
  - plan a Jupiter migration path to the documented `api.jup.ag/price/v3` + API key if Lite gateway reliability or deprecation guidance changes.
- Continue monitoring. If a third public-impact circuit opens before either Binance or Jupiter recovers, `/api/health` will cross the documented degraded threshold and operator action should be escalated.
