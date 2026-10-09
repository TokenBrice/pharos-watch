# Runbook: Blacklist Sync

Triggered by `StatusCause.code`:

- `blacklist_gaps_degraded` (missing-amount share ≥ 1%)
- `blacklist_gaps_stale` (missing-amount share ≥ 2%)
- `blacklist_gaps_recent` (info only: ≥ 5 recent events awaiting amount recovery below the 1% share; never degrades status)

## Symptom

The blacklist ingestion pipeline has unresolved gaps. The missing-amount share or the recent count exceeds the thresholds in `shared/lib/status-thresholds.ts` (`STATUS_BLACKLIST_THRESHOLDS`). The share drives status; the recent count is a watch signal only.

## First checks

1. **Admin page → Debug sync state:** GET `/api/debug-sync-state` (Actions section: under Complete action catalog → Inspect, or in Recommended now while a blacklist gap cause is active). Shows last processed block per `config_key` (one row per contract/config, sorted by `config_key`).
2. **Config-level lag:** compare `config_key` rows, not only chain names. Same-symbol/same-chain deployments can have separate contract/config cursors, and new freeze-ledger snapshots are contract/config scoped.
3. **Stuck chain:** look for a `last_block` that has not advanced for many hours relative to network tip. Remember Tron `last_block` is a millisecond timestamp.
4. **Circuit-open skips:** inspect recent `sync-blacklist` `cron_runs.metadata` for `apiErrorConfigs`, `apiErrorClasses`, budget exhaustion, or circuit-open source skips before resetting cursors.
5. **Upstream RPC health:** if a specific config is stuck, check the relevant provider lane for that chain/config (dRPC/chain RPC/Etherscan/TronGrid).

### Cron lane unavailable or abandoned

`sync-blacklist` runs at `00:03`, `06:03`, `12:03`, and `18:03` UTC. Cron Lanes labels a latest `error` run **Unavailable**; a reconciled stale-child run is additionally labeled **Abandoned**. One missed run therefore remains visible until the next successful execution six hours later, even if the previous public snapshot is still within its freshness budget. The row's `errors 1` is the consecutive latest error streak, not the number of daily failures. Do not loosen freshness thresholds or reset a cursor based on those labels.

Compare `cron_runs` with `cron_slot_executions` and `worker_producer_history`: run rows retain seven days, slot rows provide a longer retained execution trail, and regular producer history retains 30 days of per-job outcomes, errors, versions, and `metadata_json`. Use the latter for a monthly pattern rather than assuming the short Cron Lanes display window is the full incident history. Global `status_transitions` keeps longer history but its aggregate cron causes do not name individual jobs; direct operator freshness alerts retain only their latest state/cooldown in `cache`, not an append-only Telegram delivery history.

For a D1 internal/overload error, cursor reads, claims, finalization, event batches, and the final retained-decode diagnostic read already use the shared bounded retry helper. A terminal ordinary exception has no producer metadata, so a null `cron_runs.metadata` alone cannot identify its failing statement or prove that retries were absent. If the exception recurs, correlate its reference with Worker logs before expanding retry scope.

For an abandonment, inspect `metadata.progressStage`, `progressUpdatedAt`, `progressSnapshot`, and Worker activation timing using the [Cron Slot Abandonment runbook](./cron-slot-abandonment.md). A scan-stage snapshot precedes maintenance; it is not evidence that a historical repair tail exhausted the invocation. The blacklist lane has one serial producer and one declared live provider connection. A death before the first slot-heartbeat tick can leave the initial slot timestamp unchanged without proving a broken heartbeat loop.

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

   The first mutation import invalidates the canonical producer summary and producer/request gap-metric caches before authoritative event or balance writes. Earlier file imports may remain committed if a later import fails; the next public summary request therefore recomputes from the persisted partial result rather than serving the pre-maintenance producer snapshot. Require the verification below before treating a partial run as recovered.

5. Require `status=verified`, `presentEventCount=86`, `missingEventCount=0`, `duplicateIdentityCount=0`, `destroyedAmountActualRaw=8874287612325`, exact balance replay parity, `tron.atSafeHead=true`, all seven Arbitrum configs at safe head, and `unresolvedManifestGapCount=0`.
6. Confirm the same durable result in `GET /api/blacklist-summary` at `reconciliation` and in admin `GET /api/status` at `dataQuality.blacklistReconciliation`; public run IDs must not include the Time Travel bookmark. A failed run remains recorded for forensic review and can be rerun idempotently with a fresh bookmark after its stated gap is fixed.

