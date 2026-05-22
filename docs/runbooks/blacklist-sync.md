# Runbook: Blacklist Sync

Triggered by `StatusCause.code`:
- `blacklist_gaps_degraded`
- `blacklist_gaps_stale`

## Symptom

The blacklist ingestion pipeline has unresolved gaps in recent blocks. Missing amounts exceed the threshold in `shared/lib/status-thresholds.ts`.

## First checks

1. **Admin page → Debug sync state:** GET `/api/debug-sync-state` (button in Control section). Shows last processed block per chain.
2. **Config-level lag:** compare `config_key` rows, not only chain names. Same-symbol/same-chain deployments can have separate contract/config cursors, and new freeze-ledger snapshots are contract/config scoped.
3. **Stuck chain:** look for a `last_block` that has not advanced for many hours relative to network tip. Remember Tron `last_block` is a millisecond timestamp.
4. **Circuit-open skips:** inspect recent `sync-blacklist` `cron_runs.metadata` for `apiErrorConfigs`, `apiErrorClasses`, budget exhaustion, or circuit-open source skips before resetting cursors.
5. **Upstream RPC health:** if a specific config is stuck, check the relevant provider lane for that chain/config (dRPC/chain RPC/Etherscan/TronGrid).

## Remediation

- **Backfill active balances:** Admin page → Recommended actions or All actions → `Backfill Blacklist Balances` (`POST /api/backfill-blacklist-current-balances`, prefer `?dryRun=true` first) when `blacklist_current_balances` is missing, stale, or provider-failed. Current-balance totals are last-known successful snapshots, so provider failures should preserve the prior value while exposing status/error metadata. This action also re-applies the Tron freeze-ledger mirror so matching Tron event rows can resolve immediately after balance backfill.
- **Debug sync state:** Admin page → Recommended actions or Control section → `Debug sync state` (`GET /api/debug-sync-state`) to inspect chain cursors before moving pointers.
- **Remediate amount gaps:** Admin page → Recommended actions or All actions → `Remediate Blacklist Gaps` (`POST /api/remediate-blacklist-amount-gaps`); run dry-run first when using direct query/body parameters. The default pass targets recoverable amount gaps even when contract/config provenance is already present; set `onlyMissingProvenance=true` only for legacy provenance repair.
- **Circuit-open provider:** if metadata points to an open provider circuit, do not reset sync state first. Confirm the provider is healthy, wait for the circuit probe window, or reset the specific circuit through the existing ops control only when the upstream is confirmed recovered.
- **Reset sync pointer:** Admin page → Recommended actions only when the `sync-blacklist` cron itself is unhealthy, or All actions → `reset-blacklist-sync` after debug-sync-state confirms a stuck pointer. Reverts block pointers backward (EVM: 50,000 blocks; Tron: 604,800,000 ms) to re-process. Idempotent, but not the first response for generic amount gaps.
- **Per-chain investigation:** the sync cron (`sync-blacklist`) logs per-chain outcomes in `cron_runs.metadata`. Inspect recent runs in the admin page's Crons section.

## Prevention

- Missing amounts are resolved via the amount-recovery lane. Persistent gaps indicate an RPC or event-decoding issue upstream, not a sync-pointer problem.
- Fresh Tron-only gaps with a healthy `sync-blacklist` run can be same-cycle ledger-reconciliation lag rather than a stuck cursor. If matching `blacklist_current_balances` rows already exist, prefer balance backfill or the next scheduled run over pointer reset. Missing Tron token balances should remain null/provider-missing until confirmed, not get treated as zero.
- Stale snapshot warnings mean the frozen total is still a last-known successful snapshot, not a live confirmation. Use status/source distributions and `observed_at` age to decide whether to backfill balances, investigate providers, or wait for the next scheduled refresh.
- Only use `reset-blacklist-sync` when debug-sync-state confirms a stuck pointer — not for transient data-quality blips.
