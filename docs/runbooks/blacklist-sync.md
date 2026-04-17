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

- **Reset sync pointer:** Admin page → Recommended actions → `reset-blacklist-sync`. Reverts block pointers backward (EVM: 50,000 blocks; Tron: 604,800,000 ms) to re-process. Idempotent — safe to re-run.
- **Per-chain investigation:** the sync cron (`sync-blacklist`) logs per-chain outcomes in `cron_runs.metadata`. Inspect recent runs in the admin page's Crons section.

## Prevention

- Missing amounts are resolved via the amount-recovery lane. Persistent gaps indicate an RPC or event-decoding issue upstream, not a sync-pointer problem.
- Only use `reset-blacklist-sync` when debug-sync-state confirms a stuck pointer — not for transient data-quality blips.