- **Backfill active balances:** Admin page → Recommended now or Complete action catalog → `Backfill Blacklist Balances` (`POST /api/backfill-blacklist-current-balances`, prefer `?dryRun=true` first) when `blacklist_current_balances` is missing, stale, or provider-failed. Current-balance totals are last-known successful snapshots, so provider failures should preserve the prior value while exposing status/error metadata. This action refreshes current balances only; it does not fill historical Tron event amounts. Later transfers can change an address balance after its freeze. For supported historical repairs, use the guarded transfer-replay CLI and complete confirmed evidence described in [Blacklist Tracker](../blacklist-tracker.md).
- **Debug sync state:** Admin page → Recommended now or Complete action catalog → `Debug sync state` (`GET /api/debug-sync-state`) to inspect chain cursors before moving pointers.
- **Remediate amount gaps:** Admin page → Recommended now or Complete action catalog → `Remediate Blacklist Gaps` (`POST /api/remediate-blacklist-amount-gaps`); run dry-run first when using direct query/body parameters. The default pass targets recoverable amount gaps even when contract/config provenance is already present; set `onlyMissingProvenance=true` only for legacy provenance repair. This action drives the EVM historical-balance lane; Tron freeze rows are resolved by the scheduled replay tail, not by this route, so read the latest `sync-blacklist` run metadata (`tronAmountRepairAttempted`, `tronAmountRepairResolved`, `tronAmountRepairRetried`, `tronAmountRepairParked`) before treating a Tron gap as unactionable. `tronGridCircuitSkips` rising with `tronAmountRepairAttempted` at zero means the TronGrid circuit is open, not that the lane is missing.
- Successful live balance backfills and amount-gap remediations invalidate the blacklist-derived summary and gap-metric cache rows so `/api/status`, `/api/health`, and `/api/blacklist-summary` recompute from D1 on the next request instead of waiting for the short diagnostic cache TTL or the next full `sync-blacklist` producer snapshot.
- **Backfill missing Ethereum events from kyc.rip:** `worker/scripts/reconcile-blacklist-events-from-kyc-rip.ts` inserts the USDT/USDC Ethereum `blacklist_events` rows the sync lane never observed; it is dry-run by default and its remote D1 writes require `--execute --confirm worker/scripts/reconcile-blacklist-events-from-kyc-rip.ts` (flags in [`../scripts.md`](../scripts.md)). Only the apply path opens an Ethereum JSON-RPC connection, and it reads that endpoint from `ETHEREUM_RPC_URL`, defaulting to the unauthenticated public node `https://ethereum-rpc.publicnode.com` when the variable is unset; point it at a keyed endpoint before reconciling against production data. Receipt fetches that fail or are throttled are logged per candidate (with provider URLs redacted) and skipped instead of aborting the run, so a rate-limited endpoint surfaces as `inserted` below `candidates` in the JSON summary rather than as an error — recheck that ratio and rerun idempotently after fixing the endpoint. The variable scopes to this script's receipt reads only: the `sync-blacklist` cron and the balance lanes keep their own provider configuration and keys.
- **Circuit-open provider:** if metadata points to an open provider circuit, do not reset sync state first. Confirm the provider is healthy and wait for the 30-minute probe window, or, once recovery is proven, delete only the exact `cache` row (`circuit:etherscan` or `circuit:trongrid`) using the scoped procedure in [`stablecoins-cache.md`](./stablecoins-cache.md).
- **Reset sync pointer:** Admin page → Recommended now only when the `sync-blacklist` cron itself is unhealthy, or Complete action catalog → `reset-blacklist-sync` after debug-sync-state confirms a stuck pointer. Reverts block pointers backward (EVM: 50,000 blocks; Tron: 604,800,000 ms) to re-process. Idempotent, but not the first response for generic amount gaps.
- **Per-chain investigation:** the sync cron (`sync-blacklist`) logs per-chain outcomes in `cron_runs.metadata`. Inspect recent runs in the admin page's Crons section.
- **Tron ordering deployment:** apply `0254_blacklist_transaction_index.sql` before deploying the Worker. The maintenance tail resolves up to eight conflicting blocks per run using confirmed transaction positions under the existing limiter, circuit, and budgets, including old rows; no cursor rewind or manual backfill is needed. For the known cases, verify positions `(6,108)` at block `77068121` and `(131,585)` at block `82329223`, then require a fresh summary with `ambiguousOrderCount=0` and the ordering warning removed after cache expiry. Missing evidence stays NULL and remains warned.
- **After ordering repair:** positions restore deterministic event folding but do not recreate retained current-balance snapshots dropped when ingestion found ambiguous order. Preview the guarded `POST /api/backfill-blacklist-current-balances?stablecoin=USDT&chainId=tron&limit=500&dryRun=true`, review its bounded candidate scope, then apply with `dryRun=false` and normal operator authentication. Check the repaired identities in the resulting current-balance snapshots and fresh summary; do not substitute a cursor reset or a historical-amount repair for this current-balance refresh.

