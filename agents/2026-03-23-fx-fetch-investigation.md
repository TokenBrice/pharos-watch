# 2026-03-23 FX Fetch Investigation

## Scope

Investigate `/admin/` reporting `chainlink-feeds` circuit breaker open and determine whether the condition self-corrects or requires action from our side.

## Confirmed facts

- The red admin badge is for `chainlink-feeds`, the breaker used by `sync-fx-rates` for the curated Chainlink FX / commodity overlay.
- The actual failing lane is broader than Chainlink:
  - `sync-fx-rates` is running in `cached-fallback`
  - `fx-frankfurter` is also open
  - public `/api/health` warning is about FX fallback age, not a Chainlink-specific outage
- Last known good live FX run before the prolonged fallback streak:
  - `sync-fx-rates` at `2026-03-23 05:02:22 UTC`
  - metadata: `fallbackMode=secondary-live-fallback`, `chainlink=ok`, `openExchangeRates=ok`
- The quarter-hour lane has scheduler drift:
  - `11:15 UTC` slot materialized late, with `sync-stablecoins` at `11:15:13 UTC`
  - corresponding `sync-fx-rates` ran at `11:18:54 UTC`
  - `11:30 UTC` slot materialized with `sync-stablecoins` at `11:30:14 UTC`
  - corresponding `sync-fx-rates` ran at `11:34:09 UTC`

## Live D1 / health evidence

- `sync-fx-rates` at `2026-03-23 11:18:54 UTC`
  - `status=degraded`
  - `fallbackMode=cached-fx-rates`
  - `consecutiveFallbackRuns=18`
  - `sources.frankfurter=error`
  - `sources.fawazahmed0=error`
  - `sources.exchangeRateApi=unavailable`
  - `sources.chainlink=unavailable`
  - `sources.openExchangeRates=rate-limited`
- `sync-fx-rates` at `2026-03-23 11:34:09 UTC`
  - `status=degraded`
  - `fallbackMode=cached-fx-rates`
  - `consecutiveFallbackRuns=19`
  - same source state as above
- `fx-frankfurter` breaker timeline:
  - open before observation window
  - half-open at `2026-03-23 11:34:10 UTC`
  - reopened at `2026-03-23 11:34:20 UTC`
  - now `open`, `consecutiveFailures=19`
- `chainlink-feeds` breaker:
  - still `open`
  - unchanged during the two observed delayed quarter-hour runs
  - last success remains `2026-03-23 05:02:23 UTC`

## External validation from this machine

- `https://api.frankfurter.app/latest?...` returned `200`
- `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json` returned `200`
- `https://latest.currency-api.pages.dev/v1/currencies/usd.min.json` returned `200`
- `https://open.er-api.com/v6/latest/USD` returned `200`
- Direct RPC checks against the curated Chainlink feeds showed:
  - EUR: fresh
  - GBP: fresh
  - GOLD: fresh
  - SILVER: fresh
  - JPY: stale

## Current read

- This no longer looks like a self-healing upstream outage.
- The worker performed a real post-breaker Frankfurter re-probe at `11:34 UTC` and still failed.
- Because the same endpoints are healthy from outside the worker, the likely failure domain is:
  - Cloudflare Worker egress / transport behavior for this lane
  - provider-side blocking specific to Cloudflare Worker traffic
  - an interaction in our fetch path that is visible only from the worker runtime

## Next debugging steps

1. Capture the exact worker-side fetch error during a live `sync-fx-rates` run.
2. Determine whether failures are transport, DNS/TLS, timeout, or non-2xx response based.
3. If needed, harden `sync-fx-rates` so the tertiary fallback and Chainlink overlay are still attempted even when the primary Frankfurter path fails from the worker environment.
