# Runbook: Blacklist Sync

Triggered by `StatusCause.code`:

- `blacklist_gaps_degraded` (missing-amount share ≥ 1%)
- `blacklist_gaps_stale` (missing-amount share ≥ 2%)
- `blacklist_gaps_recent` (info only: ≥ 5 recent events awaiting amount recovery below the 1% share; never degrades status)

## Symptom

The blacklist ingestion pipeline has unresolved gaps. The missing-amount share or the recent count meets or exceeds the thresholds in `shared/lib/status-thresholds.ts` (`STATUS_BLACKLIST_THRESHOLDS`). The share drives status; the recent count is a watch signal only.

## First checks

1. **Admin page → Debug sync state:** GET `/api/debug-sync-state` (Actions section: under Complete action catalog → Inspect, or in Recommended now while a blacklist gap cause is active). Shows last processed block per `config_key` (one row per contract/config, sorted by `config_key`).
2. **Config-level lag:** compare `config_key` rows, not only chain names. Same-symbol/same-chain deployments can have separate contract/config cursors, and new freeze-ledger snapshots are contract/config scoped.
3. **Stuck chain:** look for a `last_block` that has not advanced for many hours relative to network tip. Remember Tron `last_block` is a millisecond timestamp.
4. **Circuit-open skips:** inspect recent `sync-blacklist` `cron_runs.metadata` for `apiErrorConfigs`, `apiErrorClasses`, budget exhaustion, or circuit-open source skips before resetting cursors.
5. **Upstream RPC health:** if a specific config is stuck, check the relevant provider lane for that chain/config (dRPC/chain RPC/Etherscan/TronGrid).

### Cron lane unavailable or abandoned

`sync-blacklist` runs at `00:03`, `06:03`, `12:03`, and `18:03` UTC. The Crons workspace labels a latest `error` run **Unavailable**; a reconciled stale-child run is additionally labeled **Abandoned**. One missed run therefore remains visible until the next successful execution six hours later, even if the previous public snapshot is still within its freshness budget. The row's `errors 1` is the consecutive latest error streak, not the number of daily failures. Do not loosen freshness thresholds or reset a cursor based on those labels.

Compare `cron_runs` with `cron_slot_executions` and `worker_producer_history`: run rows retain seven days, slot rows provide a longer retained execution trail, and regular producer history retains 30 days of per-job outcomes, errors, versions, and `metadata_json`. Use the latter for a monthly pattern rather than assuming the short Crons workspace display window is the full incident history. Global `status_transitions` keeps longer history but its aggregate cron causes do not name individual jobs; direct operator freshness alerts retain only their latest state/cooldown in `cache`, not an append-only Telegram delivery history.

For a D1 internal/overload error, cursor reads, claims, finalization, event batches, and the final retained-decode diagnostic read already use the shared bounded retry helper. A terminal ordinary exception has no producer metadata, so a null `cron_runs.metadata` alone cannot identify its failing statement or prove that retries were absent. If the exception recurs, correlate its reference with Worker logs before expanding retry scope.

For an abandonment, inspect `metadata.progressStage`, `progressUpdatedAt`, `progressSnapshot`, and Worker activation timing using the [Cron Slot Abandonment runbook](./cron-slot-abandonment.md). A scan-stage snapshot precedes maintenance; it is not evidence that a historical repair tail exhausted the invocation. The blacklist lane has one serial producer and one declared live provider connection. A death before the first slot-heartbeat tick can leave the initial slot timestamp unchanged without proving a broken heartbeat loop.

## Remediation

### Config-scoped historical topic recovery

Use `worker/scripts/replay-blacklist-config-history.ts` after a corrected event-family configuration has shipped but its chain+contract cursor already passed the missed events. It enumerates the **current configured topics**, not every historical implementation's ABI. This is not a cursor reset: the inclusive window must end at or below that deployment's current EVM cursor, and the tool never changes sync state. Do not use `reset-blacklist-sync` for this recovery.

PR #1510 (`acbbb3364`) corrected PAXG/Ethereum's `FreezeAddress(address)` / `UnfreezeAddress(address)` coverage and USDT/Avalanche's `BlockPlaced` / `BlockReleased` / `DestroyedBlockedFunds` family. Replay PAXG from block **25,232,808**, where the proxy upgraded to the implementation that emits the current family (first observed current-family freeze: 25,547,674); earlier `AddressFrozen` / `AddressUnfrozen` history was already tracked. Replay Avalanche USDT from deployment block **4,663,628**; the prior legacy-family configuration did not match that deployment.

