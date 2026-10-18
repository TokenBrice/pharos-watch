# Blacklist Tracker

Multi-chain blacklist/freeze event tracker for stablecoins. Every six hours, the runtime scans the live contract configurations in `worker/src/lib/blacklist-contracts.ts`; that registry owns the supported chains, symbols, and deferred deployments.

## Methodology And Ownership

- **Current methodology version:** <!-- GENERATED-START: methodology-version-blacklist-tracker -->`v4.3`<!-- GENERATED-END: methodology-version-blacklist-tracker -->
- **Version source:** `shared/lib/methodology-versions/registry.ts`
- **Public changelog:** `/methodology/blacklist-tracker-changelog/`
- **Structured changelog:** `shared/data/methodology-changelogs/blacklist-tracker/`

The 2026-10-10 `v4.3` release counts canonical account/log identities once and persists Tron accounts as validated lowercase `0x` bytes rather than provider Base58. Numeric local ordering and proven cross-transaction evidence govern lifecycle and amount state; matching block hashes govern RPC event timestamps. Bounded scan progress is not caught-up coverage and cannot renew success/publication clocks. Durable snapshot debt retries budget-skipped or ambiguous work. Unknown USD valuations remain unavailable, mixed totals disclose partial coverage, and gold totals include every canonical tracked cohort, including XAUM, with explicit provenance for zero substitution. Historical repair cannot use current quotes as event-time USD evidence. Classification thresholds and cadence are unchanged. Activation is provisionally 2026-10-11 00:00 UTC, re-dated at release; fixed-clock identity/ordering/valuation/coverage comparison remains required.

**Release obligations recorded 2026-10-10:** for v4.3, fresh admitted producer observations and production resource evidence remain separate gates from fixed-clock supply/valuation/coverage comparison; these prerequisites do not assert completed production replay or runtime health.

Three registries have deliberately different jobs:

- `CONTRACT_CONFIGS` in `worker/src/lib/blacklist-contracts.ts` is the cron-backed scan set. It owns tracker-specific chain, contract, start-block, event-family, topic, and decoding metadata.
- `BLACKLIST_STABLECOINS` in `shared/types/market.ts` is the API and UI filter universe. It may retain archived identities after a live scan is retired.
- `worker/src/lib/blacklist-coverage-manifest.ts` derives supported coverage and owns explicit deferred and out-of-scope deployment records.

Do not copy any of those rosters into documentation. Contract addresses and decimals resolve from the shared stablecoin registry except for explicit traded-contract or tracker-specific overrides in `blacklist-contracts.ts`.

Every stablecoin ID in `CONTRACT_CONFIGS` must resolve to direct `Freezable: Yes` metadata. `worker/src/lib/__tests__/blacklist-contracts.test.ts` enforces that boundary so direct tracker coverage cannot be mislabeled as only upstream exposure.

## Public Exposure Contract

The `/freezewatch/` exposure summary uses `buildBlacklistStatusBuckets()` and the same resolved four-state model as Report Cards:

- `yes`: direct issuer blacklist, freeze, seizure, or equivalent holder-facing control.
- `upstream`: the token has no direct `yes` or `possible` holder-facing freeze control, but strictly more than 50% of its reserve composition is exposed to assets or rails classified `yes`, `upstream`, or `possible`. Tracked parent/wrapper inheritance, full CEX custody, and custodial fiat reserves (per the scoping rules below) still resolve as upstream exposure.
- `possible`: a curated direct pause, blacklist, freeze, or mutable holder-facing control exists but is not confirmed as an active direct blacklist control.
- `no`: no exposure resolves under the current model.

Review scoping rules (owner ruling, 2026-09-29):

- **Upstream collateral counts only when an issuer or custodian controls it.** Exposed reserve
  assets or rails are issuer-freezable tokens (for example USDC, USDT, cbBTC, cbETH), custodian-pausable
  wrappers (WBTC), CEX custody, and custodial fiat reserves held at banks or fund managers. Collateral
  whose only control is DAO or protocol governance (an upgradeable or DAO-pausable token such as stETH
  and therefore wstETH, stake-pool LSTs such as jitoSOL) does not count toward the 50% threshold.
