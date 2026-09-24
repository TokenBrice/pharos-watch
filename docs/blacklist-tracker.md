# Blacklist Tracker

Multi-chain blacklist/freeze event tracker for stablecoins. Every six hours, the runtime scans the live contract configurations in `worker/src/lib/blacklist-contracts.ts`; that registry owns the supported chains, symbols, and deferred deployments.

## Methodology And Ownership

- **Current methodology version:** <!-- GENERATED-START: methodology-version-blacklist-tracker -->`v4.0`<!-- GENERATED-END: methodology-version-blacklist-tracker -->
- **Version source:** `shared/lib/methodology-versions/registry.ts`
- **Public changelog:** `/methodology/blacklist-tracker-changelog/`
- **Structured changelog:** `shared/data/methodology-changelogs/blacklist-tracker/`

Three registries have deliberately different jobs:

- `CONTRACT_CONFIGS` in `worker/src/lib/blacklist-contracts.ts` is the cron-backed scan set. It owns tracker-specific chain, contract, start-block, event-family, topic, and decoding metadata.
- `BLACKLIST_STABLECOINS` in `shared/types/market.ts` is the API and UI filter universe. It may retain archived identities after a live scan is retired.
- `worker/src/lib/blacklist-coverage-manifest.ts` derives supported coverage and owns explicit deferred and out-of-scope deployment records.

Do not copy any of those rosters into documentation. Contract addresses and decimals resolve from the shared stablecoin registry except for explicit traded-contract or tracker-specific overrides in `blacklist-contracts.ts`.

Every stablecoin ID in `CONTRACT_CONFIGS` must resolve to direct `Freezable: Yes` metadata. `worker/src/lib/__tests__/blacklist-contracts.test.ts` enforces that boundary so direct tracker coverage cannot be mislabeled as only upstream exposure.

## Public Exposure Contract

The `/freezewatch/` exposure summary uses `buildBlacklistStatusBuckets()` and the same resolved four-state model as Report Cards:

- `yes`: direct issuer blacklist, freeze, seizure, or equivalent holder-facing control.
- `upstream`: the token has no direct `yes` or `possible` holder-facing freeze control, but strictly more than 50% of its reserve composition is exposed to assets or rails classified `yes`, `upstream`, or `possible`. Tracked parent/wrapper inheritance and full CEX custody still resolve as upstream exposure.
- `possible`: a curated direct pause, blacklist, freeze, or mutable holder-facing control exists but is not confirmed as an active direct blacklist control.
- `no`: no exposure resolves under the current model.

The public buckets read `blacklistabilityReview.reviewedStatus` through the generated client-registry
`blacklistStatus`. That reviewed registry value is the sole product-level status authority. Safety
Score V9 consumes the same review for evidence freshness, scoring gaps, and failure-domain attribution,
but its `accessPosture.freezeExposure` is not a fallback status source.

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

Current-balance cache telemetry preserves the canonical `skippedDueBudget` count and `budgetExhausted` flag; neither is replaced by a synthetic deletion counter.

### Provider Paths

- Etherscan v2 is an explorer source for supported EVM log scans and a best-effort final historical-call fallback.
- Base, Optimism, Avalanche, BSC, and Gnosis prefer chain RPC `eth_getLogs`; chain RPC configuration comes from `worker/src/lib/chain-registry.ts`.
- Historical EVM balance lookup prefers dRPC when configured, then the shared chain RPC path, then best-effort Etherscan.
- The lane never reaches the supplemental Dwellir operator: log-scan target resolution and historical balance reads select registry endpoints only (`logScanRpcEndpoints` / `registryRpcUrls` in `worker/src/lib/chain-registry.ts`), because a blacklist scan needs provable history and Dwellir's `eth_getLogs` plan cap is 500 blocks per request.
- Tron event scans and current-balance reads use TronGrid. Pagination URLs are origin/path validated before credentials are forwarded.

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

