# Yield Sync Investigation — 2026-03-23

## Summary

- The current `sync-yield-data` `degraded` state is expected from code and is driven by the retained `risk_free_rate` fallback cache, not by the two persistent on-chain source misses.
- Live D1 confirms the benchmark cache currently stores:
  - `rate: 3.74`
  - `recordDate: 2026-03-20`
  - `source: treasury-yield-xml`
  - `isFallback: true`
  - `fallbackMode: "all-sources-failed-retained"`
- `sync-yield-data` marks the run degraded whenever `shouldDegradeForRiskFreeRate()` returns true. Any retained benchmark fallback keeps that condition true.

## Code Path

- `worker/src/cron/sync-yield-data.ts`
  - Adds `risk-free-rate:${riskFreeRateMeta.fallbackMode}` to `degradationReasons` when `shouldDegradeForRiskFreeRate(riskFreeRateMeta)` is true.
- `worker/src/cron/yield-sync/evaluation.ts`
  - `shouldDegradeForRiskFreeRate()` returns true for any non-null `fallbackMode`.
- `worker/src/cron/fetch-tbill-rate.ts`
  - On total upstream failure, `handleDegradedFallback()` retains the last known good rate and writes `isFallback: true`, `fallbackMode: "all-sources-failed-retained"`.

## Live Evidence

## Benchmark job

- Last successful `fetch-tbill-rate`: `2026-03-21 08:00:08 UTC`
- Latest `fetch-tbill-rate` run: `2026-03-22 08:00:18 UTC`
  - `status: degraded`
  - metadata fallback: `"all-sources-failed-retained"`
  - retained rate: `3.74`
  - retained record date: `2026-03-20`

## Yield job

- Last successful `sync-yield-data`: `2026-03-22 07:45:04 UTC`
- Latest sampled `sync-yield-data`: `2026-03-22 23:13:49 UTC`
  - `status: degraded`
  - metadata fallback: `"risk-free-rate:all-sources-failed-retained"`

## On-chain source status

- The stable `onChainFailures: { "null": 2 }` is real but not the trigger for the degraded card.
- Comparing the 13 configured deterministic vaults with live `yield_data` shows the persistent missing pair is:
  - `dusd-dtrinity`
  - `reusd-re-protocol`
- Direct public Ethereum RPC reproduction:
  - `dusd-dtrinity` `convertToAssets(1e18)` returns `execution reverted`
  - `reusd-re-protocol` `convertToAssets(1e18)` returns empty `0x`
- Successful controls:
  - `usds-sky` returns a normal hex value
  - `dai-makerdao` returns a normal hex value

## Transient issue seen in history

- Between `2026-03-22 20:14:18 UTC` and `2026-03-22 21:43:51 UTC`, yield-sync dropped from `11/13` on-chain resolutions to `0/13`.
- During that window runtime grew to about `54s` and rows written dropped from `96` to `84-85`.
- Later runs recovered to `11/13`, so this looks like a temporary RPC/path outage, separate from the ongoing benchmark fallback state.

## Network spot-checks

- Treasury XML endpoint currently responds `200`.
- FRED CSV currently times out from this environment after `10s`.
- This matches the historical pattern where Treasury often rescues the daily job after FRED failure, except on `2026-03-22 08:00 UTC` when both sources failed and the last good value was retained.

## Operational next steps

1. Watch the next `fetch-tbill-rate` run. If it succeeds, `sync-yield-data` should clear from degraded on its next 30-minute cycle.
2. If `fetch-tbill-rate` fails again, capture live worker logs for that run to distinguish Treasury transport failure vs response-shape drift.
3. Separately review `dusd-dtrinity` and `reusd-re-protocol` deterministic configs. Their contracts do not currently return a usable `convertToAssets(1e18)` result, so these should either move to a protocol-specific reader or be removed from `ON_CHAIN_RATE_CONFIGS`.