From the repository root, set `BLACKLIST_REPLAY_RPC_URL` to the appropriate chain's trusted RPC URL (use an archive endpoint for historical amounts). The RPC must support complete `eth_getLogs`, block headers, and hash-pinned EIP-1898 `eth_call` with `requireCanonical`; unsupported historical balance reads remain NULL, never become current-state guesses. The command validates `eth_chainId` before scanning. Do not put keyed URLs in command arguments or committed evidence.

Capture the chosen deployment's current cursor with these **read-only** commands, then run the exact dry-run invocation. Each end block is captured once, remains explicit, and is rechecked against D1 by the replay:

```bash
DEPLOYMENT=ethereum-0x45804880de22913dafe09f4980848ece6ecbaf78
PAXG_TO_BLOCK=$(mise exec -- npx wrangler d1 execute stablecoin-db --config worker/wrangler.toml --remote --json --command \
  "SELECT COALESCE(cursor_value,last_block) AS to_block FROM blacklist_sync_state WHERE config_key='$DEPLOYMENT'" \
  | jq -er '.[0].results[0].to_block | select(type == "number")')
# Export BLACKLIST_REPLAY_RPC_URL for Ethereum before this command.
# 25,232,808 is the Upgraded(0x7da4c5d9…fa543) block that introduced FreezeAddress/UnfreezeAddress.
mise exec -- npx tsx worker/scripts/replay-blacklist-config-history.ts \
  --config-key "$DEPLOYMENT" \
  --from-block 25232808 --to-block "$PAXG_TO_BLOCK" --dry-run

DEPLOYMENT=avalanche-0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7
AVALANCHE_USDT_TO_BLOCK=$(mise exec -- npx wrangler d1 execute stablecoin-db --config worker/wrangler.toml --remote --json --command \
  "SELECT COALESCE(cursor_value,last_block) AS to_block FROM blacklist_sync_state WHERE config_key='$DEPLOYMENT'" \
  | jq -er '.[0].results[0].to_block | select(type == "number")')
# Switch BLACKLIST_REPLAY_RPC_URL to Avalanche before this command.
mise exec -- npx tsx worker/scripts/replay-blacklist-config-history.ts \
  --config-key "$DEPLOYMENT" \
  --from-block 4663628 --to-block "$AVALANCHE_USDT_TO_BLOCK" --dry-run
```

Review `currentTopics`, `missingEventIds`, event counts, `unresolvedAmountCount`, affected balance count, and `evidenceSha256`. Dry-run performs RPC reads and D1 SELECTs only: it does not write D1, files, audits, caches, balances, or cursors. The default 100,000-block pages use the runtime's complete-range RPC splitter; a failed/capped page, unresolved timestamp, or canonical decode failure aborts the entire replay before writes. Canonical identity deduplication also recognizes legacy decimal/hex log-index spellings; existing rows are never changed.

For application:

1. Preview and arm the existing writer pause with `mise exec -- npx tsx worker/scripts/rebuild-blacklist-current-balances.ts --remote --arm-writer-pause --execute --confirm rebuild-blacklist-current-balances`. Wait until the `sync-blacklist` lease is inactive. This replay does not arm or clear the pause itself.
2. Repeat the reviewed dry-run command with the **same config and block bounds**, replacing `--dry-run` with `--execute --confirm worker/scripts/replay-blacklist-config-history.ts`. Execute each chain separately with its own RPC URL. After provider work and the final writer-pause/lease checks, the tool captures a Time Travel restore point immediately before building its atomic import. It prints `status=restore-point-captured` and `timeTravelBookmark` before writing, includes that bookmark in the hashed evidence and durable audit, and repeats it in the final summary. Capture failure aborts without writes.
3. Require `status=verified`, `insertedEventCount=missingEventCount`, and unchanged `cursorBefore` / `cursorAfter`. A no-op rerun reports `status=unchanged` without writes or restore-point capture. Review the `admin_action_audit` action `replay-blacklist-config-history`, its captured `timeTravelBookmark`, run ID/evidence SHA-256, and inserted rows' `reconciliation_run_id`, `reconciliation_manifest_id`, `provenance_source`, and `provenance_observed_at`. Historical amounts are emitted values or proven pre-block balances; missing evidence stays NULL. Non-USD historical USD amounts remain unavailable without an attributed quote.
4. Inspect affected contract-scoped current-balance identities and a newly computed `/api/blacklist-summary`; only then preview and execute `--clear-writer-pause` with the rebuild CLI's same confirmation.

