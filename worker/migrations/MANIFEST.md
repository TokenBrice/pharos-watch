# D1 Migrations Manifest

## Baseline (0000)

`0000_baseline.sql` consolidates migrations 0001–0071 into a single schema creation script.

- **Applied only to fresh databases.** Existing databases continue from their last-applied migration and will never execute the baseline.
- D1's migration runner tracks applied migrations by filename in its internal ledger, so existing databases that have already applied 0001–0071 will correctly skip 0000.
- Fresh databases apply the baseline then the individual migrations from 0072 onward.

**Squash date:** 2026-03-25 (S-014)

## Individual Migrations (current active files)

Applied sequentially after the baseline (fresh setup) or after the previous individual migration (existing databases).

| Sequence | Filename                                                 | Description                                                                                                                                     |
| -------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 0072     | `0072_telegram_launch_alerts.sql`                        | Add launch alert flags to telegram subscribers and subscriptions                                                                                |
| 0073     | `0073_price_cache_provenance.sql`                        | Add price-cache provenance and timestamp metadata columns                                                                                       |
| 0074     | `0074_cron_slot_executions.sql`                          | Add durable scheduled-slot execution fencing and slot timestamps to cron history/progress                                                       |
| 0075     | `0075_price_cache_observed_at_mode.sql`                  | Add price-cache observation-mode metadata column                                                                                                |
| 0076     | `0076_blacklist_provenance_and_amount_semantics.sql`     | Add blacklist provenance and amount-semantics metadata                                                                                          |
| 0077     | `0077_blacklist_amount_recovery_telemetry.sql`           | Add blacklist amount-recovery telemetry columns                                                                                                 |
| 0078     | `0078_feedback_submissions.sql`                          | Create feedback_submissions table for durable feedback logging                                                                                  |
| 0079     | `0079_reset_paxg_pyusd_destroy_zero_amounts.sql`         | Reset PAXG/PYUSD destroy zero amounts for re-fetch                                                                                              |
| 0080     | `0080_live_reserve_attempt_fencing.sql`                  | Add live-reserve attempt IDs and authoritative fencing columns                                                                                  |
| 0081     | `0081_blacklist_current_balances.sql`                    | Add active blacklist current-balance cache table and reset legacy Tron derived event amounts                                                    |
| 0082     | `0082_api_request_source_stats.sql`                      | Add minute-bucketed public API request-source attribution telemetry                                                                             |
| 0083     | `0083_api_keys.sql`                                      | Add API key metadata table with prefix + secret-hash storage                                                                                    |
| 0084     | `0084_api_key_rate_limit.sql`                            | Add per-key minute-bucket rate-limit table                                                                                                      |
| 0085     | `0085_total_request_attribution.sql`                     | Add total site-vs-external attribution tables and explicit API key traffic classification                                                       |
| 0087     | `0087_api_key_expiry.sql`                                | Add nullable API key expiry timestamps for default-expiring and explicit non-expiring keys                                                      |
| 0088     | `0088_api_key_audit_log.sql`                             | Add API key audit log table for tracking create/update/deactivate/rotate mutations                                                              |
| 0089     | `0089_api_key_pepper_version.sql`                        | Add pepper_version column to api_keys for tracking which pepper generation hashed the secret                                                    |
| 0090     | `0090_api_key_request_stats.sql`                         | Add retained minute-bucketed per-key request telemetry for admin load reporting                                                                 |
| 0091     | `0091_depeg_pending_state_tracking.sql`                  | Add rolling last-seen/peak tracking fields to depeg_pending for refreshable pending incidents                                                   |
| 0092     | `0092_mint_burn_run_state_last_config_key.sql`           | Add last processed mint/burn config key to run state for deterministic resume bookkeeping                                                       |
| 0093     | `0093_cleanup_legacy_mint_burn_sync_keys.sql`            | Remove legacy colon-delimited mint/burn sync-state keys after canonical key migration                                                           |
| 0094     | `0094_redemption_backstop_runs.sql`                      | Add redemption backstop snapshot run manifest and row generation identifiers                                                                    |
| 0095     | `0095_blacklist_event_suppression.sql`                   | Add blacklist event suppression metadata and clean zero-balance EURC mirror ledger rows                                                         |
| 0096     | `0096_mint_burn_config_deferral.sql`                     | Add mint/burn config deferral table to skip chronically failing configs for a 1h grace period                                                   |
| 0097     | `0097_mbe_flow_type_ts_index.sql`                        | Add (flow_type, timestamp DESC) composite index to speed the atomic-roundtrip sweep query                                                       |
| 0098     | `0098_telegram_alert_snooze.sql`                         | Add `alert_snooze_until_ts` to `telegram_subscribers` for per-chat temporary snooze from inline buttons                                         |
| 0099     | `0099_admin_action_audit_log.sql`                        | Add admin action audit log table for tracking operator mutations                                                                                |
| 0100     | `0100_blacklist_sync_state_dedup.sql`                    | Delete legacy mixed-case `blacklist_sync_state` rows (keeps lowercase canonical keys)                                                           |
| 0101     | `0101_blacklist_reset_derived_amounts.sql`               | Reset 7,198 pre-v3.2 `derived` rows into the backfill pool for proper re-attribution                                                            |
| 0102     | `0102_blacklist_gnosis_cursor_reseed.sql`                | Reseed Gnosis BRZ cursor to startBlock-1 so next sync picks up previously-missed events                                                         |
| 0103     | `0103_blacklist_backfill_indexes.sql`                    | Composite indexes for blacklist backfill + public API query paths                                                                               |
| 0104     | `0104_blacklist_mirror_zero_permanently_unavailable.sql` | Stamp EURC mirror-zero rows as permanently_unavailable to exit backfill pool                                                                    |
| 0105     | `0105_depeg_event_provenance.sql`                        | Add `confirmation_sources` + `pending_reason` nullable TEXT columns to `depeg_events` for post-promotion provenance                             |
| 0106     | `0106_mbe_counted_coin_chain_index.sql`                  | Add partial counted-flow index for mint/burn event totals and page reads                                                                        |
| 0107     | `0107_telegram_pending_initiator.sql`                    | Add nullable `initiator_user_id` to Telegram pending disambiguation state for group-chat ownership checks                                       |
| 0108     | `0108_blacklist_current_balance_identity.sql`            | Add blacklist current-balance identity and status metadata for scoped address snapshots                                                         |
| 0109     | `0109_telegram_global_depeg_step.sql`                    | Add optional global Telegram depeg worsening threshold for all-stablecoin follows                                                               |
| 0110     | `0110_api_key_self_serve.sql`                            | Add email-verified self-serve API key request metadata, request throttles, and per-email claims                                                 |
| 0111     | `0111_telegram_pending_alert_retry_metadata.sql`         | Add retry deferral, error, dedupe, and chunk metadata to Telegram pending alerts                                                                |
| 0112     | `0112_api_key_self_serve_hardening.sql`                  | Expand self-serve limiter scopes, add unique integrity indexes, and record self-serve revocations                                               |
| 0113     | `0113_api_key_self_serve_issuance_fencing.sql`           | Add self-serve issuance lock metadata and fixed-window issuance caps                                                                            |
| 0114     | `0114_telegram_dynamic_presets.sql`                      | Add persistent Telegram preset subscriptions for dynamic stablecoin cohorts                                                                     |
| 0115     | `0115_live_reserve_history_attempt_idempotency.sql`      | Add partial unique indexes for idempotent live-reserve history writes by non-null attempt ID                                                    |
| 0116     | `0116_telegram_subscriber_block_count.sql`               | Add consecutive-block counter and first-strike timestamp to gate Telegram 403 cascade behind a two-strike-within-24h rule                       |
| 0117     | `0117_telegram_global_alert_indexes.sql`                 | Partial indexes on `telegram_subscribers.global_alert_*` flags plus `telegram_pending_alerts(chat_id)` for dispatcher fan-out and drain JOIN    |
| 0118     | `0118_telegram_subscriber_timezone.sql`                  | Add nullable `timezone` IANA zone to `telegram_subscribers` for resolving quiet hours locally (NULL = UTC)                                      |
| 0119     | `0119_telegram_subscription_snooze.sql`                  | Add `alert_snooze_until_ts` to `telegram_subscriptions` so per-coin snooze can suppress fan-out for a single coin without muting the whole chat |
| 0120     | `0120_redemption_backstop_run_rows.sql`                  | Add immutable per-run redemption backstop rows so completed snapshots survive later failed mirror writes                                        |
| 0121     | `0121_telegram_alert_jobs.sql`                           | Add Telegram pending-delivery priority/expiry metadata, dead-letter audit rows, and durable alert job/target manifests                         |
| 0122     | `0122_telegram_processed_updates.sql`                    | Add retry-safe Telegram webhook update claims for idempotent command processing                                                                 |
| 0123     | `0123_telegram_usage_analytics.sql`                      | Add privacy-preserving Telegram usage aggregates, watcher lifecycle snapshots, and chat delivery diagnostics                                    |
| 0124     | `0124_telegram_delivery_claims_and_retention.sql`        | Add Telegram pending-delivery claim metadata and retention/reconciliation indexes                                                               |
| 0125     | `0125_yield_publication_generations.sql`                 | Add yield publication generation state, row generation markers, and compact selected-source decision evidence                                   |
| 0126     | `0126_depeg_pending_lifecycle_outcomes.sql`              | Add durable pending-depeg lifecycle outcome rows for promoted, rejected, expired, recovered, and superseded candidates                          |
| 0127     | `0127_depeg_event_provenance_side_table.sql`             | Add side-table depeg event provenance and a JSON-projection view for historical/live event audit metadata                                       |
| 0128     | `0128_depeg_backfill_runs.sql`                           | Add durable depeg backfill run manifests with status, counts, and replay fingerprints                                                           |
| 0129     | `0129_tape_events.sql`                                   | Add materialized `tape_events` stream projected from existing producer tables, idempotent on `(source_table, source_row_id, transition)`         |
| 0130     | `0130_public_snapshots.sql`                              | Add `public_snapshots` table holding daily gzipped JSON payloads for `/api/snapshots/<date>.json` and `/api/snapshot/<date>/stablecoin/<id>`     |
| 0131     | `0131_usg_tangent_inception_supply_repair.sql`           | Repair Tangent USG early `supply_history` rows so the on-chain-circulating exclusion applies from first tracked chart day                        |
| 0132     | `0132_yield_history_pys_snapshot.sql`                    | Add `pys_at_publish`, `safety_at_publish`, `variance_at_publish` snapshot columns to `yield_history` for honest reconstruction                  |
| 0133     | `0133_yield_decision_alternatives.sql`                   | Add sibling `yield_source_decision_alternatives` table for the bounded, public-safe retained alternates surfaced on `/api/yield-rankings`        |
| 0134     | `0134_yield_decision_retention_reason.sql`               | Add nullable `retention_reason` column to `yield_source_decisions` for per-row trend/audit classification and selective pruning                   |
| 0135     | `0135_depeg_resolver_assessments.sql`                    | Add durable DDR assessment checkpoints for reviewer comparisons against later depeg outcomes                                                     |
| 0136     | `0136_depeg_resolver_incident_storage.sql`               | Add DDRv2 canonical incident identity, event links, lineage, policy membership snapshots, and repair authorization ledgers                       |
| 0137     | `0137_depeg_resolver_public_prediction_storage.sql`      | Add DDRv2 public_prediction assessment guards, sealed public prediction/no-call storage, and durable lock state/audit tables                     |
| 0138     | `0138_depeg_resolver_prediction_errata.sql`              | Add DDRv2 append-only prediction errata ledger with replacement-evidence guards                                                                  |
| 0139     | `0139_depeg_resolver_repair_guards.sql`                  | Add DDRv2 repair authorization guards for sealed incident relinks, event identity changes, deletes, and provenance invalidations                 |
| 0140     | `0140_depeg_resolver_publication_snapshots.sql`          | Add DDRv2 append-only public publication snapshot manifests, row membership, finalization, and snapshot errata storage                           |
| 0141     | `0141_depeg_resolver_public_prediction_guard_split.sql`  | Split the DDRv2 public-prediction assessment guard into smaller D1-compatible triggers                                                           |
| 0142     | `0142_depeg_resolver_usdxl_prelock_repair.sql`           | Adopt unsealed USDXL May 2026 pre-lock source rows into their canonical DDRv2 incident through append-only links/revisions                       |
| 0143     | `0143_depeg_resolver_readiness_lock_policy.sql`          | Add nullable DDR readiness/backstop lock metadata columns and public-prediction guard checks                                                     |
| 0144     | `0144_worker_hot_query_indexes_and_stress_latest.sql`    | Add stress-signals latest-row materialization plus hot-query indexes for mint/burn, yield, and depeg Worker paths                                |
| 0145     | `0145_apxusd_depeg_reopen_repair.sql`                    | Reopen the APXUSD live depeg row closed by a bad near-peg soft consensus while high-TVL DEX evidence still showed the depeg                      |
| 0146     | `0146_apxusd_ddrr_snapshot_repair.sql`                   | Reapply the guarded APXUSD reopen repair and invalidate the stale DDRR cache row that scored the still-open incident as recovered                 |
| 0147     | `0147_apxusd_ddr_sealed_reopen_link.sql`                 | Link the APXUSD sealed DDR reopen event to the canonical incident through authorized append-only repair records                                  |
| 0148     | `0148_usda_ddr_sealed_reopen_link.sql`                   | Link the USDA sealed DDR reopen event to the canonical incident through authorized append-only repair records                                    |
| 0149     | `0149_usdxl_ddr_sealed_tail_link.sql`                    | Link the latest USDXL sealed DDR tail events and advance the canonical incident through authorized append-only repair records                    |
| 0150     | `0150_usdxl_ddr_tail_90095_link.sql`                     | Link USDXL sealed DDR tail event 90095 and advance the canonical incident through authorized append-only repair records                          |
| 0151     | `0151_cron_runs_ok_started_index.sql`                    | Add a partial cron_runs(job, started_at DESC) index for latest successful-run freshness lookups                                                  |
| 0152     | `0152_dex_liquidity_publication_generations.sql`         | Add DEX-liquidity publication generations and per-run row staging before current-table publication                                               |
| 0153     | `0153_status_reliability_idempotency.sql`                | Add nullable idempotency keys and partial unique indexes for retry-safe status transitions and probe runs                                        |
| 0154     | `0154_apxusd_ddr_tail_90203_link.sql`                    | Link APXUSD tail event 90203 into the sealed June 2 DDR incident and supersede the accidental fresh incident                                    |
| 0155     | `0155_telegram_retention_indexes.sql`                    | Add Telegram retention indexes for inactive subscriber scans and alert-job cleanup batches                                                       |
| 0156     | `0156_telegram_reserve_alerts.sql`                       | Add reserve-drift alert flags to telegram subscribers and subscriptions                                                                          |
| 0157     | `0157_telegram_global_alert_reserve_index.sql`           | Partial index on `telegram_subscribers.global_alert_reserve` for dispatcher reserve-drift fan-out                                                 |
| 0158     | `0158_telegram_disambiguation_expiry_index.sql`          | Add an expiry index for pending Telegram disambiguation cleanup so five-minute pruning avoids full-table scans                                    |
| 0159     | `0159_reusd_mint_burn_source_rebuild.sql`                | Purge Re Protocol reUSD mint/burn rows and reset old/new cursors so canonical token Transfer history backfills cleanly                            |
| 0160     | `0160_telegram_per_coin_alert_override_markers.sql`      | Add per-coin Telegram alert override markers so explicit off settings do not confuse default zeroes with opt-outs                                 |
| 0161     | `0161_apxusd_ddr_tail_90203_relink_repair.sql`           | Repair APXUSD event 90203 relinking when the earlier tail migration found an accidental fresh-incident link already occupying the event            |
| 0162     | `0162_apxusd_duplicate_ddr_prediction_erratum.sql`       | Invalidate the accidental APXUSD duplicate DDR prediction and supersede its incident as an alias of the canonical June 2 incident                  |
| 0163     | `0163_selector_snapshot_daily_quota.sql`                 | Add atomic D1 daily quota rows for unauthenticated selector-snapshot writes                                                                       |
| 0164     | `0164_depeg_event_close_reason.sql`                      | Add nullable depeg close reasons so downstream dispatch can distinguish recovery from coverage-loss and superseded closures                        |
| 0165     | `0165_worker_job_attempts.sql`                           | Add a per-job scheduled Worker attempt ledger for active, deferred, abandoned, and skipped job visibility                                         |
| 0166     | `0166_worker_repair_tasks.sql`                           | Add a generic Worker repair-task ledger for low-priority repair/backfill debt and DDR repair-required events                                      |
| 0167     | `0167_worker_canary_runs.sql`                            | Add a compact data-invariant canary ledger for scheduled Worker structural checks                                                                 |
| 0168     | `0168_surface_publication_generations.sql`               | Add a generic publication-generation ledger for migrated cache-backed and generated Worker surfaces                                                |
| 0169     | `0169_lusd_ddr_event_90410_split.sql`                    | Ledger LUSD event 90410 as a fresh DDR incident and close the resolved repair-debt task                                                           |
| 0170     | `0170_dex_liquidity_history_unique_snapshot.sql`         | Deduplicate DEX liquidity daily history rows and enforce one row per stablecoin/day so repair writes replace stale snapshots                       |
| 0171     | `0171_tape_methodology_source_url_repair.sql`            | Repair persisted Tape methodology source URLs for the Liquidity Score and PSI changelog route renames                                             |

