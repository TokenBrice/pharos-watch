# D1 Migrations Manifest

| Sequence | Filename                                        | Description                                                                                     |
| -------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 0001     | `0001_initial.sql`                              | Initial schema: JSON blob cache table                                                           |
| 0002     | `0002_reset_zero_amounts.sql`                   | Reset blacklist events with amount=0 for re-fetch                                               |
| 0003     | `0003_reset_l2_zero_amounts.sql`                | Reset L2 chain (Arbitrum, Polygon, Base) zero amounts                                           |
| 0004     | `0004_reset_bsc_amounts.sql`                    | Fix BSC USDT decimal mismatch (18 not 6)                                                        |
| 0005     | `0005_reset_polygon_usdt_sync.sql`              | Reset Polygon USDT sync for USDT0 upgrade topics                                                |
| 0006     | `0006_depeg_events.sql`                         | Create depeg_events table                                                                       |
| 0007     | `0007_price_cache.sql`                          | Create price_cache table                                                                        |
| 0008     | `0008_depeg_dedup.sql`                          | Deduplicate depeg events by worst peak deviation                                                |
| 0009     | `0009_dex_liquidity.sql`                        | Create dex_liquidity snapshot table                                                             |
| 0010     | `0010_dex_liquidity_history.sql`                | Create dex_liquidity_history for trend tracking                                                 |
| 0011     | `0011_dex_prices.sql`                           | Create dex_prices table (Curve StableSwap cross-validation)                                     |
| 0012     | `0012_dex_liquidity_v2.sql`                     | Add enhanced metrics to dex_liquidity (stress, balance ratio)                                   |
| 0013     | `0013_onchain_supply.sql`                       | Create onchain_supply table                                                                     |
| 0014     | `0014_cron_runs.sql`                            | Create cron_runs table                                                                          |
| 0015     | `0015_supply_history.sql`                       | Create supply_history table (daily snapshots)                                                   |
| 0016     | `0016_cleanup_non_usd_depeg_events.sql`         | Remove non-USD depeg events below 150 BPS threshold                                             |
| 0017     | `0017_dex_history_unique.sql`                   | Deduplicate dex_liquidity_history rows                                                          |
| 0018     | `0018_daily_digest.sql`                         | Create daily_digest table (LLM editorial digest)                                                |
| 0019     | `0019_mint_burn_events.sql`                     | Create mint_burn_events table (v1)                                                              |
| 0020     | `0020_drop_mint_burn.sql`                       | Drop mint_burn_events and mint_burn_sync_state (v1 teardown)                                    |
| 0021     | `0021_digest_title.sql`                         | Add title column to daily_digest                                                                |
| 0022     | `0022_stability_index.sql`                      | Create stability_index table (PSI daily scores)                                                 |
| 0023     | `0023_depeg_pending.sql`                        | Create depeg_pending table (multi-source confirmation)                                          |
| 0024     | `0024_locked_liquidity.sql`                     | Add locked_liquidity_pct to dex_liquidity                                                       |
| 0025     | `0025_stability_index_unique.sql`               | Deduplicate stability_index by computed_at                                                      |
| 0026     | `0026_stability_index_samples.sql`              | Create stability_index_samples table                                                            |
| 0027     | `0027_digest_extended.sql`                      | Add digest_extended column to daily_digest                                                      |
| 0028     | `0028_blacklist_indexes.sql`                    | Add indexes on blacklist_events (chain_name, event_type)                                        |
| 0029     | `0029_feedback_rate_limit.sql`                  | Create feedback_rate_limit table                                                                |
| 0030     | `0030_onchain_supply_index.sql`                 | Add index on onchain_supply.updated_at                                                          |
| 0031     | `0031_yield_data.sql`                           | Create yield_data and yield_history tables                                                      |
| 0031a    | `0031a_mint_burn_v2.sql`                        | Create mint_burn_events v2 + hourly aggregates + sync state                                     |
| 0032     | `0032_stress_signals.sql`                       | Create stress_signals table (DEWS 15-min rolling samples)                                       |
| 0033     | `0033_yield_warning_signals.sql`                | Add warning_signals column to yield_data                                                        |
| 0034     | `0034_cron_leases.sql`                          | Create cron_leases table (single-writer execution fencing)                                      |
| 0035     | `0035_stability_index_methodology_version.sql`  | Add methodology version tracking to PSI tables                                                  |
| 0036     | `0036_liquidity_methodology_version.sql`        | Add methodology version tracking to liquidity tables                                            |
| 0037     | `0037_blacklist_methodology_version.sql`        | Add methodology version tracking to blacklist events                                            |
| 0038     | `0038_mint_burn_price_audit.sql`                | Add price_used and price_timestamp to mint_burn_events                                          |
| 0039     | `0039_admin_idempotency_keys.sql`               | Create admin_idempotency_keys table                                                             |
| 0040     | `0040_enum_constraints.sql`                     | Add trigger-based enum constraints and non-negativity guards                                    |
| 0041     | `0041_yield_data_multi_source.sql`              | Add per-source tracking (source_key, is_best) to yield_data                                     |
| 0042     | `0042_reusd_mint_amount_scale_fix.sql`          | Fix reUSD mint amounts (18-decimal, not 6)                                                      |
| 0043     | `0043_mint_burn_run_state.sql`                  | Create mint_burn_run_state table (round-robin scheduling)                                       |
| 0044     | `0044_block_timestamp_cache.sql`                | Create block_timestamp_cache table                                                              |
| 0045     | `0045_remove_mint_burn_coin_configs.sql`        | Purge de-tracked mint/burn coins (batch 1)                                                      |
| 0046     | `0046_mint_burn_bridge_classification.sql`      | Add burn_type column for bridge-aware accounting                                                |
| 0047     | `0047_status_reliability.sql`                   | Create status_state, status_transitions, status_probe_runs, and status_discrepancy_state tables |
| 0048     | `0048_safety_grade_history.sql`                 | Create safety_grade_history table                                                               |
| 0049     | `0049_audit_blacklist_index.sql`                | Add composite index for blacklist pagination                                                    |
| 0050     | `0050_audit_perf_indexes.sql`                   | Add composite covering index for mint_burn_events hot query                                     |
| 0051     | `0051_remove_mint_burn_coin_configs_batch2.sql` | Purge de-tracked mint/burn coins (batch 2)                                                      |
| 0052     | `0052_status_probe_failure_alerts.sql`          | Reconciliation no-op (columns already in 0047)                                                  |
| 0053     | `0053_drop_legacy_id_support.sql`               | Drop stablecoin_id_map table (Phase 4 ID migration cleanup)                                     |
| 0054     | `0054_telegram_subscribers.sql`                 | Create telegram_subscribers table                                                               |
| 0055     | `0055_digest_meta.sql`                          | Add digest_meta column to daily_digest                                                          |
| 0056     | `0056_dex_discovery_staging.sql`                | Create dex_pool_staging table (pool discovery)                                                  |
| 0056     | `0056_mint_burn_flow_type.sql`                  | Add flow_type column to mint_burn_events                                                        |
| 0056     | `0056_yield_history_warning_signals.sql`        | Add warning_signals column to yield_history                                                     |
| 0057     | `0057_dex_staging_quality_metadata.sql`         | Add dex_id, quality_multiplier, pool_type to dex_pool_staging                                   |
| 0058     | `0058_cron_run_progress.sql`                    | Create cron_run_progress table                                                                  |
| 0059     | `0059_discovery_candidates.sql`                 | Create discovery_candidates table                                                               |
| 0060     | `0060_telegram_pending_alerts.sql`              | Create telegram_pending_alerts overflow queue                                                   |
| 0061     | `0061_depeg_pending_reason.sql`                 | Add reason column to depeg_pending                                                              |
| 0061     | `0061_liquidity_coverage_confidence.sql`        | Add coverage_class and confidence metadata to dex_liquidity                                     |
| 0061     | `0061_telegram_bot_tightening.sql`              | Add subscription preferences, quiet-hours, pending-action metadata                              |
| 0061     | `0061_yield_history_source_aware.sql`           | Replace coin-level yield history with per-source rows                                           |
| 0062     | `0062_mint_burn_null_price_index.sql`           | Add index for NULL-price backlog scans                                                          |
| 0063     | `0063_telegram_global_alerts.sql`               | Add all-stablecoin alert flags to telegram_subscribers                                          |
| 0064     | `0064_reserve_composition.sql`                  | Create reserve_composition table (live reserve sync)                                            |
| 0065     | `0065_reserve_sync_state.sql`                   | Create reserve_sync_state table                                                                 |
| 0066     | `0066_redemption_backstops.sql`                 | Create redemption_backstop table                                                                |
| 0067     | `0067_public_api_rate_limit.sql`                | Create public_api_rate_limit table                                                              |
| 0068     | `0068_dex_prices_index.sql`                     | Add index on dex_prices.updated_at                                                              |
| 0069     | `0069_chain_supply_history.sql`                 | Create chain_supply_history table                                                               |
| 0070     | `0070_dex_price_challengers.sql`                | Create published DEX challenger snapshot tables for pool-challenge and depeg-confirmation reads |
| 0071     | `0071_live_reserve_snapshot_metadata_and_history.sql` | Add live reserve snapshot metadata columns and sync history tables                         |
| 0072     | `0072_telegram_launch_alerts.sql`               | Add launch alert flags to telegram subscribers and subscriptions                                |
| 0073     | `0073_price_cache_provenance.sql`               | Add price-cache provenance and timestamp metadata columns                                        |
| 0074     | `0074_cron_slot_executions.sql`                 | Add durable scheduled-slot execution fencing and slot timestamps to cron history/progress        |

