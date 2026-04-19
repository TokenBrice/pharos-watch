# Blacklist Tracker Methodology — Version Timeline

Internal changelog reconstructed from git history. Covers Blacklist Tracker `v1.0` through `v3.97` (2026-02-09 -> 2026-04-19).

---

## v3.97 — Status amount-gap tolerance (2026-04-19)

- **Recent-gap warning floor** — A single unresolved provider/parser miss no longer degrades `/status` or `/admin`; recent blacklist amount gaps now need at least 5 rows in the 24-hour monitoring window before data quality degrades
- **Stale threshold unchanged** — Stale severity still begins at 25 recent gaps or a 2% missing-amount ratio
- **Ratio threshold unchanged** — The 1% degraded missing-ratio threshold remains in place so broad amount-attribution failures still surface promptly

---

## v3.96 — Gentle amount-gap recovery acceleration (2026-04-18)

- **EVM recovery lane unblocked** — The per-row amount recovery pass now excludes Tron rows, which are owned by the separate Tron ledger mirror, so recent Tron pending rows no longer prevent the EVM backlog from draining
- **Conservative batch increase** — The amount-recovery cap increased from 50 to 100 rows per 6-hour `sync-blacklist` run, keeping writes inside one shared D1 batch chunk and under the existing 900-subrequest sync budget
- **Operational validation** — The first post-fix production run drained historical EVM amount gaps without new API errors; the higher cap is intended to accelerate cleanup while preserving the existing cron cadence, lease, rate limiters, and subrequest ceiling

---

## v3.95 — Tier-1 coverage expansion (2026-04-17)

