# D1 Migrations Manifest

## Baseline (0000)

`0000_baseline.sql` consolidates migrations 0001–0071 into a single schema creation script.

- **Applied only to fresh databases.** Existing databases continue from their last-applied migration and will never execute the baseline.
- D1's migration runner tracks applied migrations by filename in its internal ledger, so existing databases that have already applied 0001–0071 will correctly skip 0000.
- Fresh databases apply the baseline then the individual migrations from 0072 onward.

**Squash date:** 2026-03-25 (S-014)

## Individual Migrations (0072–0087)

Applied sequentially after the baseline (fresh setup) or after the previous individual migration (existing databases).

| Sequence | Filename                                        | Description                                                                                     |
| -------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 0072     | `0072_telegram_launch_alerts.sql`               | Add launch alert flags to telegram subscribers and subscriptions                                |
| 0073     | `0073_price_cache_provenance.sql`               | Add price-cache provenance and timestamp metadata columns                                        |
| 0074     | `0074_cron_slot_executions.sql`                 | Add durable scheduled-slot execution fencing and slot timestamps to cron history/progress        |
| 0075     | `0075_price_cache_observed_at_mode.sql`         | Add price-cache observation-mode metadata column                                                |
| 0076     | `0076_blacklist_provenance_and_amount_semantics.sql` | Add blacklist provenance and amount-semantics metadata                                     |
| 0077     | `0077_blacklist_amount_recovery_telemetry.sql`  | Add blacklist amount-recovery telemetry columns                                                |
| 0078     | `0078_feedback_submissions.sql`                 | Create feedback_submissions table for durable feedback logging                                 |
| 0079     | `0079_reset_paxg_pyusd_destroy_zero_amounts.sql`| Reset PAXG/PYUSD destroy zero amounts for re-fetch                                             |
| 0080     | `0080_live_reserve_attempt_fencing.sql`         | Add live-reserve attempt IDs and authoritative fencing columns                                 |
| 0081     | `0081_blacklist_current_balances.sql`           | Add active blacklist current-balance cache table and reset legacy Tron derived event amounts   |
| 0082     | `0082_api_request_source_stats.sql`             | Add minute-bucketed public API request-source attribution telemetry                            |
| 0083     | `0083_api_keys.sql`                             | Add API key metadata table with prefix + secret-hash storage                                   |
| 0084     | `0084_api_key_rate_limit.sql`                   | Add per-key minute-bucket rate-limit table                                                     |
| 0085     | `0085_total_request_attribution.sql`            | Add total site-vs-external attribution tables and explicit API key traffic classification      |
| 0086     | `0086_treasury_stable_exposure_history.sql`     | Add daily treasury stable exposure history table for per-entity snapshot auditing              |
| 0087     | `0087_api_key_expiry.sql`                       | Add nullable API key expiry timestamps for default-expiring and explicit non-expiring keys     |
| 0088     | `0088_api_key_audit_log.sql`                    | Add API key audit log table for tracking create/update/deactivate/rotate mutations             |
| 0089     | `0089_api_key_pepper_version.sql`               | Add pepper_version column to api_keys for tracking which pepper generation hashed the secret   |

## Known Anomalies

- Duplicate-prefix allowlist: `0056`, `0061`
- These legacy duplicates existed in the squashed range (0001–0071) and are preserved here for reference. The allowlist is frozen and must not expand.

## Rollout Safety

- Rollout-safety enforcement starts at: `0071`
- Required rollout-safety header: `-- rollout-safety: backward-compatible`
- Standard production deploy applies D1 migrations before the new Worker is live, so every new migration from `0071` onward must keep the previous production Worker running until deploy completes.
- `backward-compatible` means additive or compatibility-preserving changes only. Do not drop or rename tables/columns in the default deploy path.
- Destructive cleanup must be scheduled as a separate, coordinated rollout after the old Worker code is no longer serving traffic. Do not merge those cleanup migrations into the normal deploy path without an explicit runbook/workflow change.

## Rollback Procedure

If a migration corrupts data:

1. **Get bookmark:** `cd worker && npx wrangler d1 time-travel info stablecoin-db --remote`
2. **Restore:** `cd worker && npx wrangler d1 time-travel restore stablecoin-db --bookmark=<BOOKMARK> --remote`
3. **Remove bad migration** from `worker/migrations/` directory
4. **Re-apply remaining:** `cd worker && npx wrangler d1 migrations apply stablecoin-db --remote`
5. **Redeploy worker:** `cd worker && npx wrangler deploy`

Cloudflare D1 Time Travel retention is account-plan dependent. Verify the current retention window in Cloudflare before relying on a rollback bookmark.
