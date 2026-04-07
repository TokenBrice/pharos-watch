# Circuit Breaker Investigation — 2026-04-07

## Trigger

Admin status showed two open source breakers:

- `coingecko-ticker`
- `dexscreener-prices`

## Live State Observed

Public health at `https://api.pharos.watch/api/health` was still `healthy`.

Breaker timestamps from live health:

- `coingecko-ticker`
  - `lastSuccessAt`: `1775572284` = `2026-04-07T14:31:24Z`
  - `lastFailureAt/openedAt`: `1775592069` = `2026-04-07T20:01:09Z`
  - `consecutiveFailures`: `11`
- `dexscreener-prices`
  - `lastSuccessAt`: `1775587578` = `2026-04-07T18:46:18Z`
  - `lastFailureAt/openedAt`: `1775592078` = `2026-04-07T20:01:18Z`
  - `consecutiveFailures`: `4`

The `dexscreener-prices` breaker started failing immediately after the `d44141f1` deploy window. `coingecko-ticker` had already been failing earlier.

## Repo/Code Findings

- `d44141f1` refactored `sync-stablecoins` stage composition but did not directly change:
  - `worker/src/lib/cg-ticker.ts`
  - `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts` ticker breaker call
  - `worker/src/cron/sync-stablecoins/enrich-prices-dexscreener-pass.ts`
- `runDexScreenerPass()` only records a breaker failure when all attempted DexScreener requests fail to return an `ok` response.
- Local direct probes from this machine showed both providers healthy:
  - CoinGecko Kinesis ticker endpoints returned `200`
  - DexScreener token and search endpoints returned `200`

## Live Worker Findings

Worker tail showed repeated free-base CoinGecko requests (`api.coingecko.com`) and `401/429` responses from commodity detail pages.

Follow-up investigation showed that was a code-path bug in the public commodity detail route: `handleStablecoinDetail()` did not thread `coingeckoApiKey` into `handleCommodityDetail()`, so commodity fallback history reads always used the free CoinGecko base even when `COINGECKO_API_KEY` was configured.

Live worker logs from those request paths showed repeated CoinGecko failures:

- `401`
- `429`

This is enough to treat the `coingecko-ticker` breaker as a real upstream/credential-pressure issue, not just a status false positive.

## Assessment

### `coingecko-ticker`

The breaker may still reflect genuine upstream/key pressure on the scheduled pricing path, but the free-base CoinGecko logs captured during this investigation were not sufficient evidence on their own because they came from a separate commodity-detail route bug.

Impact:

- isolated source breaker only
- public health remains `healthy`
- not enough by itself to justify rollback

Most appropriate action:

- code: fix commodity detail to propagate `coingeckoApiKey`
- then re-observe breaker state separately on scheduled pricing paths

### `dexscreener-prices`

Status:

- suspicious timing with the recent deploy
- no direct code-path regression found yet
- upstream itself looks healthy from local probes

Most likely buckets still open:

- worker-side network/timeout behavior
- interaction with production runtime conditions rather than a simple logic bug

This does **not** yet justify a blind code change or rollback.

## Recommendation

1. Treat `coingecko-ticker` as actionable infra/config debt: set `COINGECKO_API_KEY` in prod.
2. Do not rollback for these two breakers alone while `/api/health` remains `healthy`.
3. Re-check after the next half-open probe window for both breakers.
4. If `dexscreener-prices` keeps reopening after probe cycles, add targeted telemetry around:
   - per-request DexScreener status codes
   - timeout vs non-OK vs parse-failure counts
   - candidate count / attempt count / successful-call count in cron metadata
