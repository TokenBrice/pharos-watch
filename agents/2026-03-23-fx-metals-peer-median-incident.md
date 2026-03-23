# 2026-03-23 FX Metals Freshness Incident

## Symptom

- Public `/api/health` stayed `degraded` after fiat FX recovery.
- Remaining warning was `fx-rates: peggedGOLD intraday reference is 12h old`.
- `fx-rates-meta` showed fresh fiat provenance but stale `peggedGOLD` / `peggedSILVER` `sourceUpdatedAtByPeg`.

## Production Evidence

- `gold-api.com` was healthy from local probes, but production `sync-fx-rates` metadata kept writing `"gold-api.com": "cached"`.
- The worker therefore kept inheriting previous commodity timestamps even when the overall FX run returned `mode: "live"`.
- Chainlink overlays were also unavailable in the affected runs, so metals had no live recovery path once the anonymous gold-api fetches stopped succeeding from Workers.

## Root Cause

- `sync-fx-rates` treated `gold-api.com` as the only live commodity reference source.
- When those anonymous Worker fetches failed or validated empty, the code fell straight back to previous cached metal rates.
- That preserved stale `sourceUpdatedAtByPeg` for `peggedGOLD` / `peggedSILVER`, which kept `/api/health` degraded even though the quarter-hourly stablecoins cache already contained fresh commodity token prices.

## Fix

- `worker/src/cron/sync-fx-rates.ts` now loads the fresh `stablecoins` cache and derives commodity peer-median reference rates via `@shared/lib/peg-rates`.
- If `gold-api.com` cannot refresh gold or silver, the cron promotes the fresh stablecoins-derived commodity reference before inheriting previous cached metal values.
- The recovered metal pegs are marked `live` with fresh intraday `sourceUpdatedAtByPeg` based on the `stablecoins` cache write timestamp.
- Cron metadata now distinguishes `"gold-api.com"` from `"commodity-peer-median"` so operators can see which recovery path kept metals fresh.

## Validation

- `npm test -- worker/src/cron/__tests__/sync-fx-rates.test.ts`
- `cd worker && npx tsc --noEmit`
- `npm run lint`
- `npm run build`

## Docs Updated

- `docs/pricing-pipeline.md`
- `docs/data-pipeline.md`
- `docs/status-dashboard.md`
