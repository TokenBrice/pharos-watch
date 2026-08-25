# Runbook: Blacklist Sync

Triggered by `StatusCause.code`:

- `blacklist_gaps_degraded`
- `blacklist_gaps_stale`

## Symptom

The blacklist ingestion pipeline has unresolved gaps in recent blocks. Missing amounts exceed the threshold in `shared/lib/status-thresholds.ts`.

## First checks

1. **Admin page → Debug sync state:** GET `/api/debug-sync-state` (Actions section: under Complete action catalog → Inspect, or in Recommended now while a blacklist gap cause is active). Shows last processed block per `config_key` (one row per contract/config, sorted by `config_key`).
2. **Config-level lag:** compare `config_key` rows, not only chain names. Same-symbol/same-chain deployments can have separate contract/config cursors, and new freeze-ledger snapshots are contract/config scoped.
3. **Stuck chain:** look for a `last_block` that has not advanced for many hours relative to network tip. Remember Tron `last_block` is a millisecond timestamp.
4. **Circuit-open skips:** inspect recent `sync-blacklist` `cron_runs.metadata` for `apiErrorConfigs`, `apiErrorClasses`, budget exhaustion, or circuit-open source skips before resetting cursors.
5. **Upstream RPC health:** if a specific config is stuck, check the relevant provider lane for that chain/config (dRPC/chain RPC/Etherscan/TronGrid).

## Remediation

### Frozen Night Watch reconciliation

Use the guarded reconciliation only for the immutable `night-watch-usdt-tron-2026-07-09` manifest. It contains the exact 86 confirmed events after the audited cursor through `2026-07-09T20:28:03Z`: 72 blacklist additions, 3 removals, and 11 destroys totaling `8,874,287.612325 USDT`. The tool never invokes the global reset path.

1. Confirm the deployed Worker has the guarded reconciliation writers and production D1 has the required blacklist reconciliation/run/repair schema from the active baseline. Historical migration 0181 is squashed; use `worker/migrations/MANIFEST.md` only for lineage. If code or schema is missing in a fresh or recovered environment, use the standard deployment flow before running this action.
2. Run the read-only preflight from the repository root:

   ```bash
   npx tsx worker/scripts/reconcile-night-watch-blacklist.ts --dry-run
   ```

   The preflight re-fetches confirmed TronGrid events, rejects any mismatch with the committed SHA-256 manifest, compares exact D1 identities, builds the affected-address balance replay, and reports Tron plus all required Arbitrum frontiers. It performs no D1 writes.

3. Immediately before mutation, obtain the current bookmark:

   ```bash
   cd worker
   npx wrangler d1 time-travel info stablecoin-db --json
   cd ..
   ```

4. Apply with that exact bookmark and the explicit script confirmation:

   ```bash
   npx tsx worker/scripts/reconcile-night-watch-blacklist.ts \
     --execute \
     --confirm worker/scripts/reconcile-night-watch-blacklist.ts \
     --time-travel-bookmark '<bookmark>'
   ```

   The tool checks that the bookmark is still current both before building the mutation and immediately before writing. If D1 changed, acquire a fresh bookmark and rerun. Writes are idempotent per canonical event ID, attach manifest/run/provider provenance, rebuild only affected contract-scoped balance identities, and advance the Tron cursor only after the full confirmed interval is enumerated. Balance upserts also require the stored observation and attempt timestamps to be no newer than the replay row; a concurrent fresher balance is preserved and causes verification to fail so the operator can review and retry with a fresh bookmark. The tool never deletes all events or balances.

5. Require `status=verified`, `presentEventCount=86`, `missingEventCount=0`, `duplicateIdentityCount=0`, `destroyedAmountActualRaw=8874287612325`, exact balance replay parity, `tron.atSafeHead=true`, all seven Arbitrum configs at safe head, and `unresolvedManifestGapCount=0`.
6. Confirm the same durable result in `GET /api/blacklist-summary` at `reconciliation` and in admin `GET /api/status` at `dataQuality.blacklistReconciliation`; public run IDs must not include the Time Travel bookmark. A failed run remains recorded for forensic review and can be rerun idempotently with a fresh bookmark after its stated gap is fixed.

