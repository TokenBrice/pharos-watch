# USDe Exit Liquidity NR Investigation

Date: 2026-04-16

## Summary

USDe still has a standalone DEX liquidity row:

- `liquidityScore`: 59
- `poolCount`: 112
- `chainCount`: 12
- `totalTvlUsd`: $256.6M
- `updatedAt`: 2026-04-16 07:10:04 UTC

The Safety Score `Liquidity / Exit` dimension is `NR` because report cards suppress DEX liquidity when the latest DEX liquidity snapshot is older than two DEX cron intervals. At investigation time, `/api/report-cards` reported:

- `liquidityStale`: true
- `inputFreshness.dexLiquidity.updatedAt`: 2026-04-16 07:10:04 UTC
- `inputFreshness.dexLiquidity.ageSeconds`: ~6033
- `inputFreshness.dexLiquidity.stale`: true

USDe's redemption backstop existed with `score: 71`, but was excluded from Safety Score liquidity because it was low confidence:

- `provider`: `reserve-sync-fallback`
- `sourceMode`: `estimated`
- `capacityConfidence`: `heuristic`
- `modelConfidence`: `low`
- `redemptionUsedForLiquidity`: false

## Production Cron Chain

Relevant `cron_runs` rows:

- 2026-04-16 06:40:04 UTC: `sync-dex-liquidity` `ok`; source-complete; global TVL ~$7.025B.
- 2026-04-16 07:10:04 UTC: `sync-dex-liquidity` `degraded`; `defillama-protocols` unavailable; source-incomplete row persisted with global TVL ~$12.703B.
- 2026-04-16 07:40:04 UTC: `sync-dex-liquidity` `error`; value guard tripped with current ~$7.159B vs persisted previous ~$12.703B.
- 2026-04-16 08:10:04 UTC: `sync-dex-liquidity` `error`; value guard tripped with current ~$6.822B vs persisted previous ~$12.703B.
- 2026-04-16 08:42:34 UTC: Worker deployment `8744a4c1db283e384507d2a68e40da0429c7d76d`.

The 08:42 UTC deployment contains the DEX persistence skip and source-complete baseline fallback logic in `worker/src/cron/dex-liquidity/orchestrator.ts` and `worker/src/cron/dex-liquidity/orchestrator-metadata.ts`.

## Root Cause

The screenshot is a cross-surface freshness mismatch:

1. Standalone DEX liquidity still displays the last successful/degraded DEX row.
2. Report cards use a stricter freshness gate and suppress stale DEX rows after one hour.
3. The stale condition was caused by two failed post-incident DEX scoring runs.
4. Those failures were caused by the value coverage guard comparing recovered normal capped TVL against an inflated source-incomplete baseline written when DefiLlama Protocols was unavailable.

## Additional USDe-Specific Context

The Ethena live reserve sync is also failing:

- `reserve_sync_state.last_status`: `error`
- `last_success_at`: 2026-04-15 23:11:11 UTC
- `last_attempted_at`: 2026-04-16 08:11:08 UTC
- latest error: Ethena collateral API returned HTML (`text/html`) where JSON was expected.

This causes USDe redemption capacity to fall back to the configured 0.5% heuristic, which is intentionally low confidence and does not replace stale/missing DEX liquidity in Safety Score liquidity.

## Verification

Targeted tests passed:

```bash
npm test -- worker/src/cron/__tests__/sync-dex-liquidity.test.ts worker/src/cron/dex-liquidity/__tests__/orchestrator-metadata.test.ts
```

Result: 2 test files passed, 18 tests passed.