## Known Anomalies

- Duplicate-prefix allowlist: `0056`, `0061`
- `0031` and `0031a` share a numeric stem but not the same full alphanumeric prefix. Wrangler tracks applied migrations by filename, not sequence number, so the historical `0056` / `0061` duplicates are safe but confusing and must not expand.

## Rollout Safety

- Rollout-safety enforcement starts at: `0071`
- Required rollout-safety header: `-- rollout-safety: backward-compatible`
- Standard production deploy applies D1 migrations before the new Worker is live, so every new migration from `0071` onward must keep the previous production Worker running until deploy completes.
- `backward-compatible` means additive or compatibility-preserving changes only. Do not drop or rename tables/columns in the default deploy path.
- Destructive cleanup must be scheduled as a separate, coordinated rollout after the old Worker code is no longer serving traffic. Do not merge those cleanup migrations into the normal deploy path without an explicit runbook/workflow change.

## Rollback Procedure

If a migration corrupts data:

1. **Get bookmark:** `wrangler d1 time-travel info stablecoin-db --remote`
2. **Restore:** `wrangler d1 time-travel restore stablecoin-db --bookmark=<BOOKMARK> --remote`
3. **Remove bad migration** from `worker/migrations/` directory
4. **Re-apply remaining:** `wrangler d1 migrations apply stablecoin-db --remote`
5. **Redeploy worker:** `wrangler deploy`

Cloudflare D1 Time Travel retention is account-plan dependent. Verify the current retention window in Cloudflare before relying on a rollback bookmark.