One atomic D1 file import contains the audit, missing-only canonical inserts, per-row provenance, affected contract-scoped balance upserts, and canonical summary/producer-gap/request-gap cache invalidation. Like other file-import maintenance, it briefly blocks D1 writes. A SQL guard rechecks the cursor generation, writer pause, inactive sync lease, and missing identities inside that transaction; a race rolls everything back. The balance fold reads each affected address's full retained lifecycle, including events after the replay window, so an old replay cannot replace a later destroy with an earlier freeze. Runtime balance identity/value/upsert helpers retain unrelated contracts and preserve last-successful values on provider failure. If a run errors or its outcome is uncertain, inspect the audit and read back inserted run IDs before retrying; never clear the pause based only on a failed command.

The restore point is recovery evidence, **not** a global D1 concurrency token. Other crons and requests legitimately advance the database bookmark during long provider scans; replay does not require bookmark equality or accept an operator-supplied `--time-travel-bookmark`. Concurrency safety comes from the scoped in-transaction SQL guard above. Retain the printed restore point if an import fails or has an uncertain outcome; any whole-database restoration requires a separately reviewed recovery operation because it can also undo unrelated writes after that point.

The durable audit details report `status=applied`, the SQL-counted `insertedEventCount`, zero remaining `missingEventCount`, and the original `plannedMissingEventCount`; these are finalized inside the same transaction, before the CLI's separate verified readback. Replay retains EURC mirror-zero events as `circle_mirror_zero_balance` audit rows and excludes them from balance capture, matching ingestion. A latest destroy without a proven amount skips the balance upsert entirely, preserving any resolved snapshot and its status.

Block evidence retains only validated block number, hash and timestamp, not whole RPC block responses or transaction arrays. Repeating those arrays in historical/current balance observations can push the audit `INSERT` past D1's [100,000-byte per-statement limit](https://developers.cloudflare.com/d1/platform/limits/), even when the event count is small.

On an import failure, replay includes Wrangler's captured stdout/stderr (including JSON error details) in its error and retains its credential-free SQL at `agents/blacklist-history-replay-failures/<run>/statements.sql` with owner-only file permissions. Keep this file and the printed restore point for diagnosis; successful imports remove their SQL directory, and dry-runs create none. Inspect the exact error and read back the audit/run identity before retrying. Do not bypass the scoped guard by applying the retained file directly to production; rerun the guarded CLI after resolving the reported cause.


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