1. An event family can read an address or amount from an indexed topic, a fixed ABI data slot, a dynamic address array, or a named Tron result field.
2. A batch address event expands to one deterministic `blacklist_events` row per affected address.
3. Oversized batch-address events are never truncated. If a decoded row cannot be persisted completely within the bounded path, coverage is marked incomplete and the cursor cannot advance beyond that block.
4. Recognized provider events without a non-empty affected address are quarantined instead of creating blank-address history.
5. An emitted destroy/seize amount is preferred. An amountless wipe can use `balanceOf` at `blockNumber - 1` when a historical provider can prove it.
6. Current Tron account balances belong to the freeze ledger. They must not be presented as fabricated event-time blacklist balances.
7. An amountless Tron freeze is instead replayed from the token's own confirmed transfer ledger: the frozen balance is the address's cumulative signed TRC20 flow through the freeze millisecond, persisted as `amount_source=derived` with `provenance_source=trongrid-transfer-replay` only when the freeze receipt proves the stored event, every returned transfer is unique by its composite transaction identity (transaction, timestamp, route, value — TronGrid history exposes no log index), no transfer shares the freeze millisecond, the ledger paginates to completion, and the cumulative flow reconciles exactly with the solidified `balanceOf` read that brackets the same solidified head. The settle window between the ledger bound and the balance read must also be proven quiet, so a landing transfer during the read is reported as a state race instead of a mismatch. Replay never overwrites an existing amount, a current-balance snapshot, or an operator-repaired value; its writes additionally require the row to still have no amount.

The scheduled replay lane (`worker/src/lib/blacklist/tron-amount-recovery.ts`) runs in the `sync-blacklist` maintenance tail under the same runtime window and subrequest budget as the EVM repair lane, is gated on the same TronGrid circuit as the scan, and is capped at 24 rows and 40 history pages per row with 120 history pages per run, where every requested page counts — including pages that fail. Its candidates come from the same durable `blacklist_amount_repair_queue` rows as every other chain, least-attempted first, so fresh rows cannot starve retries. Provider failures and unreconciled ledgers retry with normal backoff; deterministic classes that cannot change on retry (a ledger beyond the page cap, shared-millisecond evidence, an unusable config) are parked for a week and stay visible as unresolved gaps for the operator repair path. A duplicated transfer record is rejected the same way — equal-and-opposite duplicate pairs can still cancel at the current-balance checkpoint, so record uniqueness is checked before reconciliation and the row parks for receipt-level review rather than persisting an inflated freeze amount. A freeze younger than 15 minutes, a run window that closes mid-ledger, or a landing transfer during the proof leaves the row untouched with no attempt recorded, so nothing is inferred from an unproven state.

For a bounded operator repair, `npx tsx worker/scripts/repair-tron-blacklist-amounts.ts --evidence <file>` validates an immutable official TronGrid capture and reads the exact unresolved D1 rows without mutation. Its version-1 evidence envelope contains `provider`, `capturedAtMs`, and at most eight entries with `event`, `anchor` (confirmed blocks bracketing the raw `balanceOf` response), `freezeReceipt`, and `history` (initial URL and every requested page/response). Full history starts at timestamp zero and ends at the anchor block, retains contract/confirmation/order filters across pagination, and has at least 15 minutes of indexing runway. Evidence must be at most 15 minutes old; the balance anchor may be at most 45 minutes old to accommodate collection and indexing. The validator rejects mismatched receipts, changed anchor blocks, unfinished pagination, duplicate records, negative intermediate balances, unsupported history event types, ambiguous transfers at the freeze timestamp, and any discrepancy with the raw confirmed balance. It subtracts post-freeze net transfers using integer token units, so later deposits are not mistaken for the frozen event amount.