## Prevention

- Missing amounts are resolved via the amount-recovery lane. Persistent gaps indicate an RPC or event-decoding issue upstream, not a sync-pointer problem.
- Tron-only historical amount gaps with a healthy `sync-blacklist` run do not establish a stuck cursor. Current-balance backfill and the next scheduled balance refresh cannot prove an event-time amount. A freeze older than 15 minutes is replayed automatically from the token's confirmed transfer ledger when that ledger reconciles with the solidified `balanceOf` read bracketing the same solidified head; a row that stays unresolved is one the replay refuses or parks (a ledger beyond the 40-page cap, an unmatched receipt, shared-millisecond evidence, a duplicated transfer record, or a ledger that never reconciles), so escalate with the guarded transfer-replay CLI instead of copying the current ledger or treating an unavailable amount as zero.
- A proven zero is not an unavailable amount. Zero replay now requires non-empty positive-value pre-freeze transfer evidence, complete ordered/nonnegative history reconciled with the confirmed balance, and a complete confirmed post-freeze destroy-event window excluding the address. Empty histories, later destroys, and incomplete destroy windows stay unresolved. Resolved zeroes carry `trongrid-transfer-replay-zero` provenance and do not re-enter the legacy-derived-zero queue.
- Destroy-window proof follows confirmed contract-event pagination with unchanged event family, contract path, and time bounds, under a 40-page total cap (or the lane's smaller remaining page allowance). Every attempted page counts toward the repair budget, including provider failures. A stale indexer watermark yields `state_raced`; a run-window stop yields `runtime_budget`; neither consumes a counted amount-repair attempt. Malformed provider evidence remains `provider_null`, not a proven zero.
- **Operator zero repair requires live TronGrid access**, including dry runs: `worker/scripts/repair-tron-blacklist-amounts.ts` reads `TRONGRID_API_KEY` for authenticated requests. The evidence file alone does not prove destroy absence. The CLI validates once and retains the live destroy-window request URLs, minimum watermark, page count, and outcome in its audit details alongside the submitted evidence SHA-256.
- Inspect `blacklist_amount_repair_queue.available_at` before interpreting zero attempts as a stuck lane: parked outcomes retain `status=retry` but are due seven days after the attempt. `neverAttempted=0` and `repeatedFailures=0` are expected for rows with one or two attempts (`repeatedFailures` starts at three). Deployment does not reset existing due times. The 2026-09-29 seven-zero cohort becomes eligible on October 1–2; the separate 40-page history-cap case still requires complete operator evidence.
- `tracked` gaps count retained snapshots missing a USD value, even when their native amount is resolved and no provider failed. For a missing JPYC conversion with a now-fresh coin-specific quote, preview `POST /api/backfill-blacklist-current-balances?stablecoin=JPYC&chainId=ethereum&limit=500&dryRun=true`, then use `dryRun=false` with normal operator authentication to refresh the scoped snapshots. This does not fill historical event USD amounts or Tron event amounts.
- Stale snapshot warnings mean the frozen total is still a last-known successful snapshot, not a live confirmation. Use status/source distributions and `observed_at` age to decide whether to backfill balances, investigate providers, or wait for the next scheduled refresh.
- Only use `reset-blacklist-sync` when debug-sync-state confirms a stuck pointer — not for transient data-quality blips.
- RPC-backed configs combine required event signatures into one `eth_getLogs` OR-topic scan when the provider supports it. Recursive Alchemy splits stop after 64 calls as well as at the shared deadline/depth/subrequest limits. A zero-frontier primary failure retries through the configured secondary RPC; partial primary coverage remains pinned to its proven contiguous frontier.
- Historical amount gaps enter `blacklist_amount_repair_queue`; priority and retry availability survive across runs. Successful or terminal outcomes close their queue row instead of rescanning the full unresolved set indefinitely.
- Unambiguous legacy event and balance identities migrate in bounded post-scan batches. Same-symbol/same-chain ambiguous identities stay explicit rather than being guessed.
- Provider scan effort is reported in aggregate per run in `sync-blacklist` `cron_runs.metadata` (`blacklistProviderCalls`, `maxProviderSplitDepth`, `coverageOutcomeCounts`, `apiErrorConfigs`, `apiErrorClasses`). Effective provider throughput is reported per run as `etherscanLimiterRequestsPerSecond` and `tronLimiterRequestsPerSecond`, read from the limiters the run actually constructed rather than from the producer default, so the reported rate cannot drift from the injected one. Per-config coverage evidence persists in `blacklist_sync_state` (`last_observed_safe_head`, `last_safe_head_observed_at`, `last_outcome`, `consecutive_failures`); the former per-config `blacklist_provider_scan_telemetry` table was retired and dropped from production on 2026-08-10.