- **Backfill active balances:** Operator CLI (`npx tsx worker/scripts/one-shot-backfill.ts backfill-blacklist-current-balances --execute --allow-atomic-import`, preview with `--query 'dryRun=true'` first, without either execution flag) when `blacklist_current_balances` is missing, stale, or provider-failed. Current-balance totals are last-known successful snapshots, so provider failures preserve the prior value while exposing status/error metadata. This job refreshes current balances only; it does not fill historical Tron event amounts. The [atomic import gate](./one-shot-backfills.md#transport-safety) preserves Tron alias reconciliation and acknowledges temporary live D1 unavailability.
- **Debug sync state:** Admin page → Recommended now or Complete action catalog → `Debug sync state` (`GET /api/debug-sync-state`) to inspect chain cursors before moving pointers.
- **Remediate amount gaps:** Admin page → Recommended now or Complete action catalog → `Remediate Blacklist Gaps` (`POST /api/remediate-blacklist-amount-gaps`); run dry-run first when using direct query/body parameters. The default pass targets recoverable amount gaps even when contract/config provenance is already present; set `onlyMissingProvenance=true` only for legacy provenance repair. This action drives the EVM historical-balance lane; Tron freeze rows are resolved by the scheduled replay tail, not by this route, so read the latest `sync-blacklist` run metadata (`tronAmountRepairAttempted`, `tronAmountRepairResolved`, `tronAmountRepairRetried`, `tronAmountRepairParked`) before treating a Tron gap as unactionable. `tronGridCircuitSkips` rising with `tronAmountRepairAttempted` at zero means the TronGrid circuit is open, not that the lane is missing.
- Successful live balance backfills and amount-gap remediations invalidate the blacklist-derived summary and gap-metric cache rows so `/api/status`, `/api/health`, and `/api/blacklist-summary` recompute from D1 on the next request instead of waiting for the short diagnostic cache TTL or the next full `sync-blacklist` producer snapshot.
- **Backfill missing Ethereum events from kyc.rip:** `worker/scripts/reconcile-blacklist-events-from-kyc-rip.ts` inserts the USDT/USDC Ethereum `blacklist_events` rows the sync lane never observed; it is dry-run by default and its remote D1 writes require `--execute --confirm worker/scripts/reconcile-blacklist-events-from-kyc-rip.ts` (flags in [`../scripts.md`](../scripts.md)). Only the apply path opens an Ethereum JSON-RPC connection, and it reads that endpoint from `ETHEREUM_RPC_URL`, defaulting to the unauthenticated public node `https://ethereum-rpc.publicnode.com` when the variable is unset; point it at a keyed endpoint before reconciling against production data. Receipt fetches that fail or are throttled are logged per candidate (with provider URLs redacted) and skipped instead of aborting the run, so a rate-limited endpoint surfaces as `inserted` below `candidates` in the JSON summary rather than as an error — recheck that ratio and rerun idempotently after fixing the endpoint. The variable scopes to this script's receipt reads only: the `sync-blacklist` cron and the balance lanes keep their own provider configuration and keys.
- **Circuit-open provider:** if metadata points to an open provider circuit, do not reset sync state first. Confirm the provider is healthy and wait for the 30-minute probe window, or, once recovery is proven, delete only the exact `cache` row (`circuit:etherscan` or `circuit:trongrid`) using the scoped procedure in [`stablecoins-cache.md`](./stablecoins-cache.md).
- **Reset sync pointer:** Admin page → Recommended now can surface `reset-blacklist-sync` when the cron is unhealthy, but execute it only after `debug-sync-state` confirms a stuck pointer (also available in Complete action catalog). Each newly executed reset rewinds another interval (EVM: 50,000 blocks; Tron: 604,800,000 ms); event re-ingestion deduplicates rows, not reset requests. Not the first response for generic amount gaps.
- **Per-chain investigation:** the sync cron (`sync-blacklist`) logs per-chain outcomes in `cron_runs.metadata`. Inspect recent runs in the admin page's Crons section.
- **Tron ordering deployment:** apply `0254_blacklist_transaction_index.sql` before deploying the Worker. The maintenance tail resolves up to eight conflicting blocks per run using confirmed transaction positions under the existing limiter, circuit, and budgets, including old rows; no cursor rewind or manual backfill is needed. For the known cases, verify positions `(6,108)` at block `77068121` and `(131,585)` at block `82329223`, then require a fresh summary with `ambiguousOrderCount=0` and the ordering warning removed after cache expiry. Missing evidence stays NULL and remains warned.
- **After ordering repair:** positions restore deterministic event folding but do not recreate retained current-balance snapshots dropped when ingestion found ambiguous order. Preview the guarded `npx tsx worker/scripts/one-shot-backfill.ts backfill-blacklist-current-balances --query 'stablecoin=USDT&chainId=tron&limit=500&dryRun=true'`, review its bounded candidate scope, then apply with `--execute --allow-atomic-import` and `dryRun=false` in the same query scope. Check the repaired identities in the resulting current-balance snapshots and fresh summary; do not substitute a cursor reset or a historical-amount repair for this current-balance refresh.

### Blacklist Current-Balance Rebuild

Use `worker/scripts/rebuild-blacklist-current-balances.ts` only after the source event set is complete:

1. Preview, then arm the writer pause with `--arm-writer-pause`; live changes require `--execute --confirm rebuild-blacklist-current-balances` and an explicit `--local` or `--remote` target.
2. Wait for the `sync-blacklist` cron lease to expire. Live rebuilds check both the pause key and lease before provider work and again immediately before publication; dry-runs do not require those guards.
3. Run the rebuild as a dry-run first. Provider lookups still run, but D1 remains unchanged; inspect `failedCount` before proceeding.
4. Run the confirmed rebuild. More than 10% provider failures abort before D1 mutation. `--force` bypasses only this failure-rate guard and should be used only after reviewing the provider failures.
5. Verify current balances, then preview and execute `--clear-writer-pause`. Do not clear the pause after a failed rebuild until the retained rows have been checked.

Rebuilds refresh only active, non-destroyed, unambiguous records for the selected configured contract. The complete contract/config-scoped ledger stays in place, including released addresses, destroy snapshots, and other contracts on the same asset/chain. Observations reuse the runtime upsert policy: a transient `provider_failed` result retains the last resolved native/USD amounts, source, observation time, and last-success timestamp while updating attempts, failure streaks, and error metadata.

Both balance-maintenance tools first admit all observations into a unique `blacklist_balance_stage_<uuid>` scratch table, validate the admitted row count, then publish one bounded file import containing canonical derived-cache invalidation, a scoped `INSERT ... SELECT ... ON CONFLICT` upsert, and scratch-table removal. Wrangler treats each `--file` import as its own transaction; explicit `BEGIN TRANSACTION` / `COMMIT` statements are not emitted because D1 rejects them. Admission chunks may commit independently, but a failed admission leaves the authoritative ledger and its caches unchanged. Publication either commits both ledger updates and invalidation or neither. Caught failures remove the scratch table; if cleanup fails, the error names the scratch table for review. After an interrupted process, inspect and remove only its abandoned scratch table, never retained ledger rows.

Do not run older delete-and-replace revisions of either balance tool: they can erase retained scoped history and partially commit replacement rows.

#### KYC balance observation admission

`worker/scripts/reconcile-blacklist-current-balances-from-kyc-rip.ts` is dry-run by default and supports the runtime-configured USDT/Ethereum, USDC/Ethereum, and USDT/Tron scopes. Review the normalized count, asset/chain distribution, and `rowsToUpsert`; live admission requires `--execute --confirm worker/scripts/reconcile-blacklist-current-balances-from-kyc-rip.ts`. Unsupported, malformed, duplicate, or below-minimum normalized results do not reach staging. The tool writes current-state observations only, not event-time amounts, and never deletes rows absent from the provider response. A successful publication invalidates the canonical producer summary and gap-metric caches so the next summary request reads the changed D1 ledger without waiting for the next scheduled sync.

## Prevention

- **Historical amount gaps:** inspect provider/decoding evidence and the repair lane, not the cursor. Current balances cannot prove event-time amounts. For unresolved Tron rows, review [replay, zero and destroy proof](../blacklist-tracker.md#event-and-coverage-rules) and escalate refused evidence through the guarded repair CLI; unavailable never means zero.
- **Operator zero repair requires live TronGrid access**, even in dry-run. `worker/scripts/repair-tron-blacklist-amounts.ts` reads `TRONGRID_API_KEY`; the capture alone cannot prove destroy absence. Retain its live destroy-window requests, minimum watermark, page count and outcome with the evidence SHA-256.
- **No repair attempts:** inspect `blacklist_amount_repair_queue.available_at`. Parked rows remain `status=retry` for seven days; deployment does not reset due times. `neverAttempted=0` and `repeatedFailures=0` can coexist with one or two attempts (`repeatedFailures` starts at three).
- **JPYC native amount resolved but USD missing:** `tracked` gaps include retained snapshots without USD even when no provider failed. With a fresh coin-specific quote, preview `npx tsx worker/scripts/one-shot-backfill.ts backfill-blacklist-current-balances --query 'stablecoin=JPYC&chainId=ethereum&limit=500&dryRun=true'`, then apply with `--execute --allow-atomic-import` and `dryRun=false` in the same query scope. This repairs current snapshots, not historical event USD or Tron event amounts.
- **Stale snapshot:** the total remains last-known successful value, not live confirmation. Use status/source distributions and `observed_at` age to choose a balance backfill, provider investigation or the next scheduled refresh.
- **Reset stop:** use `reset-blacklist-sync` only after debug-sync-state proves a stuck cursor, never for amount gaps or transient quality failures. [Cursor State](../blacklist-tracker.md#cursor-state) owns units and safe-frontier rules; [Producer Flow](../blacklist-tracker.md#producer-flow) owns scan/maintenance behavior.
- **Provider diagnosis:** inspect `sync-blacklist` run metadata (`blacklistProviderCalls`, `maxProviderSplitDepth`, `coverageOutcomeCounts`, `apiErrorConfigs`, `apiErrorClasses`, `etherscanLimiterRequestsPerSecond`, `tronLimiterRequestsPerSecond`). Rates describe the run's actual limiters. Per-config evidence is in `blacklist_sync_state`: `last_observed_safe_head`, `last_safe_head_observed_at`, `last_outcome`, `consecutive_failures`.
