# Runbook: Blacklist Sync

> **Agent navigation** — Start with [First checks](#first-checks) and [Remediation](#remediation). Implementation owners: [Methodology and registries](#methodology-and-ownership) · [Exposure projections](#public-exposure-contract) · [Schedule/provider paths](#schedule-and-runtime) · [Event proof](#event-and-coverage-rules) · [Storage](#storage-semantics) · [Cursor state](#cursor-state) · [Producer flow](#producer-flow) · [API](#api-and-operator-contract) · [Frontend](#frontend-contract) · [Maintenance](#maintenance-checklist). [Public methodology](../blacklist-tracker.md) owns reader-facing interpretation and exposure decisions.

## Symptom

Triggered by `StatusCause.code`:

- `blacklist_gaps_degraded` (missing-amount share ≥ 1%)
- `blacklist_gaps_stale` (missing-amount share ≥ 2%)
- `blacklist_gaps_recent` (info only: ≥ 5 gaps in the last 24h or queued EVM freezes within 72h, below the 1% share; never degrades status)

The thresholds live in `shared/lib/status-thresholds.ts`. Internal classification excludes non-Tron `blacklist` rows still `recoverable_pending` within `BLACKLIST_PROOF_CATCHUP_WINDOW_SEC` (72h) from the degrading share; its watch counts these plus gaps within 24h. Older or failed (`provider_failed` / `ambiguous`) freezes, Tron and destroy gaps retain ordinary accounting. Published gap counts/ratios still include all gaps and the ordinary 24h recent window.

## First checks

1. **Admin page → Debug sync state:** GET `/api/debug-sync-state` (Actions section: under Complete action catalog → Inspect, or in Recommended now while a blacklist gap cause is active). Shows last processed block per `config_key` (one row per contract/config, sorted by `config_key`).
2. **Config-level lag:** compare `config_key` rows, not only chain names. Same-symbol/same-chain deployments can have separate contract/config cursors, and new freeze-ledger snapshots are contract/config scoped.
3. **Stuck chain:** look for a `last_block` that has not advanced for many hours relative to network tip. Remember Tron `last_block` is a millisecond timestamp.
4. **Circuit-open skips:** inspect recent `sync-blacklist` `cron_runs.metadata` for `apiErrorConfigs`, `apiErrorClasses`, budget exhaustion, or circuit-open source skips before resetting cursors.
5. **Upstream RPC health:** if a specific config is stuck, check the relevant provider lane for that chain/config (Dwellir/dRPC/chain RPC/Etherscan/TronGrid).

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
3. Require `status=verified`, `insertedEventCount=missingEventCount`, and unchanged `cursorBefore` / `cursorAfter`. A no-op rerun reports `status=unchanged` without writes or restore-point capture. Review the `admin_action_audit` action `replay-blacklist-config-history`, its captured `timeTravelBookmark`, run ID/evidence SHA-256, and inserted rows' `reconciliation_run_id`, `reconciliation_manifest_id`, `provenance_source`, and `provenance_observed_at`. Historical amounts require emitted values; pre-block balances cannot prove log-position amounts, so otherwise they stay unavailable (NULL) while an emitted zero stays zero. Non-USD historical USD amounts remain unavailable without an attributed quote.
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
- **Remediate amount gaps:** Admin page → Recommended now or Complete action catalog → `Remediate Blacklist Gaps` (`POST /api/remediate-blacklist-amount-gaps`); run dry-run first when using direct query/body parameters. The default pass targets recoverable amount gaps even when contract/config provenance is already present; set `onlyMissingProvenance=true` only for legacy provenance repair. This action drives the EVM historical-balance lane; Tron freeze rows are resolved by the scheduled replay tail, not by this route, so read the latest `sync-blacklist` run metadata (`tronAmountRepairAttempted`, `tronAmountRepairResolved`, `tronAmountRepairRetried`, `tronAmountRepairParked`) before treating a Tron gap as unactionable. `tronAmountRepairOutcome="skipped"` with `tronAmountRepairReason="provider-circuit-open"` means the TronGrid circuit is open, not that the lane is missing. Result counters of failed or skipped stages are `null`; a successful empty stage is `ok` with observed zero. `failed` outcomes add `blacklist-*-repair-failed` to `metadata.reasons`.
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

- **Historical amount gaps:** inspect provider/decoding evidence and the repair lane, not the cursor. Current balances cannot prove event-time amounts. For unresolved Tron rows, review [replay, zero and destroy proof](#event-and-coverage-rules) and escalate refused evidence through the guarded repair CLI; unavailable never means zero.
- **Operator zero repair requires live TronGrid access**, even in dry-run. `worker/scripts/repair-tron-blacklist-amounts.ts` reads `TRONGRID_API_KEY`; the capture alone cannot prove destroy absence. Retain its live destroy-window requests, minimum watermark, page count and outcome with the evidence SHA-256.
- **No repair attempts:** inspect `blacklist_amount_repair_queue.available_at`. Parked rows remain `status=retry` for seven days; deployment does not reset due times. `neverAttempted=0` and `repeatedFailures=0` can coexist with one or two attempts (`repeatedFailures` starts at three).
- **JPYC native amount resolved but USD missing:** `tracked` gaps include retained snapshots without USD even when no provider failed. With a fresh coin-specific quote, preview `npx tsx worker/scripts/one-shot-backfill.ts backfill-blacklist-current-balances --query 'stablecoin=JPYC&chainId=ethereum&limit=500&dryRun=true'`, then apply with `--execute --allow-atomic-import` and `dryRun=false` in the same query scope. This repairs current snapshots, not historical event USD or Tron event amounts.
- **Stale snapshot:** the total remains last-known successful value, not live confirmation. Use status/source distributions and `observed_at` age to choose a balance backfill, provider investigation or the next scheduled refresh.
- **Reset stop:** use `reset-blacklist-sync` only after debug-sync-state proves a stuck cursor, never for amount gaps or transient quality failures. [Cursor State](#cursor-state) owns units and safe-frontier rules; [Producer Flow](#producer-flow) owns scan/maintenance behavior.
- **Provider diagnosis:** inspect `sync-blacklist` run metadata (`blacklistProviderCalls`, `maxProviderSplitDepth`, `coverageOutcomeCounts`, `apiErrorConfigs`, `apiErrorClasses`, `etherscanLimiterRequestsPerSecond`, `tronLimiterRequestsPerSecond`). Rates describe the run's actual limiters. Per-config evidence is in `blacklist_sync_state`: `last_observed_safe_head`, `last_safe_head_observed_at`, `last_outcome`, `consecutive_failures`.


## Methodology And Ownership

Multi-chain blacklist/freeze event tracker for stablecoins. Every six hours, the runtime scans the live contract configurations in `worker/src/lib/blacklist-contracts.ts`; that registry owns the supported chains, symbols, and deferred deployments.

- **Version source:** `shared/lib/methodology-versions/registry.ts`
- **Public changelog:** `/methodology/blacklist-tracker-changelog/`
- **Structured changelog:** `shared/data/methodology-changelogs/blacklist-tracker/`

The tracker counts canonical account/log identities once and persists Tron accounts as validated lowercase `0x` bytes rather than provider Base58. Numeric local ordering and proven cross-transaction evidence govern lifecycle and amount state; matching block hashes govern RPC event timestamps. Bounded scan progress is not caught-up coverage and cannot renew success/publication clocks. Durable snapshot debt retries budget-skipped or ambiguous work. Unknown USD valuations remain unavailable, mixed totals disclose partial coverage, and gold totals include every canonical tracked cohort, including XAUM, with explicit provenance for zero substitution. Historical repair cannot use current quotes as event-time USD evidence.

Fresh admitted producer observations and production resource evidence remain separate gates from fixed-clock supply/valuation/coverage comparison; these prerequisites do not assert completed production replay or runtime health. Release chronology belongs to the structured changelog above. The provisional activation target, release obligations, owner-ruling history, and provider-admission observations are retained in `git:a23e12b91:docs/blacklist-tracker.md`, not as current release or health claims.

Three registries have deliberately different jobs:

- `CONTRACT_CONFIGS` in `worker/src/lib/blacklist-contracts.ts` is the cron-backed scan set. It owns tracker-specific chain, contract, start-block, event-family, topic, and decoding metadata.
- `BLACKLIST_STABLECOINS` in `shared/types/market.ts` is the API and UI filter universe. It may retain archived identities after a live scan is retired.
- `worker/src/lib/blacklist-coverage-manifest.ts` derives supported coverage and owns explicit deferred and out-of-scope deployment records.

Do not copy any of those rosters into documentation. Contract addresses and decimals resolve from the shared stablecoin registry except for explicit traded-contract or tracker-specific overrides in `blacklist-contracts.ts`.

An override may reuse decimals only for its exact chain/address in the configured primary/traded inventory. Otherwise it must supply reviewed `decimalsOverride`; missing scale rejects configuration rather than borrowing another deployment's decimals or assuming 18. EVM address case normalizes, while case-sensitive native identities remain distinct.

Every stablecoin ID in `CONTRACT_CONFIGS` must resolve to direct `Freezable: Yes` metadata. `worker/src/lib/__tests__/blacklist-contracts.test.ts` enforces that boundary so direct tracker coverage cannot be mislabeled as only upstream exposure.

## Public Exposure Contract

The `/freezewatch/` exposure summary uses `buildBlacklistStatusBuckets()` and the same reviewed
four-state model as Report Cards: **Yes** (`true`), **Possible** (`"possible"`), **Upstream**
(`"inherited"`), and **No** (`false`). These are exposure classes, not probabilities or evidence of
an observed freeze. Apply the following procedure in order; a direct verdict takes precedence over
upstream exposure.

Retracting an observed freeze claim does not change issuer-control exposure. Source-suppressed claims, including recovered mirror-zero events, are removed from public Tape readers and unsent alert admission under the [source reconciliation contract](../tape-page.md#source-reconciliation); their exact permalink lookup returns `404` with reason `freeze-claim-retracted`, not an empty event.

The [public decision procedure](../blacklist-tracker.md#freezewatch-decision-procedure) owns deployment materiality, direct-control precedence, parent/reserve tests and evidence requirements. Its materiality threshold is `semantic.materiality.deploymentMaterialSharePct` in the Safety Score policy.

The public buckets read `blacklistabilityReview.reviewedStatus` through the generated client-registry
`blacklistStatus`. That reviewed registry value is the sole product-level status authority. Safety
Score V9 consumes the same review for evidence freshness, scoring gaps, and failure-domain attribution,
but its `accessPosture.freezeExposure` is not a fallback status source.

Static detail quick answers advertise live freeze/blacklist events only for active assets whose
uppercase symbol belongs to `BLACKLIST_STABLECOINS`, checked through `isBlacklistStablecoin()`.
An active listing or a reviewed freeze verdict alone does not establish event-tracker coverage.

Bucket **counts** come from the reviewed registry and never depend on runtime supply. Bucket **market
cap** sums only observed current supply read through `getCirculatingRawOrNull()`: a reviewed active coin
that is missing from `/api/stablecoins`, or whose peg buckets are absent, empty or wholly invalid, is
counted in `supplyUnavailableCount` and excluded from every total rather than added as `$0`.
`computeFreezableSummary()` (`shared/lib/freezewatch/freezable-summary.ts`; shared by the hero, meter,
stats band and the FreezeWatch share card) classifies coverage as
`complete`, `partial` or `unavailable`. `unavailable` (no reviewed coin reported supply, including a
schema-valid empty list) publishes no supply total or share (`—`) while registry counts stay visible.
`partial` keeps the freezable and unfreezable headline shares but qualifies them as observed-only: the
hero reads "of observed" market cap, the unfreezable card adds a small `partial` marker beside its figure,
and the "Observed supply only · N assets without supply data excluded" label and observed totals appear in
secondary text, so a partial list can never read as a full-market share. The marker never replaces the
figure; the FreezeWatch share card is still withheld for `partial` coverage. A bucket whose every member lacks supply shows `—` for its value
and share; the combined freeze-exposed value and share are likewise `—` when a nonempty exposed population has no observed supply, even if non-freezable assets are observed; an explicit observed zero remains a real `$0`. The FreezeWatch data-quality notice also lists
`dataQuality.ambiguousOrderCount` events (with the plain-language `ambiguousOrderReason`, currently Tron
transfers in separate transactions whose order cannot be confirmed) when the count is positive.

The hero's coin denominator is the sum of all four bucket counts (every active coin with a reviewed
status), named by an `Active · N coins classified` `UniverseChip`; the freezable-coins figure reads
`freezable / classified`. The four bucket cards share one row grammar so their figures align; `Yes`
differs only by its wider span.

### Upstream Exposure And The Safety Score V9 Access Branch

An `upstream` review needs no parent asset. It may come from a tracked parent or wrapper, full CEX
custody, or reserve exposure that strictly exceeds the 50% threshold under the policy above. A direct
`Possible` token review stays in the `possible` tier even when it also carries upstream exposure. The
Safety Score V9 access branch consumes that same reviewed verdict. `adaptAccessReview()` in
`worker/src/lib/safety-score-v9/extension.ts` grants `structuralDisposition: "inherited-upstream"` —
which reclassifies the access gap from `missing-access-review` to the measured
`inherited-access-exposure` — when the reviewed status is `inherited` and an upstream asset can be
**named**, either by `variantOf`/`mintAuthority.inheritedFrom` or by a curated reserve slice.

The reserve-slice attribution path is deliberately strict: the slice must
carry an explicit `coinId`, that id must be in the fact set's active asset set, and the named asset must
be directly freeze-capable — either its own review resolves to a direct holder freeze, or it carries no
blacklistability review at all and its governance flag is `centralized`, mirroring the report card's
blacklistable seed set. A declared parent takes precedence and keeps its
`mint-control` failure domain; a reserve-slice upstream carries `reserve-issuer` instead. Scoring is
unchanged either way — the freeze facts stay `bounded-unknown`, and the disposition only changes how
the gap is attributed.

The reserve-slice fallback applies only when no compiled reviewed access claim graph exists.
With a [reviewed look-through graph](../access-lookthrough.md), graph authority/path diagnostics
take precedence: raw registry slices cannot fill partial, stale or unresolved graph branches or add
a second reserve failure-domain attribution. Independently reviewed declared-parent and local
facts remain. Without a graph, the largest qualifying reserve share wins, with lexicographic asset
id breaking ties; the existing structural disposition and bounded scoring state are preserved.

When the same current `inherited` verdict names **no** tracked upstream, the review is retained with
`structuralDisposition: "inherited-untracked-upstream"`: no `upstreamAssetId` and no failure domain
are asserted (the branch verifies neither), the freeze review keeps its `possible` reach, and the gap
is still the measured `inherited-access-exposure` rather than `missing-access-review`. Dropping that
review would publish assets such as `dai-makerdao` and `crvusd-curve` as never reviewed and erase
the exposure the reviewer had measured.

The transfer half of the branch has its own structural case. `resolveSafetyScoreV9ReviewedTransferFact()`
in `worker/src/lib/safety-score-v9/extension-transfer.ts` normally requires the curated
`transfer-review-overlays-v1.json` entry to cover every material *contract* deployment, which a
chain-native asset with no `contracts[]` by design (fUSD on Zano, the Zephyr protocol assets) can
never satisfy. When the registry offers nothing contract-addressable — no supported-chain contract
and no material supported-chain supply — **and** every reviewed deployment sits on a chain outside
the supported chain registry, the curated review is the complete deployment scope, so the transfer
fact publishes as known with `structuralDisposition: "non-contract-native"` recording that
applicability basis. Every leg is fail-closed: one supported-chain deployment, or a missing curated
review, and the asset keeps gapping as `missing-access-review`.

Observed tracker history is evidence, not policy probability. Event counts describe supported observed history and are symbol-level in the current summary payload; the UI must not label them as contract-level totals.
The published `goldBlacklisted` counter sums per-symbol blacklist counts through `isGoldBlacklistStablecoin()`, the same gold-cohort authority used by amount handling.

The tracker has two amount layers:

- `blacklist_events` stores immutable event history and event-time amounts only when Pharos can justify historical attribution.
- `blacklist_current_balances` stores last-known successful freeze-ledger snapshots used by the public tracked frozen-total summary.

The snapshot total is not a live balance guarantee and is distinct from the local net-active event-state view.

The producer summary cache is admitted fail-closed against the shared response schema with current-version `coverage`, `freezeLedgerMeta`, `dataQuality`, and `methodology` fields required. Invalid nested values or missing required fields trigger the canonical producer materializer; concurrent cold misses coordinate through a durable D1 cache claim so only one request rebuilds the snapshot. Valid retained snapshots keep their producer freshness and all additive fields rather than being projected through the parser. The producer payload is statically typed to the same response contract. Public response optionality is unchanged.

## Schedule And Runtime

- **Expression:** `3 */6 * * *`
- **Slot:** `worker/src/handlers/scheduled/hourly-blacklist.ts`
- **Producer:** `syncBlacklist()` in `worker/src/cron/sync-blacklist.ts`
- **Runtime budget:** 10 minutes for scans, with a 60-second minimum window before starting another config; a separately capped maintenance tail ends at 10 minutes 45 seconds
- **Subrequest budget:** 900 across scanning, enrichment, and maintenance
- **Provider limiter:** serial per-provider limiters — Tron reads share 3 requests per second across Dwellir and TronGrid, Etherscan uses 4 requests per second injected by the scheduled slot (the producer's own 3/s default applies only when no external Etherscan limiter is supplied)

The producer returns `itemCount` as rows actually inserted into `blacklist_events`. Its `eventsFetched` metadata counts parsed rows before `INSERT OR IGNORE` deduplication. The remaining bounded counters and failure samples are defined beside `SyncBlacklistResult` and its metadata assembly in `sync-blacklist.ts`; do not duplicate that key inventory here.

The final retained-decode diagnostic read uses the shared abort-aware D1 transient-error retry policy (up to three retries), like cursor claims and finalization. A single D1 internal/overload error must not discard an otherwise completed scan's result while assembling `decodeRetryCounts`; exhausted retries and non-transient errors still fail the run.

Outcome truth: a summary or gap-snapshot publication exception raises an otherwise `ok` run to `degraded` (never lowering `error`) with reason `blacklist-snapshot-publication-failed`; `producerSnapshotError`, successful sibling writes and retained artifacts are unchanged. Each repair stage reports flat `amountRepair*`, `tronOrder*` and `tronAmountRepair*` `Outcome` (`ok|partial|failed|skipped`) and `Reason` metadata. A thrown stage is `failed` and adds `blacklist-evm-amount-repair-failed`, `blacklist-tron-order-repair-failed` or `blacklist-tron-amount-repair-failed` to `metadata.reasons`; a skipped stage names `provider-circuit-open`, `maintenance-budget-exhausted` or `subrequest-budget-exhausted`, and Tron replay skipped after an order failure names `tron-order-repair-failed`. The current-balance debt lane reports `currentBalanceDebtOutcome`/`currentBalanceDebtReason`; a thrown lane adds `blacklist-current-balance-debt-repair-failed` without discarding the completed scan. Counters of failed or skipped stages are `null` (unobserved); a stage that returned empty is `ok` with observed zero, and a budget-limited return is `partial` with `blacklist-budget-exhausted` and its observed counters. The existing scan reason stays primary, then publication, then the first failed stage.

`metadata.tronRpc[configKey]` records the observed source, calls by provider, fallback reason and row-level repair skips separately from those maintenance-stage outcomes: observed transaction positions carry `rpc-transaction-index-observed`, and emitted amounts carry `rpc-event-amount-observed`, with their respective row counts. These rows need no later ordering or amount lookup for the evidence already present. The maintenance tail remains available for legacy and event-API fallback rows; amountless RPC freezes still require TronGrid transfer replay and are never marked amount-resolved merely because RPC ordering succeeded.

Current-balance cache telemetry preserves the canonical `skippedDueBudget` count and `budgetExhausted` flag; neither is replaced by a synthetic deletion counter.

### Provider Paths

- Etherscan v2 is an explorer source for supported EVM log scans, emitted destroy-amount receipt recovery and a best-effort final current-balance fallback.
- Base, Optimism, Avalanche, BSC, and Gnosis prefer chain RPC `eth_getLogs`; chain RPC configuration comes from `worker/src/lib/chain-registry.ts`.
- Current EVM balance snapshots use `fetchEvmTokenBalance` with the explicit `latest` tag: dRPC when configured, then the shared chain RPC path, then best-effort Etherscan. The same transport accepts a numeric block, but a block-bound balance is not proof of an amountless event's historical quantity; current snapshots and the rebuild CLI never supply that quantity.
- Scheduled `logScanRpcEndpoints` puts Dwellir first on Gnosis (9,000-block pages; dRPC/public failover), Base/Optimism/Avalanche (10,000; Alchemy/public), independent of state placement. BSC is excluded. `DWELLIR_ROUTING_DISABLED_CHAINS` restores incumbents; EVM mint/burn keeps Alchemy.
- Ranges use the smaller caller/provider span; incumbent windows stay unchanged. Range errors (including HTTP-200 `-32005`) split serially within depth/call/deadline budgets; incomplete ranges cannot advance cursors. Log/timestamp/receipt reads use registered auth and meter Dwellir members/retries. Retained endpoints reject starts before `head - retainedBlocks`; zkSync stays excluded. Transaction-context singleton retries honor abort/deadline/budget, capped at eight/batch; failures stay unavailable.
- Dwellir targets 100 serial log calls/config, up to 600 with ≥300 subrequests/≥240 s left in the shared 900-subrequest/10-minute budget (splits included). Reserve stops shorten targets, not coverage. Capacity: Gnosis 0.9–5.4M blocks/run; Base/Optimism/Avalanche 1–6M. Incumbent fallback spans: Base/Optimism Alchemy 500,000, public 50,000; Avalanche Alchemy 250,000, public eight ×2,000.
- Tron event scans prefer admitted Dwellir `/jsonrpc`, then TronGrid `/jsonrpc`; the existing TronGrid event API handles absent native admission, bootstrap cursors and incomplete or unusable RPC evidence. Dwellir shares the scheduled key, ledger, circuit and disabled-chain gates. Each config admits at most 30,000 inclusive blocks per RPC scan, in up to three 10,000-block windows; genuine range/body-limit errors split serially, while rate-limit and provider failures use fallback. Larger backlogs remain explicitly incomplete. Reads share the unchanged 900-subrequest budget, serial 3 rps limiter and scan deadline; the native transport's [body caps](../process/worker-infrastructure-appendix.md#initialization-and-rpc-boundaries) also apply.
- The solidified head must be no older than ten minutes (`tron-rpc-stale-solid-head`) and no more than 30 seconds in the future (`tron-rpc-future-solid-head`); rejected evidence tries the next JSON-RPC provider rather than certifying catch-up. Cached heads are rechecked. If stale evidence cannot be replaced by an admitted fresh head, the scan retains the stale-head reason and cannot advance through event-API fallback. The admitted solidified head and existing 15-minute indexing margin both constrain the timestamp frontier; event-API fallback is clipped to the admitted solidified ceiling when available. Timestamp lookup seeds a bracket using the nominal three-second block interval, widens it if necessary, then searches validated block timestamps for the exact boundary. The estimate never becomes a cursor or a coverage claim.
- Tron JSON-RPC `logIndex` is block-global, while the retained event ID uses TronGrid's transaction-local `event_index`. A bounded full-block log read must prove contiguous global indices and matching event context before deriving that local index; observed `transactionIndex` is persisted for cross-transaction ordering. Block-header hashes bind timestamps. Incomplete or oversized single-block context cannot advance the RPC frontier, and fallback rows retain the existing identity and repair rules.
- Tron current-balance reads and unresolved event-amount replay still use TronGrid. Event-API pagination URLs are origin/path validated before credentials are forwarded. Transfer replay binds every hop to the initial URL's exact encoded account pathname; changed accounts and extra path segments are refused before fetching, even if the destination would return an empty page. Fingerprints may advance pagination without changing token, time, order or confirmation filters.

A full 200-row TronGrid page without a validated continuation is incomplete, not a terminal page. It retains parsed rows but cannot certify the safe timestamp frontier.

All credentials in `worker/src/lib/env.ts` are optional at the type boundary:

| Variable            | Purpose                                 |
| ------------------- | --------------------------------------- |
| `ETHERSCAN_API_KEY` | Explorer log and historical-call access |
| `TRONGRID_API_KEY`  | Higher-limit TronGrid access            |
| `DWELLIR_API_KEY`   | Admitted native and EVM RPC reads       |
| `DRPC_API_KEY`      | Archive-capable EVM balance lookups     |
| `ALCHEMY_API_KEY`   | Preferred chain RPC endpoints           |

Missing or unhealthy providers reduce the paths available to the affected config; they must surface through coverage outcomes, circuit state, and cron health rather than silently advancing an unproven cursor.

Run-level coverage is three-state per config in `metadata.coverageVerdicts`: `covered`,
`lagging-within-tolerance`, or `failed`. `BLACKLIST_COVERAGE_LAG_TOLERANCE_BLOCKS` in
`worker/src/cron/blacklist/config-scan.ts` is the sole tolerance authority (64 EVM blocks).
The bound accommodates the measured 2–52-block residuals in otherwise successful scans.
Tolerance requires every topic covered, finite integral frontier/head evidence, no API error,
and only `behind-safe-head` as the incomplete reason. Unknown frontiers, missing topics,
provider/decode failures, Tron timestamp lag, and residuals above the bound remain failures.
Run metadata retains uncapped verdict/count evidence plus the bounded `coverageFailureConfigs`
diagnostic samples, including tolerated residuals. Only failed coverage degrades an otherwise
healthy run; budget/circuit/state errors retain their independent degradation.
Tolerance never certifies full catch-up: durable config success clocks and producer full-coverage
freshness still advance only at the proven safe head, not at a tolerated frontier.


## Event And Coverage Rules

`worker/src/lib/blacklist-contracts.ts` is the only registry for event signatures, topic hashes, address/amount decoding indices, array encodings, direction booleans, and deployment start blocks. Reviewed event arrays are composed directly; configurations still clone their event lists. Parsing is implemented in:

- `worker/src/cron/blacklist/evm-source.ts`
- `worker/src/lib/blacklist/evm-payload.ts` for the registry-defined payload decoding shared by EVM ingestion and destroy receipt recovery; identity/timestamps and receipt matching remain caller-owned
- `worker/src/cron/blacklist/tron-source.ts`
- `worker/src/lib/blacklist/shared.ts` for the shared row construction and suppression contract both sources use

The durable rules are:

1. Registry-defined topic/data/array/Tron fields determine decoding. Batch addresses expand to deterministic per-address rows; oversized batches are never truncated. Incomplete persistence withholds coverage beyond that block.
2. Malformed required addresses (including non-zero ABI padding), ABI booleans (only `0`/`1`), arrays or log identities are typed failures, never default freezes. Ingestion and receipt recovery use the same payload checks. The frontier holds before the failed block/millisecond for two distinct scans; a third scan may release it only after durable bounded evidence is written under `blacklist:decode-retry:<config>:<identity>`, without TTL. The record keeps the original reason, truncation flag and exhausted disposition; repeated observations in one run do not consume attempts. Valid empty arrays are complete. `decodeRetryCounts` reports retained per-config debt.
3. Prefer an emitted destroy/seize amount. Ingestion, scheduled recovery and admin remediation prove amountless EVM freezes/releases with raw-integer `balanceOf` reads at blocks `b-1` and `b`, plus all affected-account `Transfer` logs in `b`. Two topic-filtered queries deduplicate `(txHash, logIndex)`; self-transfers net to zero. The full ledger must reconcile exactly with the closing balance before replaying transfers strictly before the canonical event log. Ambiguous identities, negative intermediate balances or unreconciled evidence are terminal `event_time_unreconciled`; provider failures remain retryable. Success stores `historical_balance`, including measured zero. Reads bind block numbers: scans ingest only blocks behind the 15-minute safe-head margin, and retained rows lack block hashes. Admitted balance/log RPC routes batch the four reads into one request; Etherscan stays at four sequential calls, and fallback costs extra. Proofs retain a sixth-subrequest reserve: ingestion tries the ten newest rows per config batch, then post-scan repair pages by budget/deadline with a 500-row repair ceiling; deferred rows stay pending and queued. Destroy recovery still requires one unambiguous emitted amount, never a burn-shaped transfer alone; missing receipts retry. History replay retains its separate emitted-amount requirement.
   Scheduled repair automatically queues unsuppressed, permanently-unavailable EVM freeze/release rows with `event_time_unproven` for at most three re-review attempts. Pending/provider-failed re-reviews keep that event status/error, outside missing-amount gap statuses; the queue retains provider errors and backoff. Proof failure or exhausted retries terminates the queue. Exact-state CAS permits only this legacy permanent-to-resolved transition and pairs it atomically with queue completion. Suppressed and other permanently-unavailable rows stay untouched; no migration or operator step is required.
4. Tron replay derives a freeze amount from complete confirmed signed token flows through the freeze millisecond. It requires the exact freeze receipt, unique composite transfer identities, no shared-millisecond transfer, and a complete ledger reconciling exactly with `balanceOf` reads bracketing the same solidified head. Negative freeze balances or duplicate records are rejected, even when offsetting duplicates leave the final balance unchanged. Writes require the amount still to be null and never overwrite snapshots or operator repairs.

Transfer and quiet-settle windows must retain their filters, complete pagination and a minimum page response time at or after their proof boundary. A landing transfer or stale response is a state race, not a mismatch or counted attempt. TronGrid's [`meta.at`](https://developers.tron.network/reference/get-trc20-transaction-info-by-account-address) is a response timestamp, **not** indexed coverage: fresh timestamps and matching net flow cannot independently exclude omitted offsetting transfers; replay still trusts provider completeness.

Both transfer-ledger and quiet-settle reads require a short terminal raw provider page. A page with at least 200 records and no continuation is retryable `provider_null` evidence, including when non-transfer records would be filtered out; it cannot yield or persist a recovered amount. This is not deterministic `history_over_cap`, which remains reserved for explicit page-cap truncation with continuation. Valid short terminal pages, per-page metering and quiet-settle bounds are unchanged.

A Tron replay zero additionally requires positive-value pre-freeze activity, nonnegative ordered history, and a complete confirmed window of **every configured destroy family** excluding the address through the balance-proof boundary. Empty/zero-only histories, matching destroys, missing families and incomplete/stale/malformed windows cannot prove zero. Proven zeroes use `trongrid-transfer-replay-zero` (operator repairs append the evidence hash) and do not re-enter legacy-derived-zero retries.

Destroy proof uses each family's configured victim key and same-origin/contract pagination preserving confirmation, family and time filters. It shares the replay page budget; failed/rejected pages count too. Stale evidence is `state_raced`, runtime stops are `runtime_budget` (neither consumes an attempt), invalid provider data is `provider_null`, and matching destroys or exceeded evidence caps are `evidence_mismatch`. Operator zero repair reads this window live even in dry-run and audits request URLs, minimum watermark, pages and outcome alongside the capture hash.

`shared/lib/blacklist-event-order.ts` owns execution order: timestamp/block, numeric EVM log index or proven Tron `transactionIndex`, then event/array position. Transaction hashes are never execution order. Conflicting same-address/block Tron effects with missing/contradictory positions remain `tron-cross-transaction-order`: unknown amounts, excluded from confirmed active counts and snapshot/rebuild candidates. Same-direction repetition is unambiguous; a later ordered transition may resolve state, but repairs never fall back before the conflict. All folds retain relevant address history; admin limits count canonical addresses, not transitions. Night Watch's lexical ordering is only for its immutable manifest hash.

RPC timestamp caches are block-hash-bound (`0267`); unknown/mismatching hashes are refetched and log/header fork disagreement leaves the frontier unresolved.

`worker/src/lib/blacklist/tron-order-recovery.ts` enriches at most eight conflicting blocks per maintenance pass using confirmed block number/time, unique transaction hashes and exact stored membership. Missing proof remains NULL. Serial requests share the limiter, circuit, maintenance deadline and subrequest budget; provider failures back off, while clean but unprovable blocks park for a week so they cannot starve later work. Durable `blacklist:order-retry:<block>` state is removed only on resolution. `tronOrderBlocksAttempted`, `tronOrderPositionsResolved` and `tronOrderBlocksDeferred` expose progress. Apply migration `0254` before the Worker; verify positions and a fresh summary after cache expiry, without rewinding cursors. Order repair does not infer historical amounts or rewrite retained snapshots. Freeze-then-destroy is confirmed blacklisted with destroyed funds, not active frozen value.

`worker/src/lib/blacklist/tron-amount-recovery.ts` uses the durable amount-repair queue, least-attempted first, under the same circuit/runtime/subrequest fence: at most 24 rows, 40 history pages per row and 120 pages per run, including destroy proof and failed requests. Provider failures/unreconciled ledgers retry normally; over-cap history, shared milliseconds, duplicate transfers and unusable configs park for seven days and remain unresolved for operator review. Freezes younger than 15 minutes, closed runtime windows and state races remain untouched without counted attempts.

For a bounded operator repair, `npx tsx worker/scripts/repair-tron-blacklist-amounts.ts --evidence <file>` validates an immutable official TronGrid capture and reads the exact unresolved D1 rows without mutation. Its version-1 evidence envelope contains `provider`, `capturedAtMs`, and at most eight entries with `event`, `anchor` (confirmed blocks bracketing the raw `balanceOf` response), `freezeReceipt`, and `history` (initial URL and every requested page/response). Full history starts at timestamp zero and ends at the anchor block, retains contract/confirmation/order filters across pagination, and has at least 15 minutes of indexing runway. Evidence must be at most 15 minutes old; the balance anchor may be at most 45 minutes old to accommodate collection and indexing. The validator rejects mismatched receipts, changed anchor blocks, unfinished pagination, duplicate records, negative intermediate balances, unsupported history event types, unproved transfers at the freeze timestamp, and any discrepancy with the raw confirmed balance. A shared-timestamp transfer in a different transaction requires optional `freezeBlock` (the confirmed block with its ordered transaction IDs) and `boundaryReceipts`: the block must match the freeze number/time and contain both unique transactions, and a successful same-block receipt must uniquely prove the exact token, sender, recipient, and raw transfer amount. The validator then places that transfer before or after the freeze by transaction position. Same-transaction transfers remain ambiguous without log-order proof. It subtracts post-freeze net transfers using integer token units, so later deposits are not mistaken for the frozen event amount.

Live repair requires `--execute --confirm repair-tron-blacklist-amounts`. The command captures a fresh Time Travel bookmark and uses one atomic D1 SQL import for the row-count guard, audit, exact-null event updates, and canonical derived-cache invalidation. Reconstructed values are marked `amount_source=derived`, with the immutable evidence SHA-256 in provenance and `admin_action_audit`. It does not overwrite existing amounts or change current balances, cursors, thresholds, or health checks. Re-running against resolved rows refuses mutation; preserve the evidence file with the audit/bookmark for review. Use this path for rows the scheduled replay refuses — a ledger that never reconciles, a history longer than the replay page cap, or a shared-millisecond transfer — and never as a substitute for the scheduled lane.

5. Non-USD event valuation requires a historically attributed quote for that event, not the repair-time `price_cache` quote. The ingestion and automated/manual recovery lanes currently have no such historical quote source: they recover native amounts but retain null event-time USD. Fresh coin-specific quotes remain valid for current-balance observations only.
6. Circle mirror actions can produce auditable zero-balance EURC rows. Mirror suppression requires an emitted event-time zero (`amount_source=event`), never a preceding-block, current-balance or legacy-derived zero. `circle_mirror_zero_balance` rows remain stored but are excluded from public events, active records, and frozen-value aggregates.
7. Seize-only BUIDL coverage records destroy events; it does not create an active blacklist/freeze state.

PAXG Ethereum scans both historical `AddressFrozen` / `AddressUnfrozen` and current
`FreezeAddress` / `UnfreezeAddress` topics, with one shared amountless `FrozenAddressWiped`
definition. Avalanche USDT uses indexed `BlockPlaced` / `BlockReleased` /
`DestroyedBlockedFunds` events from its deployment block; its history does not use the legacy
Tether family. Arbitrum and Polygon USDT retain both families for historical replay.

Explicit current limitations also remain source-tested:

- RLUSD clawbacks are not event-covered because the verified ABI has no dedicated clawback event. Supporting them would require transaction-input classification.
- USDA role-gated burns are not mapped to destroy rows because the contract does not emit the configured Tether destroy event.
- Binance-Peg USDT on BSC and legacy bridged USDT on Optimism are not scanned: their verified
  contracts do not emit blacklist events. Optimism's separate USDT0 deployment remains scanned.
  Removing a non-emitting scan does not delete stored event history or cursor rows.

Canonical coverage and parser tests live in:

- `worker/src/lib/__tests__/blacklist-contracts.test.ts`
- `worker/src/cron/blacklist/__tests__/blacklist-contracts.test.ts`
- `worker/src/cron/blacklist/__tests__/evm-source.test.ts`
- `worker/src/cron/blacklist/__tests__/evm-source-coverage.test.ts`
- `worker/src/cron/blacklist/__tests__/tron-source.test.ts`

## Storage Semantics

The migration files and `worker/migrations/MANIFEST.md` are the exact schema and index inventory. This section owns semantics, not copied SQL DDL.

Tron order recovery's pending-position reads, remaining-conflict checks and balance-debt capture share an exact chain/block access path. This non-unique index does not change stored ordering, provenance, semantic identity or public pagination; those existing indexes remain authoritative. Assess mixed-chain plans and index storage/write cost before rollout, then observe the first maintenance execution under the [migration rollout requirements](../../worker/migrations/MANIFEST.md#rollout-safety). Worker rollback leaves the additive access path installed.

EVM timestamp cache writes require an atomic header with the exact requested block number, a 32-byte hash and a positive safe-integer timestamp. Duplicate response IDs invalidate their member before projection; out-of-range IDs cannot contribute evidence. Missing or malformed members retry within the existing request budget, and an expected log hash must match before caching. This does not rewrite historical cache rows or renew their freshness.

### Event History

`blacklist_events` records:

- `blacklist`, `unblacklist`, and `destroy` transitions;
- stablecoin, chain, contract/config, transaction, block, and event-signature provenance;
- authoritative `amount_native` and justified `amount_usd_at_event` values;
- the deployed legacy `amount` column remains pending a separately operated schema cleanup; normal ingestion/recovery and the operator tools (`worker/scripts/repair-tron-blacklist-amounts.ts`, `worker/scripts/reconcile-blacklist-events-from-kyc-rip.ts`, `worker/scripts/reconcile-night-watch-blacklist.ts`, `worker/scripts/replay-blacklist-config-history.ts`) read/write canonical amount fields only;
- amount source, resolution status, recovery attempts, provider, and bounded error diagnostics;
- optional suppression reason for audit-only rows.

Canonical repair eligibility ignores legacy `amount`; exact identity, canonical-null/state/suppression, evidence freshness/hash, atomic row-count audit and Time Travel guards still apply. Re-review old plans where legacy `amount` is populated but canonical values are null; prior signed/generated SQL is not approval under that eligibility. JS input `amount` remains an evidence-derived quantity, not a database alias. Neither legacy values nor current balances prove event-time USD.

Scheduled EVM recovery and admin remediation compare the selected canonical amount, source/status, attempt generation, contract/config identity and evidence provenance before writing either success or failure. Suppressed rows are ineligible. A concurrent operator repair wins without losing its amount or provenance. This exact-state guard permits reviewed legacy-derived-zero retries and provenance-only repairs; a blanket null-amount guard would strand those candidates.

The event-position admission rule does not rewrite existing resolved amounts or blindly unsuppress historical mirror rows. Re-review previously suppressed/approximated rows only with sufficient ordered same-block evidence; a preceding-block zero alone cannot establish either an empty freeze or a mirror action. Current-balance snapshots remain a separate observation and continue to be read normally.

Before any column drop, reconcile/export legacy-only identity/value tuples, obtain external SQL/schema-owner signoff, retain a durable R2 export indefinitely and record a pre-window Time Travel bookmark. The compatible tool/Worker release must establish the rollback floor and pass its first six-hourly sync/API soak. DROP or a rehearsed identity/default/index/FK/repair-queue-preserving rebuild is a separate destructive release, not part of this cutover. Post-drop rollback requires compatible tools or verified schema/data restoration; Worker rollback alone cannot restore the column.

Normal EVM row identity is `{chainId}-{lowercaseTxHash}-{minimalHexLogIndex}`; expanded arrays retain numeric element suffixes. An indexed semantic identity also admits retained decimal/padded-hex spellings without inserting another event generation. The shared public-event predicate excludes equivalent duplicates immediately; reconciliation retains redundant history as `duplicate_log_identity` audit rows without changing event IDs or repair-queue references.

The KYC event-repair operator deduplicates Ethereum freeze candidates by stablecoin, chain, contract, transaction and affected address, not by address history alone. A later refreeze transaction still reaches the exact receipt parser after an earlier freeze/release pair. Receipt evidence must match the configured contract, requested transaction, address and blacklist event family; `INSERT OR IGNORE` remains the final guard against repeated canonical event IDs.

The guarded [config-history replay](#config-scoped-historical-topic-recovery) recovers missing current-family EVM events inside an explicit inclusive window ending at or below the existing cursor; it never rewinds or advances cursors. It reuses the canonical parser, semantic identity and insert builder. A single atomic import records an `admin_action_audit` entry, evidence SHA-256/run/tool provenance on inserted rows, affected contract-scoped lifecycle/balance rebuilds and canonical summary/gap-cache invalidation. The writer pause, inactive sync lease and in-transaction cursor-generation/missing-identity guard protect publication; existing events remain untouched. Immediately before import, the tool captures a Time Travel restore point for stdout, hashed evidence and the durable audit. The bookmark is recovery evidence, not a global concurrency token; unrelated D1 writes do not invalidate it.

Tron ingestion, existing-row folds and snapshot keys use validated lowercase `0x` byte identities for Base58/`41`/`0x` inputs. Base58 is never case-folded for account identity; it is derived only for provider calls and exact historical spelling lookups. SQL retains relevant Tron rows for the canonical fold. Snapshot consolidation atomically preserves the newest successful value and removes representation-only aliases, respecting the writer pause.

`identity-reconciliation.ts` runs before summary materialization, paging at most 100 events and 100 Tron snapshots with durable keyset cursors. Each call reads two cursors, two indexed pages and at most 100 bounded alias sets; `0267` indexes avoid inventory rescans. Only changed addresses, newly suppressed duplicates or unconsolidated snapshots write rows; cursors still wrap to catch operator imports. Public folds remain canonical during cutover.

Canonical event rows retain these amount-source meanings:

- `event`: amount emitted by the event.
- `historical_balance`: bracket-reconciled EVM event-position balances and retained legacy balance-read attribution; a preceding-block read alone cannot admit a new amount.
- `unavailable`: no defensible amount.

`current_balance_snapshot` is retained for legacy read compatibility only. Current snapshots live in `blacklist_current_balances` and are never written into event-time columns.

`derived` is written by confirmed Tron transfer-replay recovery, not by initial event ingestion. Eligible unresolved rows enter the durable repair queue. Legacy derived-zero rows receive bounded recovery attempts before becoming permanently unavailable. `legacy_migration` records historical amount provenance only; it does not indicate a remaining identity repair.

`data-invariant-canary` reports an error if either event or balance rows lack both `config_key` and `contract_address`. `syncBlacklist()` does not rescan or rewrite that legacy identity set; investigate any non-zero count as an invariant failure.

### Freeze Ledger

`blacklist_current_balances` is a persistent, contract/config-scoped last-known snapshot ledger. It feeds:

- `trackedFrozenTotal`
- `trackedAddressCount`
- `trackedAmountGapCount`

Provider refresh failures preserve the last successful value (including observed zero) and its successful-observation clock while updating failure/attempt metadata. Net-active hydration uses this retained successful evidence even when the latest attempt is `provider_failed`; it falls back to an EVM event-time amount, or unavailable on Tron, only without a successful ledger value. A failed first read is not successful evidence, and failed refreshes do not renew freshness or turn a known total into zero.

Gold zero-read substitution applies only after an actual observed zero and a positive event-native amount; the ledger records `source=gold_event_zero_balance`. A null gold provider read is still `provider_failed` and preserves the previous value and successful-observation timestamp.

Before cursor finalization, capture work (including budget-skipped and order-withheld rows) is retained without TTL in D1 `cache` under `blacklist:current-balance-debt:`. The maintenance tail admits at most 24 debt rows, respecting the same runtime, subrequest budget, serial limiters and provider circuit gates. Quiet scans can reconcile missing snapshots without rewinding cursors. Successful Tron block-order recovery also enqueues affected rows, including pre-deploy conflicts; release markers preserve prior ledger captures and destroy snapshots use the emitted historical value.

The summary loader reads the complete retained ledger — released addresses, destroy snapshots, and legacy rows whose successful-observation timestamp is NULL or old — so historical rows keep feeding the tracked totals and the quarterly chart. Their age surfaces through `freezeLedgerMeta` freshness distributions and provider-failure counts rather than rows silently disappearing from totals.

Unblacklist events do not delete historical snapshot rows. Destroy events may replace a stored amount with a better emitted seizure/burn amount. When a blacklist and release arrive in the same batch, the blacklist snapshot is still captured before the release marker is treated as non-deleting.

Operator rebuilds and KYC current-balance admission also preserve this complete ledger. They use runtime contract/config identities and the same last-known-value upsert policy, stage every observation before any authoritative write, and publish scoped upserts with canonical summary/gap-cache invalidation in one file transaction. A failed admission cannot remove or partially replace retained rows; rows absent from the active/provider set are not deletion candidates. The [balance-maintenance procedure](#blacklist-current-balance-rebuild) owns staging, failure recovery, and writer-pause handling.

The shared KYC input validator admits only finite, nonnegative decimal balances (including exponent notation and explicit numeric/string zero). It trims surrounding whitespace, rejects empty/whitespace-only, negative, nonnumeric and alternate-base strings, and counts rejected rows as malformed rather than successful zero observations. Current-balance reconciliation and Night Watch consume this same admission authority; rejected observations leave prior successful balances and timestamps intact.

Legacy `activeAddressCount`, `activeFrozenTotal`, and `activeAmountGapCount` remain in `/api/blacklist-summary` for wire compatibility. They represent the local net-active event state, not the public historical freeze-ledger total. Retained successful balances do not reactivate released addresses or add destroyed balances to the active frozen total; those snapshots remain part of the historical ledger.

### Cursor State

`blacklist_sync_state.last_block` stores EVM block numbers or Tron millisecond scan timestamps, never interchangeable units. State also retains attempt generations, outcome timestamps, streaks, and safe-head evidence.

A config attempt claims its starting cursor and increments `attempt_generation`. Finalization succeeds only when the generation and starting cursor still match, preventing a late writer from overwriting newer progress. EVM config keys canonicalize the contract address to lowercase while reads retain compatibility with legacy mixed-case rows.

EVM cursors advance only through the minimum contiguous block proven across every required topic. Missing-topic or partial coverage pins the unproven tail. Tron cursors remain millisecond timestamps: RPC scans map the cursor to observed block timestamps, and advance only after every configured event family completes through a contiguous safe timestamp frontier. A provider switch never reinterprets the stored value as a block number.

A fully scanned bounded EVM subrange is contiguous progress, not current coverage: until its frontier reaches the observed safe head, the outcome is incomplete and the success clock is retained. Summary materialization may refresh observed totals during catch-up, but cannot renew coverage freshness. The producer snapshot's `refresh` names the rebuild time and every config behind its safe head; catch-up is a `degraded` operator finding, so public pages show no notice while those totals are within budget ([ADR-42](../architecture.md#adr-42)). Cron metadata reports `configLag` with the frontier, observed safe head, cursor kind and remaining lag (blocks or milliseconds). Avalanche fallback scans admit up to eight serial 2,000-block provider windows per config (16,000 blocks per run), exceeding the assumed 10,800-block six-hour chain growth without increasing any individual request range.

Cron metadata also retains `coverageFailureConfigs`: at most six current-run source scans with non-complete/non-quiet outcomes, including their config key, outcome, cursor kind, observed frontier/safe head/lag, and existing bounded failure samples. EVM cursor units are blocks; Tron cursor units are milliseconds. Unavailable observations stay null. This is diagnostic detail, not a relaxed coverage verdict or an exhaustive failure count: source skips, exceptions, or state conflicts without a returned source result remain in their existing counters and reasons. Use `coverageFailures` for the aggregate and the sampled entries to investigate the source shortfall.

## Producer Flow

Each run performs these phases under one scan deadline, one separately capped maintenance tail, and one shared subrequest budget:

1. **Fair admission:** load typed config states, order cohorts by oldest attempt, alternate equal-age EVM and Tron work, and claim the generation-fenced attempt.
2. **Safe scan:** resolve the safe head using the 15-minute indexing margin and, for Tron RPC, the observed solidified head; scan bounded windows, validate provider coverage, and parse rows.
3. **Historical enrichment:** enrich only defensible event amounts before insertion. Duplicate event IDs skip unnecessary enrichment and cache work.
4. **Persistence and cursor finalization:** insert event rows before advancing the claimed cursor; incomplete coverage never advances beyond its proven contiguous frontier.
5. **Freeze-ledger refresh:** snapshot newly blocked addresses and preserve last-known values across provider failures. The snapshot is current-state ledger data only; it never supplies an event-time Tron amount.
6. **Bounded maintenance:** retry durable amount repairs before other maintenance, replay unprovable Tron freeze amounts from the confirmed transfer ledger, migrate unambiguous legacy identities, and leave ambiguous same-symbol/same-chain identities explicit. If scans consume their full 10-minute budget, amount repair retains a 10-row ceiling and runs only while its own earlier deadline leaves room for the other maintenance stages. Repair reads 100-row pages up to 500 attempted EVM rows, stopping early to reserve the existing 45-second maintenance allowance plus the snapshot window for later stages; this is partial repair, not runtime exhaustion. Both paths reuse the scan's subrequest budget and serial provider limiter, so maintenance does not increase connection concurrency or consume scan time. The Tron replay lane is capped at 24 rows and 120 history pages per run, needs TronGrid only (it runs even when the Etherscan circuit is open), and reports its own `tronAmountRepair*` outcome, reason and counters in run metadata (null counters mean the lane failed or was skipped, not that it found no work).
7. **Publication and telemetry:** refresh the summary from persisted observations when enough maintenance/subrequest budget remains, independently of the overall ingestion status. A failed or catching-up config cannot block other configs' observations from reaching the summary. Freshness still uses the oldest required config success, never the materialization or cron completion time; if any required config has never succeeded, summary freshness is explicitly missing. Gap producer snapshots require that retained full-coverage timestamp; otherwise the summary reads gap metrics through the existing query path. Ingestion status and incomplete-coverage warnings remain conservative. Exhausted budgets still withhold snapshots, and failed aggregate reads never overwrite the retained summary. A publication exception degrades the run with `blacklist-snapshot-publication-failed` rather than reporting `ok`.

EVM maintenance commits each event compare-and-set and its queue completion in the same bounded atomic batch. A lost event comparison leaves the queue untouched, and repair outcome counters include only changed event rows. Admin remediation likewise reports applied changes, not merely provider responses, and does not invalidate derived caches for an entirely stale write set.

Provider telemetry retains bounded config-level mode, coverage, frontier, count, call-depth, and failure-sample evidence. The operational response is documented in [Runbook: Blacklist Sync](#first-checks).

RPC failover samples preserve the provider's failure reason (for example, `primary-failover:split-limit`); `primary-failover:no-coverage` is used only when the primary proves no contiguous coverage without a specific reason. Serial catch-up windows retain that diagnostic while merging their covered frontier.

## Telegram Freeze Alerts

PharosWatchBot consumes explicit, unsuppressed transitions only after the 30-minute Tape projector writes immutable `freeze.blocked`, `freeze.unblocked`, or `freeze.destroyed` rows.

New Tape payloads carry the canonical stablecoin ID resolved from the verified `config_key`. Legacy symbol-only rows are accepted only when the symbol is unique. The consumer fails closed when the latest successful Tape projection is older than 60 minutes and cold-seeds without replay when its cursor is absent.

Worst-case source latency is the six-hour tracker scan plus the 30-minute Tape projection and five-minute Telegram poll. Alert messages keep both Tape and source event identities and describe a missing historical amount as unavailable, not zero. See [Telegram Alerts](../telegram-alerts.md#freeze-alert-source-and-cadence).

## API And Operator Contract

The API reference is authoritative for parameters, schemas, cache/freshness headers, status codes, and admin mutation contracts:

- [`GET /api/blacklist`](../api-reference.md#get-apiblacklist)
- [`GET /api/blacklist-summary`](../api-reference.md#get-apiblacklist-summary)
- [`POST /api/reset-blacklist-sync`](../api-reference-admin.md#post-apireset-blacklist-sync)
- [`GET /api/debug-sync-state`](../api-reference-admin.md#get-apidebug-sync-state)
- [`POST /api/remediate-blacklist-amount-gaps`](../api-reference-admin.md#post-apiremediate-blacklist-amount-gaps)
- [Historical current-balance operator CLI](./one-shot-backfills.md#backfill-blacklist-current-balances)

Public event queries exclude rows with a suppression reason. Accepted filter symbols come from `BLACKLIST_STABLECOINS`; supported/deferred deployment coverage comes from the runtime coverage manifest. Summary coverage fields are contract/config-level and must not be relabeled as symbol-level coverage.

Use the admin actions and decision order in [Runbook: Blacklist Sync](#first-checks). A generic amount gap is not evidence that a cursor reset is appropriate.

## Frontend Contract

- **Route:** `src/app/freezewatch/page.tsx`
- **Queries:** `src/hooks/use-blacklist-events.ts`
- **Query policy:** `src/lib/api-query-descriptors.ts`
- **Shared response types:** `shared/types/market.ts`

The summary query supplies aggregate cards, exposure drilldowns, chart data, and filter metadata. The event query supplies the current server-filtered, sorted, searched, and paginated ledger slice. Both endpoints use the same six-hour producer freshness source.

FreezeWatch assesses blacklist summary, blacklist ledger, supply, and report-card freshness independently, retaining each source's receipt time, error and original producer metadata under its own preset budget. Fresh blacklist data cannot renew supply or score evidence; support failures name the affected source, and only the blacklist summary carries scan catch-up context. First-read support loading is not an unavailable warning, while failed refreshes retain valid saved values with a notice.

The coverage lattice and intervention seismograph admit summary data before making coverage or count claims. Pending reads show loading; absent evidence shows unavailable with a summary retry; failed refreshes preserve saved summary facts with an explicit notice. Only a successful empty summary can establish zero quarterly events or no live coverage configurations.

A missing ungrouped aggregate row is a failed read, not a measured empty cohort. Gap metrics and summary materialization reject it with `blacklist-gap-aggregate-missing` or `blacklist-summary-aggregate-missing`; no fabricated summary snapshot is written. On a cold request the summary API responds 503/no-store with that reason. Successful aggregates with an observed zero count retain empty-cohort semantics.

`dataQuality.ambiguousOrderCount` counts unresolved contract-scoped active-state records excluded from confirmed counts. `dataQuality.ambiguousOrderReason` is `tron-cross-transaction-order` when that count is positive, otherwise `null`; the same reason appears in `warnings` and degrades quality. Both fields are additive/optional for retained old summaries; missing fields mean legacy unknown coverage, not a measured zero. Tracked ledger totals remain retained snapshots, not a claim that ambiguous current state is resolved.

Summary USD aggregates (`destroyedTotal`, recent freeze amounts, and per-coin frozen/destroyed totals) are nullable and carry `stats.valuationCoverage` known/unavailable observation counts. All-unpriced cohorts publish null; mixed cohorts publish the known subtotal explicitly labelled partial; observed zero remains zero. An empty cohort publishes zero with zero observations. Current producer snapshots require valuation coverage; optional coverage on legacy public payloads means unknown coverage, not complete valuation. The same qualification is used by FreezeWatch cards, the coverage lattice, homepage recent freezes, and coin detail cards, even when unresolved values are permanently unavailable and general quality otherwise reads healthy.

The page must preserve these distinctions:

- missing or unresolved amounts display their status/source instead of a confirmed zero;
- native amounts below the ordinary two-decimal precision (four for gold tokens) use three significant digits so nonzero observations never display as zero; event-time USD values remain separate and are never inferred from a current price;
- non-USD current-balance observations may use a fresh coin-specific price, but historical events require an event-time quote and stay unavailable without one;
- tracked frozen totals are last-known freeze-ledger snapshots;
- event history and local net-active state remain separate from those snapshots;
- mobile cards and desktop table share server filters/sort; cursor navigation retains previous-page cursors and resets on ledger filters/sort;
- a lattice cell selects its stablecoin and chain together in one URL replacement, preserving the other filters and the existing hash-aware URL writer; the combined ledger key resets cursor navigation once;
- CSV export represents only the currently loaded server page.
- CSV native amounts serialize the actual finite number without locale grouping or display rounding, with separate native-unit and USD-at-event columns; unavailable or non-finite native values leave an empty cell;
- stablecoin filters group only explicit per-coin zero event counts as tracked without events; missing keys remain unknown and selectable, and an existing selection stays visible as summary counts change;
- an empty chart means no valued ledger snapshots, not no recorded events; failed summary reads remain unavailable.

Stablecoin detail visibility is derived by `src/lib/stablecoin-detail-view-model.ts`. A tracked symbol needs at least one real, non-suppressed event before the Activity and History blocks appear. The component entrypoints are `src/components/stablecoin-detail/blacklist-section.tsx` and `src/components/stablecoin-detail/blacklist-detail-event-feed.tsx`.

## Maintenance Checklist

When changing blacklist coverage or behavior:

1. Edit the canonical registry, manifest, parser, or schema owner rather than this document's prose inventory.
2. Add focused parser and coverage tests for every new event layout or deployment.
3. Preserve contract/config identity, contiguous coverage, amount provenance, and last-known snapshot semantics.
4. Update the methodology version and structured changelog only when user-visible methodology changes.
5. Update the API reference for wire-contract changes and the sync runbook for operator-procedure changes.
6. Run:

   ```bash
   npm run check:verified-doc-links
   npm run check:generated-artifacts -- --only=api-reference
   npm run check:cron-connections
   ```

## Blacklist Sync State Semantics

See [Cursor State](#cursor-state) for chain-specific units and contiguous-frontier rules.