- **Backfill active balances:** Admin page → Recommended now or Complete action catalog → `Backfill Blacklist Balances` (`POST /api/backfill-blacklist-current-balances`, prefer `?dryRun=true` first) when `blacklist_current_balances` is missing, stale, or provider-failed. Current-balance totals are last-known successful snapshots, so provider failures should preserve the prior value while exposing status/error metadata. This action also re-applies the Tron freeze-ledger mirror so matching Tron event rows can resolve immediately after balance backfill.
- **Debug sync state:** Admin page → Recommended now or Complete action catalog → `Debug sync state` (`GET /api/debug-sync-state`) to inspect chain cursors before moving pointers.
- **Remediate amount gaps:** Admin page → Recommended now or Complete action catalog → `Remediate Blacklist Gaps` (`POST /api/remediate-blacklist-amount-gaps`); run dry-run first when using direct query/body parameters. The default pass targets recoverable amount gaps even when contract/config provenance is already present; set `onlyMissingProvenance=true` only for legacy provenance repair.
- Successful live balance backfills and amount-gap remediations invalidate the blacklist-derived summary and gap-metric cache rows so `/api/status`, `/api/health`, and `/api/blacklist-summary` recompute from D1 on the next request instead of waiting for the short diagnostic cache TTL or the next full `sync-blacklist` producer snapshot.
- **Backfill missing Ethereum events from kyc.rip:** `worker/scripts/reconcile-blacklist-events-from-kyc-rip.ts` inserts the USDT/USDC Ethereum `blacklist_events` rows the sync lane never observed; it is dry-run by default and its remote D1 writes require `--execute --confirm worker/scripts/reconcile-blacklist-events-from-kyc-rip.ts` (flags in [`../scripts.md`](../scripts.md)). Only the apply path opens an Ethereum JSON-RPC connection, and it reads that endpoint from `ETHEREUM_RPC_URL`, defaulting to the unauthenticated public node `https://ethereum-rpc.publicnode.com` when the variable is unset; point it at a keyed endpoint before reconciling against production data. Receipt fetches that fail or are throttled are logged per candidate (with provider URLs redacted) and skipped instead of aborting the run, so a rate-limited endpoint surfaces as `inserted` below `candidates` in the JSON summary rather than as an error — recheck that ratio and rerun idempotently after fixing the endpoint. The variable scopes to this script's receipt reads only: the `sync-blacklist` cron and the balance lanes keep their own provider configuration and keys.
- **Circuit-open provider:** if metadata points to an open provider circuit, do not reset sync state first. Confirm the provider is healthy and wait for the 30-minute probe window, or, once recovery is proven, delete only the exact `cache` row (`circuit:etherscan` or `circuit:trongrid`) using the scoped procedure in [`stablecoins-cache.md`](./stablecoins-cache.md).
- **Reset sync pointer:** Admin page → Recommended now only when the `sync-blacklist` cron itself is unhealthy, or Complete action catalog → `reset-blacklist-sync` after debug-sync-state confirms a stuck pointer. Reverts block pointers backward (EVM: 50,000 blocks; Tron: 604,800,000 ms) to re-process. Idempotent, but not the first response for generic amount gaps.
- **Per-chain investigation:** the sync cron (`sync-blacklist`) logs per-chain outcomes in `cron_runs.metadata`. Inspect recent runs in the admin page's Crons section.

## Prevention

- Missing amounts are resolved via the amount-recovery lane. Persistent gaps indicate an RPC or event-decoding issue upstream, not a sync-pointer problem.
- Fresh Tron-only gaps with a healthy `sync-blacklist` run can be same-cycle ledger-reconciliation lag rather than a stuck cursor. If matching `blacklist_current_balances` rows already exist, prefer balance backfill or the next scheduled run over pointer reset. Missing Tron token balances should remain null/provider-missing until confirmed, not get treated as zero.
- Stale snapshot warnings mean the frozen total is still a last-known successful snapshot, not a live confirmation. Use status/source distributions and `observed_at` age to decide whether to backfill balances, investigate providers, or wait for the next scheduled refresh.
- Only use `reset-blacklist-sync` when debug-sync-state confirms a stuck pointer — not for transient data-quality blips.
- RPC-backed configs combine required event signatures into one `eth_getLogs` OR-topic scan when the provider supports it. Recursive Alchemy splits stop after 64 calls as well as at the shared deadline/depth/subrequest limits. A zero-frontier primary failure retries through the configured secondary RPC; partial primary coverage remains pinned to its proven contiguous frontier.
- Historical amount gaps enter `blacklist_amount_repair_queue`; priority and retry availability survive across runs. Successful or terminal outcomes close their queue row instead of rescanning the full unresolved set indefinitely.
- Unambiguous legacy event and balance identities migrate in bounded post-scan batches. Same-symbol/same-chain ambiguous identities stay explicit rather than being guessed.
- Provider scan effort is reported in aggregate per run in `sync-blacklist` `cron_runs.metadata` (`blacklistProviderCalls`, `maxProviderSplitDepth`, `coverageOutcomeCounts`, `apiErrorConfigs`, `apiErrorClasses`). Effective provider throughput is reported per run as `etherscanLimiterRequestsPerSecond` and `tronLimiterRequestsPerSecond`, read from the limiters the run actually constructed rather than from the producer default, so the reported rate cannot drift from the injected one. Per-config coverage evidence persists in `blacklist_sync_state` (`last_observed_safe_head`, `last_safe_head_observed_at`, `last_outcome`, `consecutive_failures`); the former per-config `blacklist_provider_scan_telemetry` table was retired and dropped from production on 2026-08-10.
