# Blacklist Tracker Methodology — Version Timeline

Internal changelog reconstructed from git history. Covers Blacklist Tracker `v1.0` through `v3.6` (2026-02-09 -> 2026-03-27).

---

## v3.6 — Freeze-ledger quarter attribution for the public chart (Mar 27, 2026)

- `GET /api/blacklist-summary` chart buckets now come from the persistent freeze ledger rather than raw blacklist event-time amounts
- Each tracked balance is attributed to the latest recorded blacklist event for that stablecoin/chain/address identity, so re-blacklisted addresses land in the quarter that matches the ledger row shown in the totals
- If a tracked ledger row lacks a local blacklist timestamp, the chart falls back to the latest related event timestamp and then the snapshot observation time so tracked value is not omitted from the quarterly spread

---

## v3.5 — Persistent freeze-ledger snapshots and bootstrap reconciliation (Mar 27, 2026)

- `GET /api/blacklist-summary` now reports `trackedAddressCount`, `trackedFrozenTotal`, and `trackedAmountGapCount` for the persistent freeze ledger
- `blacklist_current_balances` is now treated as a preserved freeze-ledger snapshot store rather than a disposable live-only current-balance cache
- Later `unblacklist` events no longer delete ledger rows, and destroy events can overwrite the stored amount with the seized burn amount
- Historical ETH USDC, ETH USDT, and TRON USDT ledger rows were reconciled from the `kyc.rip` / `stables.rip` bootstrap so seized-and-burned balances remain visible

---

## v3.4 — Active frozen-total ledger and Tron current-balance separation (Mar 27, 2026)

- Added `blacklist_current_balances` so active blacklist totals can use a dedicated current-balance snapshot instead of overloading event rows
- `GET /api/blacklist-summary` now reports `activeAddressCount`, `activeFrozenTotal`, and `activeAmountGapCount`
- Active Tron blacklist totals now prefer current TRC20 balances for still-blacklisted addresses and destroy-event amounts for seized/burned addresses
- Legacy Tron blacklist/unblacklist rows that still carried historical `amount_source='derived'` values were reset so event-time history no longer reuses stale current-state derivations
- Hourly blacklist sync now refreshes the current-balance cache for newly blacklisted Tron addresses and removes cached balances on Tron destroy/unblacklist events

---

## v3.3 — pyUSD and USD1 blacklist tracking coverage (Mar 24, 2026)

- Added pyUSD (PayPal/Paxos) blacklist event tracking on Ethereum and Arbitrum using `FreezeAddress`, `UnfreezeAddress`, and `FrozenAddressWiped` events
- Added USD1 (World Liberty Financial) blacklist event tracking on Ethereum, BSC, and Tron using `Freeze` and `Unfreeze` events with `addressTopicIndex: 2` for dual-indexed address extraction
- Extended `BlacklistEventDef` with `addressTopicIndex` (EVM) and `tronResultKey` (Tron) for flexible address extraction
- Made aggregation layer dynamic: `BlacklistChartPoint`, `buildBlacklistChartData`, `computeBlacklistSummaryStats`, `BLACKLIST_CHART_COLORS`

---

## v3.2 — Provenance-aware rows and explicit amount semantics (Mar 24, 2026)

- `blacklist_events` rows began storing contract/config provenance (`contract_address`, `config_key`, event signature/topic metadata)
- Public API moved from overloaded `amount` semantics to explicit token-native plus USD-at-event fields
- Amount health now tracks recoverable attribution gaps explicitly instead of treating every null-like case the same
- `EURC` was removed from the live-supported filter set pending a reliable mirrored-zero-noise suppression model

---

## v3.1 — API-error-aware sync cursor protection (Feb 25, 2026)

**Commit:** `d40060a`

- EVM log fetching now distinguishes API failure (`null`) from genuine no-event responses (`[]`)
- On API failure, sync cursor does not advance; the same range is retried next run
- Run metadata now includes `apiErrors` for easier operational monitoring

---

## v3.0 — Indexer-lag safety margins for cursor advancement (Feb 25, 2026)

**Commit:** `e6de7eb`

- Added 15-minute safety lag when advancing cursors with no observed events
- EVM no-event advancement uses `head - safetyMargin` instead of raw head
- Tron no-event advancement uses `now - 15m` instead of wall-clock now
- Prevents permanently skipping events that explorer indexers ingest late

---

## v2.2 — Precision and integrity hardening (Feb 18-20, 2026)

**Commits:** `c6c1391`, `7bc5361`, `e950f76`

- Amount conversion switched to BigInt-safe decimal math to avoid precision loss at large values
- Invalid EVM logs (bad block/timestamp decode) are dropped instead of inserted
- Sync now returns structured telemetry (`itemCount`, `contractsSkipped`, budget stats)

---

## v2.1 — Pre-block sampling and zero-amount recovery (Feb 18, 2026)

**Commit:** `d7e0ad4`

- Amount enrichment moved to `blockNumber - 1` for blacklist/unblacklist/destroy
- Backfill started retrying blacklist rows with `amount = 0` (not only `NULL`)
- Reduced false-zero amounts caused by same-block transaction ordering

---

## v2.0 — L2 balance reliability and budgeted full-scan loop (Feb 12, 2026)

**Commits:** `58c4f05`, `77dad70`, `28a7ead`, `add68dc`, `fb7e7d6`, `7d9e677`

- Introduced shared per-run subrequest budget and least-synced-first config ordering
- L2 balance strategy evolved from Etherscan-only to RPC fallback and then dRPC archive support
- Backfill was prioritized ahead of incremental scanning
- Added chain-head caching/advancement to reduce repeated rescans and stale cursors

---

## v1.2 — Coverage expansion: USDT0 and gold contracts (Feb 11, 2026)

**Commits:** `b257569`, `9281531`, `eeb92e9`, `2fd5065`, `29a4759`

- Added USDT0 event families (`BlockPlaced`, `BlockReleased`, `DestroyedBlockedFunds`)
- Added PAXG and XAUT tracking with token-specific event mappings
- Added per-contract decimals (including 18-decimal assets) and corrected amount parsing paths
- Added Tron address normalization (`0x` to `41` format) for account-balance lookups

---

## v1.1 — Ingestion-time balance enrichment + backfill foundation (Feb 11, 2026)

**Commit:** `1dec7aa`

- New events began receiving balance enrichment before insert
- Added retroactive backfill for historical rows missing amount values
- Established baseline for later destroy-event amount recovery improvements

---

## v1.0 — Initial Blacklist Tracker release (Feb 9-10, 2026)

**Commits:** `093c11e`, `ea9dbab`, `5158601`, `ac0d823`

- Launched incremental blacklist event sync across EVM and Tron
- Introduced normalized storage (`blacklist_events`) plus sync cursors (`blacklist_sync_state`)
- Shipped initial API + dashboard integration for blacklist event visibility

---

## Notes

- Blacklist Tracker did not initially ship with explicit version tags; versions above are reconstructed from behavior-affecting commit boundaries.
- Canonical methodology metadata is encoded in `shared/lib/blacklist-tracker-version.ts` and is already surfaced through the blacklist API envelope plus the `/blacklist/` page shell.