- **TUSD coverage** — Added new `TRUEUSD_EVENT_FAMILY` on Ethereum: single `Blacklisted(address,bool)` topic with direction resolved from the bool at data slot 0 via the new `BlacklistEventDef.eventTypeFromDataBoolIndex` extension, plus `DestroyedBlackFunds(address,uint256)` (reuses the USDT legacy destroy topic)
- **NUSD coverage** — Added new `NEUTRL_DENYLIST_FAMILY` on Ethereum: `AddedToDenylist(address indexed)` / `RemovedFromDenylist(address indexed)`
- **EURCV coverage** — Added new `SOCGEN_FREEZE_FAMILY` on Ethereum: batch `AddressesFrozen(address[])` / `AddressesUnFrozen(address[])` via the shared `addressArrayData` path
- **USDA / USAT / AEUR coverage** — Reuse existing families: USDA uses USDT legacy, USAT uses USDT0, AEUR uses `DUAL_INDEX_FREEZE_EVENT_FAMILY` (Ethereum)
- **XUSD / XAUm coverage** — Reuse existing families: XUSD uses the Circle USDC blacklist family on Ethereum + BSC, XAUm uses the USDT0 family on Ethereum + BSC
- **JPYC coverage** — Added new `CENTRE_BLOCKLISTED_FAMILY` on Ethereum + Polygon: `Blocklisted(address indexed)` / `UnBlocklisted(address indexed)` (distinct spelling from USDC's `Blacklisted`/`UnBlacklisted`)
- **FRXUSD coverage** — Added new `FRAX_FREEZE_FAMILY` on Ethereum: `AccountFrozen(address)` / `AccountThawed(address)` with non-indexed address resolved via `addressDataIndex=0`
- **FIDD coverage** — Added new `FIDELITY_RESTRICTION_FAMILY` on Ethereum: `TransferRestrictionImposed(address indexed)` / `TransferRestrictionRemoved(address indexed)`
- **Deferrals** — BSC / Avalanche / Base deployments for TUSD, USDA, AEUR, JPYC, AID, and TGBP are deferred pending Etherscan v2 free-tier contract-creation coverage for those chains (captured as inline `TODO: verify on <chain>` comments). apxUSD deferred because its verified ABI emits a single event without a direction discriminator.

---

## v3.94 — Correctness + efficiency + minor coverage gaps (2026-04-17)

- **Phase 1 correctness** — Gnosis dRPC scan window capped at 9k blocks per request, dual-index freeze family split from WLFI destroy events (FDUSD / EURI / U no longer carry `FrozenAccountDrained` / `FrozenFundsReallocated` topics they cannot emit), TronGrid failures now propagate to the per-config circuit breaker, EURC rows flagged as `circle_mirror_zero_balance` are stamped `amount_status='permanently_unavailable'`, batch `address[]` events apply a per-log row cap, Tron sync cursor initialises from `lastTimestampMs` for empty configs instead of collapsing to 0
- **Phase 2 migrations** — Five D1 migrations applied: 0100 dedup mixed-case `blacklist_sync_state` keys, 0101 reset pre-v3.2 `derived` amount rows into the backfill pool, 0102 reseed the Gnosis BRZ cursor to startBlock-1 so the fixed scanner begins a clean catch-up, 0103 add composite backfill + API-filter indexes on `blacklist_events`, 0104 stamp the 917 existing EURC mirror-zero rows as `permanently_unavailable`
- **Phase 3 efficiency** — `/api/blacklist-summary` rewritten to aggregate quarterly chart points and per-coin counts in SQL; post-fetch counters inlined so summary-endpoint memory drops from ~5–10MB to a few KB per cache miss
- **Phase 4 frontend polish** — Data-driven stats strip + amount-status badge, per-coin stat border rendered via inline style, CSV split into native / unit / USD / status columns, page-clamp + zero-total + filter-reset covered by tests
- **Phase 5 minor coverage gaps** — Added Polygon USDQ, Arbitrum + Base AID, and Base + BSC + Polygon TGBP chain-coverage rows for existing coins
- **Operational note** — Post-merge, Gnosis BRZ begins at block 33,257,602 and catches up via 9k-block windows, so the two known missed events (blocks 45,229,172 and 45,229,396) will arrive at the end of a ~1,400-run catch-up (approximately two months of hourly cron runs). This is expected and not a regression.

---

## v3.93 — Backlog-safe scanner guardrails (2026-04-16)

- **Partial-topic cursor safety** — EVM sync cursors stay pinned when the subrequest budget is exhausted before every configured event topic has been scanned
- **Budget status accuracy** — Runs that skip configs after exhausting the subrequest budget now surface as degraded instead of ok
- **D1 chunk safety** — Duplicate-row checks use smaller D1-safe chunks for high-row event batches

---

## v3.92 — Amount attribution: Tron ledger mirror + derived-zero recovery (2026-04-16)

- **Tron ledger mirror** — Tron USDT blacklist/unblacklist rows can receive amounts from the freeze-ledger snapshot using `current_balance_snapshot`
- **Derived-zero recovery** — Legacy derived-zero EVM rows re-enter the backfill pool for amount remediation
- **Amount provenance** — Snapshot-sourced amounts render with a dedicated provenance badge

---

## v3.91 — Coverage quality + USDP addition (2026-04-16)

- **WLFI destroy events** — Added `FrozenAccountDrained` and `FrozenFundsReallocated` tracking for USD1/U/FDUSD/EURI
- **USDP coverage** — Added Pax Dollar Ethereum coverage using the Paxos freeze family
- **Start-block corrections** — Corrected Arbitrum start blocks for FDUSD, AUSD, and BUIDL

---

## v3.9 — Direct EVM coverage wave (2026-04-15)

- **FDUSD coverage** — Added Ethereum, BSC, and Arbitrum `Freeze` / `Unfreeze` tracking
- **BRZ coverage** — Added Ethereum and Gnosis `Blacklisted` / `UnBlacklisted` tracking with BRL-denominated USD conversion
- **AUSD coverage** — Added Arbitrum and Base `AccountFrozen` / `AccountUnfrozen` tracking
- **MNEE coverage** — Added Ethereum freeze/unfreeze plus `FundsConfiscated` / `HoldingsBurnt` destroy tracking with indexed amount extraction
- **EURI, USDQ, USDO, USDX, AID, and TGBP coverage** — Added direct EVM event families for issuer block/ban/deny-list events where verified ABIs expose per-address controls
- **EURC coverage** — Re-enabled EURC on Ethereum, Base, and Avalanche with suppression metadata for Circle mirror-zero rows
- **BUIDL seize-only coverage** — Added Securitize `Seize` and `OmnibusSeize` tracking across BUIDL EVM deployments as destroy/seized-value events
- **Non-USD valuation** — EURC, BRZ, EURI, and TGBP now use coin-specific price-cache conversion for public USD values

---

## v3.8 — First-wave CeFi coverage expansion (2026-04-15)

- **USDG coverage** — Added Paxos-style `FreezeAddress`, `UnfreezeAddress`, and `FrozenAddressWiped` tracking for Global Dollar on Ethereum
- **RLUSD coverage** — Added Ripple USD `AccountPaused` and `AccountUnpaused` tracking on Ethereum; clawback remains out of scope until transaction-input classification exists
- **U coverage** — Added United Stables `Freeze` and `Unfreeze` tracking on Ethereum and BSC using the dual-indexed account address pattern
- **USDtb coverage** — Added Ethena/Anchorage USDtb `AccountsBlocked(address[])` and `AccountsUnblocked(address[])` tracking on Ethereum, expanding one batch log into one row per affected address
- **A7A5 coverage** — Added Old Vector A7A5 `Blacklisted`, `DeBlacklisted`, and `DestroyedBlackFunds` tracking on Ethereum
- **Non-USD valuation** — A7A5 frozen/destroyed value now uses the `a7a5-old-vector` price-cache entry for USD conversion instead of treating RUB units as dollars

---

## v3.7 — Balance recovery accuracy and provider resilience (2026-04-08)

- **Invalid block tags rejected** — `fetchEvmBalanceAtTag` now returns null on malformed hex block tags instead of silently falling back to `latest`, preventing silent historical→current balance substitution
- **Ethereum mainnet dRPC/RPC fallback** — Mainnet historical balance lookups now try dRPC and chain-RPC before Etherscan, eliminating the single-provider-failure blind spot for ~60% of events
- **Tron REST null-for-missing** — `fetchTronTokenCurrentBalance` REST fallback returns null when the target token is absent from the TRC20 balance array, preventing false zero entries in the freeze ledger
- **Gold price in enrichment** — `enrichRowBalances` and `backfillAmounts` now receive gold spot price so PAXG/XAUT events get `amount_usd_at_event` during ingest, not only in the freeze-ledger cache
- **Gold-only zero-balance override** — The `balanceOf() → 0` fallback (for contracts that return 0 for frozen addresses) is now scoped to PAXG/XAUT only, preventing false non-zero cache entries for USDC/USDT/pyUSD/USD1 destroyed addresses
- **XAUT own price** — XAUT freeze-ledger amounts now use the `xaut-tether` price entry instead of sharing `paxg-paxos`
- **Destroyed excluded from frozen total** — `activeFrozenTotal` no longer includes destroyed/seized amounts
- **Tron status reclassification** — New Tron blacklist/unblacklist events are immediately marked `permanently_unavailable` during enrichment instead of cycling through backfill indefinitely
- **Minor fixes** — block_number guard, destroy event observedAt uses event timestamp, attemptCount accumulates across cycles, Tron address fallback chain cleaned up, dead `otherAddresses` map removed, gap metrics scoped to blacklist+destroy events

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