- **Direct controls on the stablecoin itself are not narrowed by that rule.** An admin-upgradeable
  token proxy, a governor that can authorize new burners or forced-transfer operators, and an
  issuer-shipped consensus change that has halted holder transfers all remain `possible` or `yes`.
  A rebase that can only increase balances is not a holder-facing control.
- **Deployment scope follows the Safety Score V9 materiality threshold**
  (`semantic.materiality.deploymentMaterialSharePct`). A control on a deployment below that share of
  circulating supply is recorded in the review evidence but does not set the verdict.
  The detail card's `Not freezable` note and static quick answers describe that materiality-scoped
  verdict, not an absence of controls on every peripheral deployment. Peripheral controls remain
  disclosed in the review notes even when they do not set the verdict.

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
`partial` replaces the freezable and unfreezable headline shares with `Partial`; the observed-only share,
observed totals and the "Observed supply only · N assets without supply data excluded" label appear in
secondary text, so a partial list can never read as a full-market 0% or 100%. Headline shares are
published only for `complete` coverage. A bucket whose every member lacks supply shows `—` for its value
and share; an explicit observed zero remains a real `$0`. The FreezeWatch data-quality notice also lists
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
With a [reviewed look-through graph](./access-lookthrough.md), graph authority/path diagnostics
take precedence: raw registry slices cannot fill partial, stale or unresolved graph branches or add
a second reserve failure-domain attribution. Independently reviewed declared-parent and local
facts remain. Without a graph, the largest qualifying reserve share wins, with lexicographic asset
id breaking ties; the existing structural disposition and bounded scoring state are preserved.