Live repair requires `--execute --confirm repair-tron-blacklist-amounts`. The command captures a fresh Time Travel bookmark and uses one atomic D1 SQL import for the row-count guard, audit, exact-null event updates, and canonical derived-cache invalidation. Reconstructed values are marked `amount_source=derived`, with the immutable evidence SHA-256 in provenance and `admin_action_audit`. It does not overwrite existing amounts or change current balances, cursors, thresholds, or health checks. Re-running against resolved rows refuses mutation; preserve the evidence file with the audit/bookmark for review. Use this path for rows the scheduled replay refuses — a ledger that never reconciles, a history longer than the replay page cap, or a shared-millisecond transfer — and never as a substitute for the scheduled lane.

8. Non-USD assets require a fresh coin-specific price-cache conversion before Pharos publishes a USD event or snapshot value.
9. Circle mirror actions can produce auditable zero-balance EURC rows. `circle_mirror_zero_balance` rows remain stored but are excluded from public events, active records, and frozen-value aggregates.
10. Seize-only BUIDL coverage records destroy events; it does not create an active blacklist/freeze state.

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
- the deployed legacy `amount` column remains in place pending a separate coordinated schema cleanup; current ingestion and repair paths no longer write it;
- amount source, resolution status, recovery attempts, provider, and bounded error diagnostics;
- optional suppression reason for audit-only rows.

Normal EVM row identity is `{chainId}-{txHash}-{logIndex}`; expanded arrays add their element index so every affected address remains distinct and idempotent.

Active ingestion uses these amount-source meanings:

- `event`: amount emitted by the event.
- `historical_balance`: amount proven by a historical balance read.
- `unavailable`: no defensible amount.

`current_balance_snapshot` is retained for legacy read compatibility only. Current snapshots live in `blacklist_current_balances` and are never written into event-time columns.

`derived` and `legacy_migration` are compatibility artifacts, not current ingestion modes. Eligible unresolved rows enter the durable repair queue. Legacy derived-zero rows receive bounded recovery attempts before becoming permanently unavailable. `legacy_migration` records historical amount provenance only; it does not indicate a remaining identity repair.

The one-time legacy identity repair was completed and verified in production on 2026-08-26: `blacklist_events` and `blacklist_current_balances` contain no rows where both `config_key` and `contract_address` are `NULL`. The repair's Time Travel bookmark is retained by the operator. `syncBlacklist()` no longer scans or rewrites those rows; the `data-invariant-canary` now counts both tables and reports an error if either count becomes non-zero.

### Freeze Ledger

`blacklist_current_balances` is a persistent, contract/config-scoped last-known snapshot ledger. It feeds:

- `trackedFrozenTotal`
- `trackedAddressCount`
- `trackedAmountGapCount`

Provider refresh failures preserve the last successful value and update quality/provenance fields. They do not turn the public total into zero.

The summary loader reads the complete retained ledger — released addresses, destroy snapshots, and legacy rows whose successful-observation timestamp is NULL or old — so historical rows keep feeding the tracked totals and the quarterly chart. Their age surfaces through `freezeLedgerMeta` freshness distributions and provider-failure counts rather than rows silently disappearing from totals.

Unblacklist events do not delete historical snapshot rows. Destroy events may replace a stored amount with a better emitted seizure/burn amount. When a blacklist and release arrive in the same batch, the blacklist snapshot is still captured before the release marker is treated as non-deleting.

Legacy `activeAddressCount`, `activeFrozenTotal`, and `activeAmountGapCount` remain in `/api/blacklist-summary` for wire compatibility. They represent the local net-active event state, not the public historical freeze-ledger total.

### Cursor State

`blacklist_sync_state` stores typed EVM block or Tron millisecond-timestamp cursors plus attempt generations, outcome timestamps, streaks, and safe-head evidence.

A config attempt claims its starting cursor and increments `attempt_generation`. Finalization succeeds only when the generation and starting cursor still match, preventing a late writer from overwriting newer progress. EVM config keys canonicalize the contract address to lowercase while reads retain compatibility with legacy mixed-case rows.

EVM cursors advance only through the minimum contiguous block proven across every required topic. Missing-topic or partial coverage pins the unproven tail. Tron cursors advance only after every configured event family completes through the safe timestamp frontier.

