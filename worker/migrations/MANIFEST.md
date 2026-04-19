# D1 Migrations Manifest

## Baseline (0000)

`0000_baseline.sql` consolidates migrations 0001–0071 into a single schema creation script.

- **Applied only to fresh databases.** Existing databases continue from their last-applied migration and will never execute the baseline.
- D1's migration runner tracks applied migrations by filename in its internal ledger, so existing databases that have already applied 0001–0071 will correctly skip 0000.
- Fresh databases apply the baseline then the individual migrations from 0072 onward.

**Squash date:** 2026-03-25 (S-014)

## Individual Migrations (current active files)

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
| 0087     | `0087_api_key_expiry.sql`                       | Add nullable API key expiry timestamps for default-expiring and explicit non-expiring keys     |
| 0088     | `0088_api_key_audit_log.sql`                    | Add API key audit log table for tracking create/update/deactivate/rotate mutations             |
| 0089     | `0089_api_key_pepper_version.sql`               | Add pepper_version column to api_keys for tracking which pepper generation hashed the secret   |
| 0090     | `0090_api_key_request_stats.sql`                | Add retained minute-bucketed per-key request telemetry for admin load reporting                |
| 0091     | `0091_depeg_pending_state_tracking.sql`         | Add rolling last-seen/peak tracking fields to depeg_pending for refreshable pending incidents  |
| 0092     | `0092_mint_burn_run_state_last_config_key.sql`  | Add last processed mint/burn config key to run state for deterministic resume bookkeeping      |
| 0093     | `0093_cleanup_legacy_mint_burn_sync_keys.sql`   | Remove legacy colon-delimited mint/burn sync-state keys after canonical key migration          |
| 0094     | `0094_redemption_backstop_runs.sql`             | Add redemption backstop snapshot run manifest and row generation identifiers                   |
| 0095     | `0095_blacklist_event_suppression.sql`          | Add blacklist event suppression metadata and clean zero-balance EURC mirror ledger rows        |
| 0096     | `0096_mint_burn_config_deferral.sql`            | Add mint/burn config deferral table to skip chronically failing configs for a 1h grace period  |
| 0097     | `0097_mbe_flow_type_ts_index.sql`               | Add (flow_type, timestamp DESC) composite index to speed the atomic-roundtrip sweep query      |
| 0098     | `0098_telegram_alert_snooze.sql`                | Add `alert_snooze_until_ts` to `telegram_subscribers` for per-chat temporary snooze from inline buttons |
| 0099     | `0099_admin_action_audit_log.sql`               | Add admin action audit log table for tracking operator mutations                               |
| 0100     | `0100_blacklist_sync_state_dedup.sql`           | Delete legacy mixed-case `blacklist_sync_state` rows (keeps lowercase canonical keys)          |
| 0101     | `0101_blacklist_reset_derived_amounts.sql`      | Reset 7,198 pre-v3.2 `derived` rows into the backfill pool for proper re-attribution           |
| 0102     | `0102_blacklist_gnosis_cursor_reseed.sql`       | Reseed Gnosis BRZ cursor to startBlock-1 so next sync picks up previously-missed events        |
| 0103     | `0103_blacklist_backfill_indexes.sql`           | Composite indexes for blacklist backfill + public API query paths                              |
| 0104     | `0104_blacklist_mirror_zero_permanently_unavailable.sql` | Stamp EURC mirror-zero rows as permanently_unavailable to exit backfill pool         |
| 0105     | `0105_depeg_event_provenance.sql`               | Add `confirmation_sources` + `pending_reason` nullable TEXT columns to `depeg_events` for post-promotion provenance              |

## Retired Individual Migrations

| Sequence | Former Filename                                | Retirement Note                                                                                                                                 |
| -------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 0086     | `0086_treasury_stable_exposure_history.sql`    | Retired on 2026-04-08 after the treasuries feature removal maintenance window dropped the unused history table and indexes from production D1. |

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
5. **Redeploy worker:** use the standard production deploy workflow, or manually run the equivalent Worker Versions sequence (`cd worker && npx wrangler versions upload`, smoke the preview URL, `npx wrangler versions deploy <VERSION_ID>@100`, then `npx wrangler triggers deploy`). `wrangler deploy` bypasses the preview-smoke/promotion flow and should be treated as an emergency shortcut only.

Cloudflare D1 Time Travel retention is account-plan dependent. Verify the current retention window in Cloudflare before relying on a rollback bookmark.