When the same current `inherited` verdict names **no** tracked upstream, the review is retained with
`structuralDisposition: "inherited-untracked-upstream"`: no `upstreamAssetId` and no failure domain
are asserted (the branch verifies neither), the freeze review keeps its `possible` reach, and the gap
is still the measured `inherited-access-exposure` rather than `missing-access-review`. Dropping that
review — the behaviour before the 2026-08-10 owner ruling — published assets such as `dai-makerdao`
and `crvusd-curve` as never reviewed and erased the exposure the reviewer had measured.

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
- **Provider limiter:** serial per-provider limiters — TronGrid at 3 requests per second, Etherscan at 4 requests per second injected by the scheduled slot (the producer's own 3/s default applies only when no external Etherscan limiter is supplied)

The producer returns `itemCount` as rows actually inserted into `blacklist_events`. Its `eventsFetched` metadata counts parsed rows before `INSERT OR IGNORE` deduplication. The remaining bounded counters and failure samples are defined beside `SyncBlacklistResult` and its metadata assembly in `sync-blacklist.ts`; do not duplicate that key inventory here.

The final retained-decode diagnostic read uses the shared abort-aware D1 transient-error retry policy (up to three retries), like cursor claims and finalization. A single D1 internal/overload error must not discard an otherwise completed scan's result while assembling `decodeRetryCounts`; exhausted retries and non-transient errors still fail the run.

Current-balance cache telemetry preserves the canonical `skippedDueBudget` count and `budgetExhausted` flag; neither is replaced by a synthetic deletion counter.

### Provider Paths

- Etherscan v2 is an explorer source for supported EVM log scans and a best-effort final historical-call fallback.
- Base, Optimism, Avalanche, BSC, and Gnosis prefer chain RPC `eth_getLogs`; chain RPC configuration comes from `worker/src/lib/chain-registry.ts`.
- Historical EVM balance lookup prefers dRPC when configured, then the shared chain RPC path, then best-effort Etherscan.
- Scheduled `logScanRpcEndpoints` puts Dwellir first on Gnosis (9,000-block pages; dRPC/public failover), Base/Optimism/Avalanche (10,000; Alchemy/public), independent of state placement. BSC is excluded (2026-10-13: one log mismatch, five null near-head headers). `DWELLIR_ROUTING_DISABLED_CHAINS` restores incumbents; mint/burn keeps Alchemy.
- Ranges use the smaller caller/provider span; incumbent windows stay unchanged. Range errors (including HTTP-200 `-32005`) split serially within depth/call/deadline budgets; incomplete ranges cannot advance cursors. Log/timestamp/receipt reads use registered auth and meter Dwellir members/retries. Retained endpoints reject starts before `head - retainedBlocks`; zkSync stays excluded. Transaction-context singleton retries honor abort/deadline/budget, capped at eight/batch; failures stay unavailable.
- Dwellir targets 100 serial log calls/config, up to 600 with ≥300 subrequests/≥240 s left in the shared 900-subrequest/10-minute budget (splits included). Reserve stops shorten targets, not coverage. Capacity: Gnosis 0.9–5.4M blocks/run; Base/Optimism/Avalanche 1–6M. Incumbent fallback spans: Base/Optimism Alchemy 500,000, public 50,000; Avalanche Alchemy 250,000, public eight ×2,000.
- Tron event scans and current-balance reads use TronGrid. Pagination URLs are origin/path validated before credentials are forwarded.

A full 200-row TronGrid page without a validated continuation is incomplete, not a terminal page. It retains parsed rows but cannot certify the safe timestamp frontier.

All credentials in `worker/src/lib/env.ts` are optional at the type boundary:

| Variable            | Purpose                                 |
| ------------------- | --------------------------------------- |
| `ETHERSCAN_API_KEY` | Explorer log and historical-call access |
| `TRONGRID_API_KEY`  | Higher-limit TronGrid access            |
| `DRPC_API_KEY`      | Archive-capable EVM balance lookups     |
| `ALCHEMY_API_KEY`   | Preferred chain RPC endpoints           |

Missing or unhealthy providers reduce the paths available to the affected config; they must surface through coverage outcomes, circuit state, and cron health rather than silently advancing an unproven cursor.

## Event And Coverage Rules

`worker/src/lib/blacklist-contracts.ts` is the only registry for event signatures, topic hashes, address/amount decoding indices, array encodings, direction booleans, and deployment start blocks. Parsing is implemented in:

- `worker/src/cron/blacklist/evm-source.ts`
- `worker/src/cron/blacklist/tron-source.ts`
- `worker/src/lib/blacklist/shared.ts` for the shared row construction and suppression contract both sources use

The durable rules are:

1. Registry-defined topic/data/array/Tron fields determine decoding. Batch addresses expand to deterministic per-address rows; oversized batches are never truncated. Incomplete persistence withholds coverage beyond that block.
2. Malformed required addresses, ABI booleans (only `0`/`1`), arrays or log identities are typed failures, never default freezes. The frontier holds before the failed block/millisecond for two distinct scans; a third scan may release it only after durable bounded evidence is written under `blacklist:decode-retry:<config>:<identity>`, without TTL. The record keeps the original reason, truncation flag and exhausted disposition; repeated observations in one run do not consume attempts. Valid empty arrays are complete. `decodeRetryCounts` reports retained per-config debt.
3. Prefer an emitted destroy/seize amount; an amountless wipe requires proven `balanceOf` at the preceding block. Current Tron balances belong only to the freeze ledger, never event-time amounts.
4. Tron replay derives a freeze amount from complete confirmed signed token flows through the freeze millisecond. It requires the exact freeze receipt, unique composite transfer identities, no shared-millisecond transfer, and a complete ledger reconciling exactly with `balanceOf` reads bracketing the same solidified head. Negative freeze balances or duplicate records are rejected, even when offsetting duplicates leave the final balance unchanged. Writes require the amount still to be null and never overwrite snapshots or operator repairs.

Transfer and quiet-settle windows must retain their filters, complete pagination and a minimum page response time at or after their proof boundary. A landing transfer or stale response is a state race, not a mismatch or counted attempt. TronGrid's [`meta.at`](https://developers.tron.network/reference/get-trc20-transaction-info-by-account-address) is a response timestamp, **not** indexed coverage: fresh timestamps and matching net flow cannot independently exclude omitted offsetting transfers; replay still trusts provider completeness.

A resolved zero additionally requires positive-value pre-freeze activity, nonnegative ordered history, and a complete confirmed window of **every configured destroy family** excluding the address through the balance-proof boundary. Empty/zero-only histories, matching destroys, missing families and incomplete/stale/malformed windows cannot prove zero. Proven zeroes use `trongrid-transfer-replay-zero` (operator repairs append the evidence hash) and do not re-enter legacy-derived-zero retries.

Destroy proof uses each family's configured victim key and same-origin/contract pagination preserving confirmation, family and time filters. It shares the replay page budget; failed/rejected pages count too. Stale evidence is `state_raced`, runtime stops are `runtime_budget` (neither consumes an attempt), invalid provider data is `provider_null`, and matching destroys or exceeded evidence caps are `evidence_mismatch`. Operator zero repair reads this window live even in dry-run and audits request URLs, minimum watermark, pages and outcome alongside the capture hash.

`shared/lib/blacklist-event-order.ts` owns execution order: timestamp/block, numeric EVM log index or proven Tron `transactionIndex`, then event/array position. Transaction hashes are never execution order. Conflicting same-address/block Tron effects with missing/contradictory positions remain `tron-cross-transaction-order`: unknown amounts, excluded from confirmed active counts and snapshot/rebuild candidates. Same-direction repetition is unambiguous; a later ordered transition may resolve state, but repairs never fall back before the conflict. All folds retain relevant address history; admin limits count canonical addresses, not transitions. Night Watch's lexical ordering is only for its immutable manifest hash.

RPC timestamp caches are block-hash-bound (`0267`); unknown/mismatching hashes are refetched and log/header fork disagreement leaves the frontier unresolved.

`worker/src/lib/blacklist/tron-order-recovery.ts` enriches at most eight conflicting blocks per maintenance pass using confirmed block number/time, unique transaction hashes and exact stored membership. Missing proof remains NULL. Serial requests share the limiter, circuit, maintenance deadline and subrequest budget; provider failures back off, while clean but unprovable blocks park for a week so they cannot starve later work. Durable `blacklist:order-retry:<block>` state is removed only on resolution. `tronOrderBlocksAttempted`, `tronOrderPositionsResolved` and `tronOrderBlocksDeferred` expose progress. Apply migration `0254` before the Worker; verify positions and a fresh summary after cache expiry, without rewinding cursors. Order repair does not infer historical amounts or rewrite retained snapshots. Freeze-then-destroy is confirmed blacklisted with destroyed funds, not active frozen value.

`worker/src/lib/blacklist/tron-amount-recovery.ts` uses the durable amount-repair queue, least-attempted first, under the same circuit/runtime/subrequest fence: at most 24 rows, 40 history pages per row and 120 pages per run, including destroy proof and failed requests. Provider failures/unreconciled ledgers retry normally; over-cap history, shared milliseconds, duplicate transfers and unusable configs park for seven days and remain unresolved for operator review. Freezes younger than 15 minutes, closed runtime windows and state races remain untouched without counted attempts.

For a bounded operator repair, `npx tsx worker/scripts/repair-tron-blacklist-amounts.ts --evidence <file>` validates an immutable official TronGrid capture and reads the exact unresolved D1 rows without mutation. Its version-1 evidence envelope contains `provider`, `capturedAtMs`, and at most eight entries with `event`, `anchor` (confirmed blocks bracketing the raw `balanceOf` response), `freezeReceipt`, and `history` (initial URL and every requested page/response). Full history starts at timestamp zero and ends at the anchor block, retains contract/confirmation/order filters across pagination, and has at least 15 minutes of indexing runway. Evidence must be at most 15 minutes old; the balance anchor may be at most 45 minutes old to accommodate collection and indexing. The validator rejects mismatched receipts, changed anchor blocks, unfinished pagination, duplicate records, negative intermediate balances, unsupported history event types, unproved transfers at the freeze timestamp, and any discrepancy with the raw confirmed balance. A shared-timestamp transfer in a different transaction requires optional `freezeBlock` (the confirmed block with its ordered transaction IDs) and `boundaryReceipts`: the block must match the freeze number/time and contain both unique transactions, and a successful same-block receipt must uniquely prove the exact token, sender, recipient, and raw transfer amount. The validator then places that transfer before or after the freeze by transaction position. Same-transaction transfers remain ambiguous without log-order proof. It subtracts post-freeze net transfers using integer token units, so later deposits are not mistaken for the frozen event amount.

Live repair requires `--execute --confirm repair-tron-blacklist-amounts`. The command captures a fresh Time Travel bookmark and uses one atomic D1 SQL import for the row-count guard, audit, exact-null event updates, and canonical derived-cache invalidation. Reconstructed values are marked `amount_source=derived`, with the immutable evidence SHA-256 in provenance and `admin_action_audit`. It does not overwrite existing amounts or change current balances, cursors, thresholds, or health checks. Re-running against resolved rows refuses mutation; preserve the evidence file with the audit/bookmark for review. Use this path for rows the scheduled replay refuses — a ledger that never reconciles, a history longer than the replay page cap, or a shared-millisecond transfer — and never as a substitute for the scheduled lane.

5. Non-USD event valuation requires a historically attributed quote for that event, not the repair-time `price_cache` quote. The ingestion and automated/manual recovery lanes currently have no such historical quote source: they recover native amounts but retain null event-time USD. Fresh coin-specific quotes remain valid for current-balance observations only.
6. Circle mirror actions can produce auditable zero-balance EURC rows. `circle_mirror_zero_balance` rows remain stored but are excluded from public events, active records, and frozen-value aggregates.
7. Seize-only BUIDL coverage records destroy events; it does not create an active blacklist/freeze state.

Explicit current limitations also remain source-tested:

- RLUSD clawbacks are not event-covered because the verified ABI has no dedicated clawback event. Supporting them would require transaction-input classification.
- USDA role-gated burns are not mapped to destroy rows because the contract does not emit the configured Tether destroy event.

Canonical coverage and parser tests live in:

- `worker/src/cron/blacklist/__tests__/blacklist-contracts.test.ts`
- `worker/src/cron/blacklist/__tests__/evm-source.test.ts`
- `worker/src/cron/blacklist/__tests__/evm-source-coverage.test.ts`
- `worker/src/cron/blacklist/__tests__/tron-source.test.ts`

## Storage Semantics

The migration files and `worker/migrations/MANIFEST.md` are the exact schema and index inventory. This section owns semantics, not copied SQL DDL.

### Event History

`blacklist_events` records:

- `blacklist`, `unblacklist`, and `destroy` transitions;
- stablecoin, chain, contract/config, transaction, block, and event-signature provenance;
- authoritative `amount_native` and justified `amount_usd_at_event` values;
- the deployed legacy `amount` column remains pending a separately operated schema cleanup; normal ingestion/recovery and all three operator tools (`worker/scripts/repair-tron-blacklist-amounts.ts`, `worker/scripts/reconcile-blacklist-events-from-kyc-rip.ts`, `worker/scripts/reconcile-night-watch-blacklist.ts`) now read/write canonical amount fields only;
- amount source, resolution status, recovery attempts, provider, and bounded error diagnostics;
- optional suppression reason for audit-only rows.

Canonical repair eligibility ignores legacy `amount`; exact identity, canonical-null/state/suppression, evidence freshness/hash, atomic row-count audit and Time Travel guards still apply. Re-review old plans where legacy `amount` is populated but canonical values are null; prior signed/generated SQL is not approval under that eligibility. JS input `amount` remains an evidence-derived quantity, not a database alias. Neither legacy values nor current balances prove event-time USD.

Before any column drop, reconcile/export legacy-only identity/value tuples, obtain external SQL/schema-owner signoff, retain a durable R2 export indefinitely and record a pre-window Time Travel bookmark. The compatible tool/Worker release must establish the rollback floor and pass its first six-hourly sync/API soak. DROP or a rehearsed identity/default/index/FK/repair-queue-preserving rebuild is a separate destructive release, not part of this cutover. Post-drop rollback requires compatible tools or verified schema/data restoration; Worker rollback alone cannot restore the column.

Normal EVM row identity is `{chainId}-{lowercaseTxHash}-{minimalHexLogIndex}`; expanded arrays retain numeric element suffixes. An indexed semantic identity also admits retained decimal/padded-hex spellings without inserting another event generation. The shared public-event predicate excludes equivalent duplicates immediately; reconciliation retains redundant history as `duplicate_log_identity` audit rows without changing event IDs or repair-queue references.

Tron ingestion, existing-row folds and snapshot keys use validated lowercase `0x` byte identities for Base58/`41`/`0x` inputs. Base58 is never case-folded for account identity; it is derived only for provider calls and exact historical spelling lookups. SQL retains relevant Tron rows for the canonical fold. Snapshot consolidation atomically preserves the newest successful value and removes representation-only aliases, respecting the writer pause.

`identity-reconciliation.ts` runs before summary materialization, paging at most 100 events and 100 Tron snapshots with durable keyset cursors. Each call reads two cursors, two indexed pages and at most 100 bounded alias sets; `0267` indexes avoid inventory rescans. Only changed addresses, newly suppressed duplicates or unconsolidated snapshots write rows; cursors still wrap to catch operator imports. Public folds remain canonical during cutover.

Active ingestion uses these amount-source meanings:

- `event`: amount emitted by the event.
- `historical_balance`: amount proven by a historical balance read.
- `unavailable`: no defensible amount.

`current_balance_snapshot` is retained for legacy read compatibility only. Current snapshots live in `blacklist_current_balances` and are never written into event-time columns.

`derived` is written by confirmed Tron transfer-replay recovery, not by initial event ingestion. Eligible unresolved rows enter the durable repair queue. Legacy derived-zero rows receive bounded recovery attempts before becoming permanently unavailable. `legacy_migration` records historical amount provenance only; it does not indicate a remaining identity repair.

`data-invariant-canary` reports an error if either event or balance rows lack both `config_key` and `contract_address`. `syncBlacklist()` does not rescan or rewrite that legacy identity set; investigate any non-zero count as an invariant failure.

### Freeze Ledger

`blacklist_current_balances` is a persistent, contract/config-scoped last-known snapshot ledger. It feeds:

- `trackedFrozenTotal`
- `trackedAddressCount`
- `trackedAmountGapCount`

Provider refresh failures preserve the last successful value and update quality/provenance fields. They do not turn the public total into zero.

Gold zero-read substitution applies only after an actual observed zero and a positive event-native amount; the ledger records `source=gold_event_zero_balance`. A null gold provider read is still `provider_failed` and preserves the previous value and successful-observation timestamp.

Before cursor finalization, capture work (including budget-skipped and order-withheld rows) is retained without TTL in D1 `cache` under `blacklist:current-balance-debt:`. The maintenance tail admits at most 24 debt rows, respecting the same runtime, subrequest budget, serial limiters and provider circuit gates. Quiet scans can reconcile missing snapshots without rewinding cursors. Successful Tron block-order recovery also enqueues affected rows, including pre-deploy conflicts; release markers preserve prior ledger captures and destroy snapshots use the emitted historical value.

The summary loader reads the complete retained ledger — released addresses, destroy snapshots, and legacy rows whose successful-observation timestamp is NULL or old — so historical rows keep feeding the tracked totals and the quarterly chart. Their age surfaces through `freezeLedgerMeta` freshness distributions and provider-failure counts rather than rows silently disappearing from totals.

Unblacklist events do not delete historical snapshot rows. Destroy events may replace a stored amount with a better emitted seizure/burn amount. When a blacklist and release arrive in the same batch, the blacklist snapshot is still captured before the release marker is treated as non-deleting.

Operator rebuilds and KYC current-balance admission also preserve this complete ledger. They use runtime contract/config identities and the same last-known-value upsert policy, stage every observation before any authoritative write, and publish scoped upserts with canonical summary/gap-cache invalidation in one file transaction. A failed admission cannot remove or partially replace retained rows; rows absent from the active/provider set are not deletion candidates. The [balance-maintenance procedure](./runbooks/blacklist-sync.md#blacklist-current-balance-rebuild) owns staging, failure recovery, and writer-pause handling.

Legacy `activeAddressCount`, `activeFrozenTotal`, and `activeAmountGapCount` remain in `/api/blacklist-summary` for wire compatibility. They represent the local net-active event state, not the public historical freeze-ledger total.

### Cursor State

`blacklist_sync_state.last_block` stores EVM block numbers or Tron millisecond scan timestamps, never interchangeable units. State also retains attempt generations, outcome timestamps, streaks, and safe-head evidence.

A config attempt claims its starting cursor and increments `attempt_generation`. Finalization succeeds only when the generation and starting cursor still match, preventing a late writer from overwriting newer progress. EVM config keys canonicalize the contract address to lowercase while reads retain compatibility with legacy mixed-case rows.

EVM cursors advance only through the minimum contiguous block proven across every required topic. Missing-topic or partial coverage pins the unproven tail. Tron cursors advance only after every configured event family completes through the safe timestamp frontier.

A fully scanned bounded EVM subrange is contiguous progress, not current coverage: until its frontier reaches the observed safe head, the outcome is incomplete and the success clock is retained. Summary materialization may refresh observed totals during catch-up, but cannot renew coverage freshness. The producer snapshot's `refresh` names the rebuild time and every config behind its safe head; the FreezeWatch page (not the homepage card) then shows "Some sources are still catching up" naming configs last successful outside the fresh budget, not the running-behind banner, while those totals are within budget. Cron metadata reports `configLag` with the frontier, observed safe head, cursor kind and remaining lag (blocks or milliseconds). Avalanche fallback scans admit up to eight serial 2,000-block provider windows per config (16,000 blocks per run), exceeding the assumed 10,800-block six-hour chain growth without increasing any individual request range.

Cron metadata also retains `coverageFailureConfigs`: at most six current-run source scans with non-complete/non-quiet outcomes, including their config key, outcome, cursor kind, observed frontier/safe head/lag, and existing bounded failure samples. EVM cursor units are blocks; Tron cursor units are milliseconds. Unavailable observations stay null. This is diagnostic detail, not a relaxed coverage verdict or an exhaustive failure count: source skips, exceptions, or state conflicts without a returned source result remain in their existing counters and reasons. Use `coverageFailures` for the aggregate and the sampled entries to investigate the source shortfall.

## Producer Flow

Each run performs these phases under one scan deadline, one separately capped maintenance tail, and one shared subrequest budget:

1. **Fair admission:** load typed config states, order cohorts by oldest attempt, alternate equal-age EVM and Tron work, and claim the generation-fenced attempt.
2. **Safe scan:** resolve the safe head using the 15-minute indexing margin, scan bounded windows, validate provider coverage, and parse rows.
3. **Historical enrichment:** enrich only defensible event amounts before insertion. Duplicate event IDs skip unnecessary enrichment and cache work.
4. **Persistence and cursor finalization:** insert event rows before advancing the claimed cursor; incomplete coverage never advances beyond its proven contiguous frontier.
5. **Freeze-ledger refresh:** snapshot newly blocked addresses and preserve last-known values across provider failures. The snapshot is current-state ledger data only; it never supplies an event-time Tron amount.
6. **Bounded maintenance:** retry durable amount repairs before other maintenance, replay unprovable Tron freeze amounts from the confirmed transfer ledger, migrate unambiguous legacy identities, and leave ambiguous same-symbol/same-chain identities explicit. If scans consume their full 10-minute budget, amount repair may use the separately capped 45-second tail inside the 12-minute cron wrapper and admits at most 10 rows. Shorter runs retain the normal 100-row repair cap. Both paths reuse the scan's subrequest budget and serial provider limiter, so maintenance does not increase connection concurrency or consume scan time. The Tron replay lane is capped at 24 rows and 120 history pages per run, needs TronGrid only (it runs even when the Etherscan circuit is open), and reports its own `tronAmountRepair*` counters in run metadata.
7. **Publication and telemetry:** refresh the summary from persisted observations when enough scan/subrequest budget remains, independently of the overall ingestion status. A failed or catching-up config cannot block other configs' observations from reaching the summary. Freshness still uses the oldest required config success, never the materialization or cron completion time; if any required config has never succeeded, summary freshness is explicitly missing. Gap producer snapshots require that retained full-coverage timestamp; otherwise the summary reads gap metrics through the existing query path. Ingestion status and incomplete-coverage warnings remain conservative. Exhausted budgets still withhold snapshots, and failed aggregate reads never overwrite the retained summary.

Provider telemetry retains bounded config-level mode, coverage, frontier, count, call-depth, and failure-sample evidence. The operational response is documented in [Runbook: Blacklist Sync](./runbooks/blacklist-sync.md).

RPC failover samples preserve the provider's failure reason (for example, `primary-failover:split-limit`); `primary-failover:no-coverage` is used only when the primary proves no contiguous coverage without a specific reason. Serial catch-up windows retain that diagnostic while merging their covered frontier.

## Telegram Freeze Alerts

PharosWatchBot consumes explicit, unsuppressed transitions only after the 30-minute Tape projector writes immutable `freeze.blocked`, `freeze.unblocked`, or `freeze.destroyed` rows.

New Tape payloads carry the canonical stablecoin ID resolved from the verified `config_key`. Legacy symbol-only rows are accepted only when the symbol is unique. The consumer fails closed when the latest successful Tape projection is older than 60 minutes and cold-seeds without replay when its cursor is absent.

Worst-case source latency is the six-hour tracker scan plus the 30-minute Tape projection and five-minute Telegram poll. Alert messages keep both Tape and source event identities and describe a missing historical amount as unavailable, not zero. See [Telegram Alerts](./telegram-alerts.md#freeze-alert-source-and-cadence).

## API And Operator Contract

The API reference is authoritative for parameters, schemas, cache/freshness headers, status codes, and admin mutation contracts:

- [`GET /api/blacklist`](./api-reference.md#get-apiblacklist)
- [`GET /api/blacklist-summary`](./api-reference.md#get-apiblacklist-summary)
- [`POST /api/reset-blacklist-sync`](./api-reference-admin.md#post-apireset-blacklist-sync)
- [`GET /api/debug-sync-state`](./api-reference-admin.md#get-apidebug-sync-state)
- [`POST /api/remediate-blacklist-amount-gaps`](./api-reference-admin.md#post-apiremediate-blacklist-amount-gaps)
- [Historical current-balance operator CLI](./runbooks/one-shot-backfills.md#backfill-blacklist-current-balances)

Public event queries exclude rows with a suppression reason. Accepted filter symbols come from `BLACKLIST_STABLECOINS`; supported/deferred deployment coverage comes from the runtime coverage manifest. Summary coverage fields are contract/config-level and must not be relabeled as symbol-level coverage.

Use the admin actions and decision order in [Runbook: Blacklist Sync](./runbooks/blacklist-sync.md). A generic amount gap is not evidence that a cursor reset is appropriate.

## Frontend Contract

- **Route:** `src/app/freezewatch/page.tsx`
- **Queries:** `src/hooks/use-blacklist-events.ts`
- **Query policy:** `src/lib/api-query-descriptors.ts`
- **Shared response types:** `shared/types/market.ts`

The summary query supplies aggregate cards, exposure drilldowns, chart data, and filter metadata. The event query supplies the current server-filtered, sorted, searched, and paginated ledger slice. Both endpoints use the same six-hour producer freshness source.

A missing ungrouped aggregate row is a failed read, not a measured empty cohort. Gap metrics and summary materialization reject it with `blacklist-gap-aggregate-missing` or `blacklist-summary-aggregate-missing`; no fabricated summary snapshot is written. On a cold request the summary API responds 503/no-store with that reason. Successful aggregates with an observed zero count retain empty-cohort semantics.

`dataQuality.ambiguousOrderCount` counts unresolved contract-scoped active-state records excluded from confirmed counts. `dataQuality.ambiguousOrderReason` is `tron-cross-transaction-order` when that count is positive, otherwise `null`; the same reason appears in `warnings` and degrades quality. Both fields are additive/optional for retained old summaries; missing fields mean legacy unknown coverage, not a measured zero. Tracked ledger totals remain retained snapshots, not a claim that ambiguous current state is resolved.

Summary USD aggregates (`destroyedTotal`, recent freeze amounts, and per-coin frozen/destroyed totals) are nullable and carry `stats.valuationCoverage` known/unavailable observation counts. All-unpriced cohorts publish null; mixed cohorts publish the known subtotal explicitly labelled partial; observed zero remains zero. An empty cohort publishes zero with zero observations. Current producer snapshots require valuation coverage; optional coverage on legacy public payloads means unknown coverage, not complete valuation. The same qualification is used by FreezeWatch cards, the coverage lattice, homepage recent freezes, and coin detail cards, even when unresolved values are permanently unavailable and general quality otherwise reads healthy.

The page must preserve these distinctions:

- missing or unresolved amounts display their status/source instead of a confirmed zero;
- non-USD current-balance observations may use a fresh coin-specific price, but historical events require an event-time quote and stay unavailable without one;
- tracked frozen totals are last-known freeze-ledger snapshots;
- event history and local net-active state remain separate from those snapshots;
- mobile cards and desktop table share server filters/sort; cursor navigation retains previous-page cursors and resets on ledger filters/sort;
- CSV export represents only the currently loaded server page.
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
