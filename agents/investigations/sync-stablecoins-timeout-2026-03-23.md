## sync-stablecoins timeout investigation (2026-03-23)

### Production findings

- Latest failing run: `sync-stablecoins` started at `2026-03-22 23:15:21 UTC`, ended at exactly `480000 ms`, and logged `CronTimeoutError: Cron job "sync-stablecoins" timed out after 480s`.
- Previous successful run: `2026-03-22 23:00:23 UTC`, duration `66866 ms`, `status='ok'`, wrote `379` assets.
- During the timed-out run, circuit-state breadcrumbs updated for:
  - `coingecko-mcap` at `23:15:21`
  - primary pricing sources from `23:15:22` to `23:15:32`
  - `dexscreener-prices` at `23:15:33`
- The run never updated:
  - `circuit:defillama-stablecoins` (written only after final cache validation/write)
  - `circuit:geckoterminal-probe`
- `depeg_pending` was not the culprit at investigation time: only `1` pending row remained.

### Root cause

The timeout window narrowed to the gap after `enrichMissingPrices()` and before cache persistence. The most likely blocker was the serialized GeckoTerminal soft-source probe:

- it had no per-run wall-clock budget
- up to `149` tracked assets are probeable on GT-compatible EVM chains
- at current pacing/timeouts, worst-case GT probe runtime could exceed the 8-minute `sync-stablecoins` wrapper budget by a wide margin

This made the quarter-hour sync vulnerable on days when many assets temporarily degraded to soft-source-only pricing.

### Fix applied

- Added `GT_PROBE_RUN_BUDGET_MS = 3 minutes`
- Enforced that budget inside `worker/src/lib/geckoterminal-price-probe.ts`
- When the budget is exhausted, the probe now:
  - stops cleanly instead of hanging until the parent cron timeout
  - records `budgetExhausted` and `budgetSkipped` in GT probe stats/metadata
  - logs a warning for operators
- GT probe candidates are now sorted by descending circulating USD so higher-impact assets are probed first under the capped budget

### Verification

- `npx vitest run worker/src/lib/__tests__/geckoterminal-price-probe.test.ts worker/src/cron/__tests__/sync-stablecoins.test.ts`
- `cd worker && npx tsc --noEmit`