## Retired Individual Migrations

| Sequence | Former Filename                             | Retirement Note                                                                                                                                |
| -------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 0086     | `0086_treasury_stable_exposure_history.sql` | Retired on 2026-04-08 after the treasuries feature removal maintenance window dropped the unused history table and indexes from production D1. |

## Known Anomalies

- Duplicate-prefix allowlist: `0056`, `0061`
- These legacy duplicates existed in the squashed range (0001–0071) and are preserved here for reference. The allowlist is frozen and must not expand.

## Rollout Safety

- Rollout-safety enforcement starts at: `0071`
- Required rollout-safety header: `-- rollout-safety: backward-compatible`
- Standard production deploy applies D1 migrations before the new Worker is live, so every new migration from `0071` onward must keep the previous production Worker running until deploy completes.
- `npm run check:migrations` verifies this manifest's active and retired migration rows against `worker/migrations/*.sql` and can emit a deterministic schema fingerprint after replay for release-summary drift triage.
- `backward-compatible` means additive or compatibility-preserving changes only. Do not drop or rename tables/columns in the default deploy path, and do not add `NOT NULL` columns without a `DEFAULT` because the still-live Worker may still issue inserts before promotion.
- The deploy workflow reruns `npm run check:migrations` on the release runner and uploads the candidate Worker version before remote `wrangler d1 migrations apply` when Workers Versions are available, so the schema-change-to-preview-smoke window stays as short as this default path allows. If Cloudflare returns `entitlements.not_available [code: 10007]` for Workers Versions, CI falls back to `wrangler deploy` after the same validation and migration gates and relies on the production smoke for deployment proof.
- Destructive cleanup must be scheduled as a separate, coordinated rollout after the old Worker code is no longer serving traffic. Do not merge those cleanup migrations into the normal deploy path without an explicit runbook/workflow change.
- Automatic Worker rollback only re-promotes the previous Worker version. It does not undo D1 schema or data changes.

