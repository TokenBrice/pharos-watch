# 2026-04-21 Admin Blacklist Degradation Investigation

## Summary

`/admin/` is currently `degraded`, but the live evidence shows this is not a true blacklist-sync outage. Public health is `healthy`; the blacklist cron is healthy; the degraded admin state is being driven by 10 recent Tron USDT blacklist rows that still have `amount_status='recoverable_pending'` even though matching `blacklist_current_balances` rows already exist.

## Live findings

- `status_state` is `current_status='degraded'`, `raw_status='degraded'`, last changed at `2026-04-21 12:25:05 UTC`.
- The persisted causes are:
  - `blacklist_gaps_degraded` with `ratio=0.06%`, `recent=10`
  - `degraded_cron_warning` for one warning-only degraded cron
- Public `/api/health` is `healthy` with the same blacklist counters visible:
  - `missingAmounts=10`
  - `recentMissingAmounts=10`
  - `missingRatio=0.0005879240402140043`
- The latest `sync-blacklist` run is healthy:
  - started at `2026-04-21 18:03:53 UTC`
  - status `ok`
  - `apiErrors=0`
  - `contractsSkipped=0`
  - `budgetUsed=600/900`
- All unresolved blacklist gaps are the same bucket:
  - stablecoin `USDT`
  - chain `tron`
  - `amount_status='recoverable_pending'`
  - count `10`
  - all are recent (`2026-04-21 13:17:30 UTC` through `2026-04-21 15:45:30 UTC`)
- Every one of those 10 rows already has a matching `blacklist_current_balances` row with a resolved amount observed at `2026-04-21 18:08:06 UTC`.

## Root cause

The Tron ledger reconciliation runs too early in the blacklist sync flow.

Current order in `sync-blacklist`:

1. `backfillTronFromLedger()` runs at the start of the cron.
2. New Tron blacklist rows are fetched and inserted.
3. `syncCurrentBalanceCacheForRows()` writes matching `blacklist_current_balances` rows.
4. The cron ends without re-running the Tron ledger mirror.

Effect: newly ingested Tron rows can remain `recoverable_pending` until the next 6-hour cron cycle, even though their current-balance snapshot already exists a few minutes later.

## Assessment

- Is the admin overly dramatic?
  - Yes for this case. The page-level `degraded` badge and promoted-action framing read like an active incident, but the live evidence shows a reconciliation lag in an admin-only metric.
- Is it reasonable to report degraded on such a case?
  - Only narrowly. The metric crossed an intentional admin data-quality threshold (`recentMissingAmounts >= 5`), so the code is behaving as designed. But the operational impact is low because public health is unaffected and the underlying data needed to resolve the rows is already present.
- Is there really a blacklist sync issue?
  - Not in the “sync is failing / cursor is stuck / cron is broken” sense. The real issue is ordering inside the Tron amount-reconciliation path, not event ingestion failure.
- Anything else relevant?
  - The recommended action mapping is misleading for this scenario. `blacklist_gaps_*` currently promotes `reset-blacklist-sync`, but the runbook says resets are only for stuck cursors. That advice is too aggressive for a ledger-reconciliation lag.

## Fix direction

1. Re-run `backfillTronFromLedger()` after current-balance cache writes in `sync-blacklist`.
2. Make the admin balance-backfill route reapply the same ledger reconciliation so operators have a non-destructive immediate remedy.
3. Stop auto-promoting `reset-blacklist-sync` for generic blacklist-gap warnings; prefer balance backfill, sync-state inspection, and targeted remediation.
