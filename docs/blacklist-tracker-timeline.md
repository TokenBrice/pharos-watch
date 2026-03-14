# Blacklist Tracker Methodology — Version Timeline

Internal changelog reconstructed from git history. Covers Blacklist Tracker `v1.0` through `v3.1` (2026-02-09 -> 2026-02-25).

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
