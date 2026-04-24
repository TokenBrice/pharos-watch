# Runbook: Blacklist Sync

Triggered by `StatusCause.code`:
- `blacklist_gaps_degraded`
- `blacklist_gaps_stale`

## Symptom

The blacklist ingestion pipeline has unresolved gaps in recent blocks. Missing amounts exceed the threshold in `shared/lib/status-thresholds.ts`.

## First checks

1. **Admin page → Debug sync state:** GET `/api/admin/debug-sync-state` (button in Control section). Shows last processed block per chain.
2. **Stuck chain:** look for a `last_block` that has not advanced for many hours relative to network tip.
3. **Upstream RPC health:** if a specific chain is stuck, check dedicated RPC endpoints for that chain.

## Remediation

- **Backfill active balances:** Admin page → Recommended actions or All actions → `Backfill Blacklist Balances` (`POST /api/backfill-blacklist-current-balances`, prefer `?dryRun=true` first) when `blacklist_current_balances` is missing or stale. This now also re-applies the Tron freeze-ledger mirror so matching Tron event rows can resolve immediately after balance backfill.
- **Debug sync state:** Admin page → Recommended actions or Control section → `Debug sync state` (`GET /api/admin/debug-sync-state`) to inspect chain cursors before moving pointers.
- **Remediate amount gaps:** Admin page → Recommended actions or All actions → `Remediate Blacklist Gaps` (`POST /api/remediate-blacklist-amount-gaps`); run dry-run first when using direct query/body parameters.
- **Reset sync pointer:** Admin page → Recommended actions only when the `sync-blacklist` cron itself is unhealthy, or All actions → `reset-blacklist-sync` after debug-sync-state confirms a stuck pointer. Reverts block pointers backward (EVM: 50,000 blocks; Tron: 604,800,000 ms) to re-process. Idempotent, but not the first response for generic amount gaps.
- **Per-chain investigation:** the sync cron (`sync-blacklist`) logs per-chain outcomes in `cron_runs.metadata`. Inspect recent runs in the admin page's Crons section.

## Prevention

- Missing amounts are resolved via the amount-recovery lane. Persistent gaps indicate an RPC or event-decoding issue upstream, not a sync-pointer problem.
- Fresh Tron-only gaps with a healthy `sync-blacklist` run can be same-cycle ledger-reconciliation lag rather than a stuck cursor. If matching `blacklist_current_balances` rows already exist, prefer balance backfill or the next scheduled run over pointer reset.
- Only use `reset-blacklist-sync` when debug-sync-state confirms a stuck pointer — not for transient data-quality blips.
