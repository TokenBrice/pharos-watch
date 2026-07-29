# Blacklist Tracker

Multi-chain blacklist/freeze event tracker for stablecoins. Every six hours, the runtime scans the live contract configurations in `worker/src/lib/blacklist-contracts.ts`; that registry owns the supported chains, symbols, and deferred deployments.

## Methodology And Ownership

- **Current methodology version:** `v3.9972`
- **Version source:** `shared/lib/blacklist-tracker-version.ts`
- **Public changelog:** `/methodology/blacklist-tracker-changelog/`
- **Structured changelog:** `shared/data/methodology-changelogs/blacklist-tracker/`

Three registries have deliberately different jobs:

- `CONTRACT_CONFIGS` in `worker/src/lib/blacklist-contracts.ts` is the cron-backed scan set. It owns tracker-specific chain, contract, start-block, event-family, topic, and decoding metadata.
- `BLACKLIST_STABLECOINS` in `shared/types/market.ts` is the API and UI filter universe. It may retain archived identities after a live scan is retired.
- `worker/src/lib/blacklist-coverage-manifest.ts` derives supported coverage and owns explicit deferred, waived, and out-of-scope deployment records.

Do not copy any of those rosters into documentation. Contract addresses and decimals resolve from the shared stablecoin registry except for explicit traded-contract or tracker-specific overrides in `blacklist-contracts.ts`.

Every stablecoin ID in `CONTRACT_CONFIGS` must resolve to direct `Freezable: Yes` metadata. `worker/src/lib/__tests__/blacklist-contracts.test.ts` enforces that boundary so direct tracker coverage cannot be mislabeled as only upstream exposure.

## Public Exposure Contract

The `/freezewatch/` exposure summary uses `buildBlacklistStatusBuckets()` and the same resolved four-state model as Report Cards:

- `yes`: direct issuer blacklist, freeze, seizure, or equivalent holder-facing control.
- `upstream`: a reserve, backing, custody, parent-asset, or custody-rail dependency can block value upstream of the token. Any matched reserve path is sufficient; it need not be a majority position.
- `possible`: a curated direct pause, blacklist, freeze, or mutable holder-facing control exists but is not confirmed as an active direct blacklist control.
- `no`: no exposure resolves under the current model.

Observed tracker history is evidence, not policy probability. Event counts describe supported observed history and are symbol-level in the current summary payload; the UI must not label them as contract-level totals.

The tracker has two amount layers:

- `blacklist_events` stores immutable event history and event-time amounts only when Pharos can justify historical attribution.
- `blacklist_current_balances` stores last-known successful freeze-ledger snapshots used by the public tracked frozen-total summary.

The snapshot total is not a live balance guarantee and is distinct from the local net-active event-state view.

## Schedule And Runtime

- **Expression:** `3 */6 * * *`
- **Slot:** `worker/src/handlers/scheduled/hourly-blacklist.ts`
- **Producer:** `syncBlacklist()` in `worker/src/cron/sync-blacklist.ts`
- **Runtime budget:** 10 minutes for scans, with a 60-second minimum window before starting another config; a separately capped maintenance tail ends at 10 minutes 45 seconds
- **Subrequest budget:** 900 across scanning, enrichment, and maintenance
- **Provider limiter:** Etherscan and TronGrid requests use the shared serial 3-requests-per-second limiter

The producer returns `itemCount` as rows actually inserted into `blacklist_events`. Its `eventsFetched` metadata counts parsed rows before `INSERT OR IGNORE` deduplication. The remaining bounded counters and failure samples are defined beside `SyncBlacklistResult` and its metadata assembly in `sync-blacklist.ts`; do not duplicate that key inventory here.

### Provider Paths

- Etherscan v2 is an explorer source for supported EVM log scans and a best-effort final historical-call fallback.
- Base, Optimism, Avalanche, BSC, and Gnosis prefer chain RPC `eth_getLogs`; chain RPC configuration comes from `worker/src/lib/chain-registry.ts`.
- Historical EVM balance lookup prefers dRPC when configured, then the shared chain RPC path, then best-effort Etherscan.
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
- `worker/src/cron/blacklist/shared.ts`

The durable rules are:

1. An event family can read an address or amount from an indexed topic, a fixed ABI data slot, a dynamic address array, or a named Tron result field.
2. A batch address event expands to one deterministic `blacklist_events` row per affected address.
3. An emitted destroy/seize amount is preferred. An amountless wipe can use `balanceOf` at `blockNumber - 1` when a historical provider can prove it.
4. Current Tron account balances belong to the freeze ledger. They must not be presented as fabricated event-time blacklist balances.
5. Non-USD assets require a fresh coin-specific price-cache conversion before Pharos publishes a USD event or snapshot value.
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
- native and justified event-time USD amounts;
- amount source, resolution status, recovery attempts, provider, and bounded error diagnostics;
- optional suppression reason for audit-only rows.

Normal EVM row identity is `{chainId}-{txHash}-{logIndex}`; expanded arrays add their element index so every affected address remains distinct and idempotent.

Active ingestion uses these amount-source meanings:

- `event`: amount emitted by the event.
- `historical_balance`: amount proven by a historical balance read.
- `current_balance_snapshot`: Tron freeze-ledger reconciliation, clearly distinguished from historical attribution.
- `unavailable`: no defensible amount.

`derived` and `legacy_migration` are compatibility artifacts, not current ingestion modes. Eligible unresolved rows enter the durable repair queue. Legacy derived-zero rows receive bounded recovery attempts before becoming permanently unavailable.

### Freeze Ledger

`blacklist_current_balances` is a persistent, contract/config-scoped last-known snapshot ledger. It feeds:

- `trackedFrozenTotal`
- `trackedAddressCount`
- `trackedAmountGapCount`

Provider refresh failures preserve the last successful value and update quality/provenance fields. They do not turn the public total into zero.

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
5. **Freeze-ledger refresh:** snapshot newly blocked addresses, preserve last-known values across provider failures, and apply the Tron ledger mirror in the same run.
6. **Bounded maintenance:** retry durable amount repairs before other maintenance, migrate unambiguous legacy identities, and leave ambiguous same-symbol/same-chain identities explicit. If scans consume their full 10-minute budget, amount repair may use the separately capped 45-second tail inside the 12-minute cron wrapper and admits at most 10 rows. Shorter runs retain the normal 100-row repair cap. Both paths reuse the scan's subrequest budget and serial provider limiter, so maintenance does not increase connection concurrency or consume scan time.
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
- [`POST /api/reset-blacklist-sync`](./api-reference.md#post-apireset-blacklist-sync)
- [`GET /api/debug-sync-state`](./api-reference.md#get-apidebug-sync-state)
- [`POST /api/remediate-blacklist-amount-gaps`](./api-reference.md#post-apiremediate-blacklist-amount-gaps)
- [`POST /api/backfill-blacklist-current-balances`](./api-reference.md#post-apibackfill-blacklist-current-balances)

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
   npm run check:docs-api-reference
   npm run check:cron-connections
   ```