## Producer Flow

Each run performs these phases under one scan deadline, one separately capped maintenance tail, and one shared subrequest budget:

1. **Fair admission:** load typed config states, order cohorts by oldest attempt, alternate equal-age EVM and Tron work, and claim the generation-fenced attempt.
2. **Safe scan:** resolve the safe head using the 15-minute indexing margin, scan bounded windows, validate provider coverage, and parse rows.
3. **Historical enrichment:** enrich only defensible event amounts before insertion. Duplicate event IDs skip unnecessary enrichment and cache work.
4. **Persistence and cursor finalization:** insert event rows before advancing the claimed cursor; incomplete coverage never advances beyond its proven contiguous frontier.
5. **Freeze-ledger refresh:** snapshot newly blocked addresses and preserve last-known values across provider failures. The snapshot is current-state ledger data only; it never supplies an event-time Tron amount.
6. **Bounded maintenance:** retry durable amount repairs before other maintenance, replay unprovable Tron freeze amounts from the confirmed transfer ledger, migrate unambiguous legacy identities, and leave ambiguous same-symbol/same-chain identities explicit. If scans consume their full 10-minute budget, amount repair may use the separately capped 45-second tail inside the 12-minute cron wrapper and admits at most 10 rows. Shorter runs retain the normal 100-row repair cap. Both paths reuse the scan's subrequest budget and serial provider limiter, so maintenance does not increase connection concurrency or consume scan time. The Tron replay lane is capped at 24 rows and 120 history pages per run, needs TronGrid only (it runs even when the Etherscan circuit is open), and reports its own `tronAmountRepair*` counters in run metadata.
7. **Publication and telemetry:** publish gap/summary snapshots only after every required config has a successful complete or quiet scan and enough tail budget remains. Freshness uses the oldest required config success, not cron completion time.

Provider telemetry retains bounded config-level mode, coverage, frontier, count, call-depth, and failure-sample evidence. The operational response is documented in [Runbook: Blacklist Sync](./runbooks/blacklist-sync.md).

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
- [`POST /api/backfill-blacklist-current-balances`](./api-reference-admin.md#post-apibackfill-blacklist-current-balances)

Public event queries exclude rows with a suppression reason. Accepted filter symbols come from `BLACKLIST_STABLECOINS`; supported/deferred deployment coverage comes from the runtime coverage manifest. Summary coverage fields are contract/config-level and must not be relabeled as symbol-level coverage.

Use the admin actions and decision order in [Runbook: Blacklist Sync](./runbooks/blacklist-sync.md). A generic amount gap is not evidence that a cursor reset is appropriate.

## Frontend Contract

- **Route:** `src/app/freezewatch/page.tsx`
- **Queries:** `src/hooks/use-blacklist-events.ts`
- **Query policy:** `src/lib/api-query-descriptors.ts`
- **Shared response types:** `shared/types/market.ts`

The summary query supplies aggregate cards, exposure drilldowns, chart data, and filter metadata. The event query supplies the current server-filtered, sorted, searched, and paginated ledger slice. Both endpoints use the same six-hour producer freshness source.

The page must preserve these distinctions:

- missing or unresolved amounts display their status/source instead of a confirmed zero;
- non-USD native amounts are converted only with a fresh coin-specific price;
- tracked frozen totals are last-known freeze-ledger snapshots;
- event history and local net-active state remain separate from those snapshots;
- mobile event cards and the desktop table use the same server query state;
- CSV export represents only the currently loaded server page.

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
   npm run check:doc-source-paths
   npm run check:verified-doc-links
   npm run check:generated-artifacts -- --only=api-reference
   npm run check:cron-connections
   ```

## Blacklist Sync State Semantics

The `blacklist_sync_state.last_block` column has different semantics per chain type:

- **EVM chains**: stores actual block numbers
- **Tron**: stores millisecond timestamps (Tron events are ordered by timestamp, not block number)

This is intentional — do not mix these values across chain types.