## Recent Migration Rollback Notes

- `0165_worker_job_attempts.sql`: roll back runtime behavior with `WORKER_JOB_LEDGER_MODE=off` or an empty allowlist. Keep the additive table/indexes in place unless a coordinated D1 restore is required.
- `0166_worker_repair_tasks.sql`: disable the repair-task producer/runner for rollback. Queued rows are diagnostic debt and can remain for later inspection; do not delete them as part of Worker rollback.
- `0167_worker_canary_runs.sql`: roll back canary writes with `WORKER_CANARY_MODE=off`. The table is append/upsert telemetry only, pruned by `prune-cron-history`, and does not need schema rollback for Worker-code rollback.
- `0168_surface_publication_generations.sql`: roll back migrated publication writers or status readers to their previous surface-specific sources. Keep the additive generic table/indexes in place unless a coordinated D1 restore is required.

## Rollback Procedure

If a migration corrupts data:

1. **Get bookmark:** `cd worker && npx wrangler d1 time-travel info stablecoin-db`
2. **Restore:** `cd worker && npx wrangler d1 time-travel restore stablecoin-db --bookmark=<BOOKMARK>`
3. **Remove bad migration** from `worker/migrations/` directory
4. **Re-apply remaining:** `cd worker && npx wrangler d1 migrations apply stablecoin-db --remote`
5. **Redeploy worker:** use the standard production deploy workflow, or manually run the equivalent Worker Versions sequence (`cd worker && npx wrangler versions upload`, smoke the preview URL, `npx wrangler versions deploy <VERSION_ID>@100`, then `npx wrangler triggers deploy`). If the account lacks Workers Versions entitlement, the standard workflow uses the legacy `wrangler deploy` fallback after validation and migration gates; manual `wrangler deploy` still bypasses CI validation and should be treated as an emergency shortcut only.

Cloudflare D1 Time Travel retention is account-plan dependent. Verify the current retention window in Cloudflare before relying on a rollback bookmark.

## Related process docs

- [`docs/process/d1-baseline-squash-plan.md`](../../docs/process/d1-baseline-squash-plan.md) — cadence, procedure, and risks for the next baseline squash.
