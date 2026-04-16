# Blacklist Tracker — Agent A: Data Accuracy Audit

**Date:** 2026-04-16
**Scope:** `/blacklist` feature (cron ingestion, parsing, persistence, API exposure)
**Focus:** data accuracy, correctness of event decoding, start-block fidelity, sync-state progression, suppression correctness, methodology tagging

## Executive Summary

1. **Methodology tagging is broken (HIGH).** Two version entries (`v3.8` and `v3.9`) share an identical `effectiveAt` timestamp. The generic `getVersionAt` resolver iterates windows after a stable sort by `effectiveAt`, so the *later-defined* v3.8 overwrites v3.9. Every event ingested on or after 2026-04-15 is stored and surfaced as `methodology_version = "3.8"` even though the advertised `currentVersion = "3.9"` and the API envelope reports `3.9`. Users comparing per-row methodology to `currentVersion` will see all new events flagged as "behind current."
2. **BUIDL `Seize` amount decoding is silently corrupted (CRITICAL, latent).** `SECURITIZE_SEIZE_EVENT_FAMILY` declares `Seize(address,address,uint256,string)` with `hasAmount: true` but no `amountDataIndex` override. Because both addresses are indexed (confirmed against the verified Securitize implementation at `0x603bb6909be14f83282e03632280d91be7fb83b2`), `parseEvmLogs` falls through to `decodeUint256(log.data, config.decimals)` which parses the entire concatenated `(value, reasonOffset, reasonLength, reasonBytes)` as a single BigInt. If a Seize event ever fires, the persisted `amount_native` will be astronomically wrong. OmnibusSeize is safe because it has an explicit `amountDataIndex: 1`.
3. **Three Arbitrum `startBlock` values are wildly wrong, causing coverage holes (HIGH).** Verified against Blockscout creation-tx metadata:
   - FDUSD Arbitrum: claimed `452_845_221` (2026-04-15); real deploy = block `336_278_229` (2025-05-13). ~117M blocks (~11 months) silently skipped.
   - AUSD Arbitrum: claimed `431_248_926` (2026-02-12); real deploy = block `342_153_906` (2025-05-30). ~89M blocks (~8.5 months) silently skipped.
   - BUIDL Arbitrum: claimed `452_787_226` (2026-04-15); real deploy = block `270_969_308` (2024-11-04). ~181M blocks (~17.5 months) silently skipped.
   All three production sync cursors are pinned at `452_898_371` (chain head − margin) after their first "successful, no events" scan, and the cron has no way to rewind past a wrong `startBlock`.
4. **Six Ethereum configs have been throwing `exception:Error` on every cron run (HIGH).** Latest `cron_runs` metadata shows persistent `exception:Error` for USDG Ethereum, RLUSD Ethereum, USDO Ethereum, EURC Ethereum, EURC Base, EURI BSC, USDC Arbitrum, and USDC Base. USDG (237 `FreezeAddress` events on-chain), RLUSD (179 `AccountPaused`), and USDO (170 `AccountBanned`) have significant historical coverage and **zero rows** in the production `blacklist_events` table. USDC Arbitrum is ~9 days behind chain head. No production data has ever been ingested for USDG/RLUSD/USDO because the sync state never advances past the exception.
5. **`circle_mirror_zero_balance` suppression only runs at ingestion (MEDIUM).** `backfillAmounts` can later recover a missing amount to `0` and leave `suppression_reason = NULL`, producing unsuppressed EURC rows with `amount_native = 0` that the public API will surface. Currently 0 such rows in prod, but the latent bug will bite once enrichment fails for any fresh mirror-zero event.

---

## Critical Issues

### C1 · `Seize(address,address,uint256,string)` amount decoding is wrong

- **File:** `worker/src/lib/blacklist-contracts.ts:451-469`, `worker/src/cron/blacklist/evm-source.ts:159-171`
- **Evidence:** The Securitize BUIDL implementation at `0x603bb6909be14f83282e03632280d91be7fb83b2` defines
  `Seize(address indexed from, address indexed to, uint256 value, string reason)`. Both address params are indexed, so `topics.length > 1` and `parseEvmLogs` takes the `addressIndexed` branch at line 164-166, calling `decodeUint256(log.data, config.decimals)` on the full data blob. Because `reason` is dynamic, the data layout is `[value (32B), reason_offset (32B), reason_length (32B), reason_bytes (padded)]`. `decodeUint256` parses the whole thing as a single BigInt, so the returned amount will be `(value << 224) + (offset << 160) + (length << 96) + reason_packed`.
- **Impact:** The first BUIDL Seize event (no instance exists yet on any tracked chain) will be stored with a wildly inflated `amount_native`, poisoning `destroyedTotal`, summary cards, and the blacklist chart for BUIDL.
- **Fix:** Add `addressDataIndex` is not needed (topic-based); add `amountDataIndex: 0` to the Seize definition so the parser reads slot 0 (`value`) directly. Alternatively, short-circuit the fallthrough by always preferring `amountDataIndex` when `data.length > 66` with dynamic tail data.
- **Test:** `worker/src/cron/blacklist/__tests__/evm-source.test.ts` covers `OmnibusSeize` but has no test case for `Seize`. Add a fixture using `encodeAbiParameters([{type:"uint256"},{type:"string"}], [25_000_000n,"test"])` for the data field and both `from`/`to` in topics[1]/[2], asserting `amount_native === 25`.
- **Status:** latent — no Seize events have been emitted on Ethereum, BSC, Optimism, Arbitrum, Avalanche, or Polygon BUIDL contracts to date, so the bug is undetected in production.

---

## High

### H1 · Methodology version tagging resolves to `"3.8"` for every post-2026-04-15 event

- **File:** `shared/lib/blacklist-tracker-version.ts:8-24`, `shared/lib/methodology-version.ts:60-87`
- **Evidence:** Both `v3.9` and `v3.8` entries declare `effectiveAt: 1776211200`. Simulation with the exact algorithm (sorted descending by version, then stable-sorted ascending by `effectiveAt`) produces windows order `...,3.7,3.9,3.8`. The loop iterates in that order and overwrites `resolved` to whichever window comes *last* among peers, so `getVersionAt(now)` returns `"3.8"`, not `"3.9"`.
- **Impact:**
  1. Every new row ingested since 2026-04-15T00:00:00Z is persisted with `methodology_version = "3.8"`.
  2. `worker/src/api/blacklist.ts:127` derives `methodologyVersion` from the latest event's stored version, so `methodology.version` in API responses also resolves to `"3.8"`, while `methodology.currentVersion = "3.9"` (from the top-level constant). Envelope and row tags disagree, and `isCurrent = false` for all fresh rows.
  3. Historical reproducibility is broken — future tooling that filters `WHERE methodology_version = '3.9'` will see zero rows.
- **Fix options (pick one):**
  - Bump `v3.9.effectiveAt` forward by 1 second (`1776211201`).
  - Change `getVersionAt` to break ties with `compareMethodologyVersions` (prefer the higher version when `effectiveAt` matches).
  - Re-sort `windows` by `(effectiveAt, semver-desc)` so higher versions with equal timestamps come last in iteration.
- **Affects callers:** `worker/src/cron/blacklist/evm-source.ts:99` (ingestion), `worker/src/cron/blacklist/tron-source.ts:61`, `worker/src/lib/blacklist-api.ts:60` (fallback on null).

### H2 · Arbitrum `startBlock` values for FDUSD / AUSD / BUIDL are in the future

- **File:** `worker/src/lib/blacklist-contracts.ts:563,566,588`
- **Evidence (Blockscout creation-tx lookups):**
  | Symbol | Config `startBlock` | Real deploy block | Real deploy timestamp |
  | --- | --- | --- | --- |
  | FDUSD Arbitrum (`0x93c9...9fe`) | `452_845_221` | `336_278_229` | 2025-05-13 14:16:17 UTC |
  | AUSD Arbitrum (`0x0000...012a`) | `431_248_926` | `342_153_906` | 2025-05-30 16:18:44 UTC |
  | BUIDL Arbitrum (`0xa652...5872`) | `452_787_226` | `270_969_308` | 2024-11-04 14:14:49 UTC |
- **Prod cursor state:** all three production `blacklist_sync_state` rows are pinned at `452_898_371` (chain head − 15 minutes), confirming the initial scan ran with the wrong start block, saw zero events in the tiny `[startBlock, head]` window (or a negative window for FDUSD/BUIDL), and advanced the cursor via the no-events advancement path at `sync-blacklist.ts:322-345`. No admin endpoint rewinds past `startBlock`, so this historical window is permanently skipped unless (a) `startBlock` is corrected AND (b) the rows are manually reset in `blacklist_sync_state`.
- **Impact:** Any past Freeze/AccountFrozen/Seize/OmnibusSeize events on Arbitrum FDUSD, AUSD, or BUIDL are missing from production data. I could not confirm via public RPC whether any such events exist, but the risk is large — BUIDL's window covers ~18 months of active Securitize compliance activity.
- **Fix:**
  1. Correct `startBlock` to the real deployment blocks above.
  2. Delete the affected `blacklist_sync_state` rows (or use Time Travel / `reset-blacklist-sync` with a large enough rewind) to force a re-scan.

### H3 · Wave-2a configs are throwing `exception:Error` every cron run and never advance

- **File:** `worker/src/cron/sync-blacklist.ts:358-364` (top-level try/catch swallows stack), `worker/src/handlers/scheduled.ts`
- **Evidence:** Latest three `sync-blacklist` runs (started_at 1776286987/1776290587/1776294187) report these configs under `apiErrorConfigs` with `reason: "exception:Error"`:
  - `ethereum-0xe343167631d89b6ffc58b88d6b7fb0228795491d` (USDG) — persistent, no sync-state row, `zeroCursor`.
  - `ethereum-0x8292bb45bf1ee4d140127049757c2e0ff06317ed` (RLUSD) — persistent, no sync-state row, `zeroCursor`.
  - `ethereum-0x8238884ec9668ef77b90c6dff4d1a9f4f4823bfe` (USDO) — persistent, no sync-state row, `zeroCursor`.
  - `ethereum-0x1abaea1f7c830bd89acc67ec4af516284b1bc33c` (EURC) — persistent, `zeroCursor`. Currently 451 rows exist in prod tagged with earlier methodology versions, so it was working at least once.
  - `base-0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42` (EURC Base) — persistent.
  - `bsc-0x9d1a7a3191102e9f900faa10540837ba84dcbae7` (EURI BSC) — persistent.
  - `base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` (USDC Base) — current.
  - `arbitrum-0xaf88d065e77c8cc2239327c5edb3a432268e5831` (USDC Arbitrum) — current; cursor pinned at `449_906_401` = **~8.7 days behind chain head**.
- **Real-world coverage loss:** Blockscout confirms 237 historical `FreezeAddress` events on USDG Ethereum (block range 20,943,760 → 24,685,497), 179 `AccountPaused` on RLUSD Ethereum (20,492,376 → 24,645,052), and ≥170 `AccountBanned` on USDO Ethereum. Production has **zero** rows for any of these three stablecoins. Every cron run re-attempts the initial scan from `startBlock` and fails with the same generic `Error`, so there is no coverage gap leakage (`newBlock` is never written), but there is also no forward progress.
- **Cause (unverified without stack traces):** The exception is caught by the top-level `catch (err)` at `sync-blacklist.ts:358` and reported as `err.name`, which for plain `Error` objects is just `"Error"`. This is consistent with `throwIfAborted`, `BigInt()` parse failures, or any unhandled Promise rejection inside `processFetchedBlacklistRows`, `enrichRowBalances`, `syncCurrentBalanceCacheForRows`, `batchExecute`, or one of the provider helpers. A diagnostic patch that preserves `err.message` / stack in `apiErrorConfigs` should be the first remediation step.
- **Fix:** (1) Log the full error message alongside `exception:Error` so the actual failure mode can be diagnosed; (2) once diagnosed, either make the failing path tolerant or fix the upstream data/contract; (3) once the exception is gone, the automatic retry will catch up without needing admin intervention.

### H4 · `newBlock` advances to chain head on a genuinely-empty initial scan, erasing future rescan opportunities

- **File:** `worker/src/cron/sync-blacklist.ts:318-346`
- **Issue:** On the very first run of a new config, `lastBlock = 0` and `fromBlock = configuredStartBlock`. If Etherscan/RPC returns `[]` for the scan window, the code records a successful empty scan and writes `newBlock = head - safetyMargin`. Future runs will never look earlier than `lastBlock + 1`. This is the intended "happy path" but also the mechanism that hides the H2 Arbitrum start-block errors — once the sync state says `head - margin`, a corrected `startBlock` has no effect unless the sync state row is deleted.
- **Impact:** Any config whose first run happens while its `startBlock` is wrong will permanently skip the historical gap. There is no "re-bootstrap" command that checks for `startBlock` regressions. The `POST /api/reset-blacklist-sync` admin endpoint only rolls back 50k blocks (`~7 days on Ethereum`), insufficient to recover the Arbitrum holes.
- **Recommended remediation:** Add a `force-reset` admin path that lets operators set `last_block = 0` (or delete the row) for a specific `config_key`, and call it whenever a `startBlock` is corrected.

### H5 · Methodology version docs drift

- **File:** `docs/blacklist-tracker.md:649`
- **Evidence:** The `stablecoin` query-param docs still list the pre-wave-2a symbols (`USDC, USDT, PAXG, XAUT, PYUSD, USD1, USDG, RLUSD, U, USDTB, A7A5` — 11 symbols). The current `BLACKLIST_STABLECOINS` enum in `shared/types/market.ts:419-443` has **23** symbols. Line 656 immediately below correctly enumerates all 23, so the page is self-inconsistent.
- **Impact:** Third-party consumers reading the API docs will think they cannot filter by FDUSD/BRZ/AUSD/MNEE/EURI/USDQ/USDO/USDX/AID/TGBP/EURC/BUIDL.
- **Fix:** Update the param table to list all 23 supported symbols.

---

## Medium

### M1 · `circle_mirror_zero_balance` suppression only runs at ingestion, not during backfill

- **File:** `worker/src/cron/blacklist/post-fetch.ts:104-112`, `worker/src/cron/blacklist/amount-recovery.ts:253-472`
- **Issue:** The suppression check runs only in `processFetchedBlacklistRows` after the first enrichment attempt. If that enrichment returns `null` (provider failure on a brand-new EURC event), the row is persisted with `amount_native = null` and `suppression_reason = null`. `backfillAmounts` later retries the balance, and on success may set `amount_native = 0` via SQL `UPDATE`. The `UPDATE` never touches `suppression_reason`, so the row remains unsuppressed even though it now meets the mirror-zero criterion. That row would be exposed by `/api/blacklist` (which only filters `suppression_reason IS NULL`).
- **Impact:** Latent data leak — users could see EURC blacklist rows with `amount_native = 0` that should have been suppressed. Currently 0 such rows in prod (`SELECT COUNT(*) FROM blacklist_events WHERE stablecoin='EURC' AND suppression_reason IS NULL` → 0), but the bug is armed and will fire the first time provider enrichment transiently fails on a fresh mirror row.
- **Fix:** Add an equivalent suppression check inside `backfillAmounts` right before the SQL `UPDATE`, or wrap it into a shared helper called from both ingestion and backfill paths.

### M2 · EURC `amount_native === 0` check skips enrichment failures

- **File:** `worker/src/cron/blacklist/post-fetch.ts:104-112`
- **Issue:** The suppression condition is `row.amount_native === 0`. When `enrichRowBalances` fails (provider error), `amount_native` stays `null`, so `0 !== null` — the row falls through suppression even though it's almost certainly a mirror-zero case (only real EURC clawbacks have ever produced non-zero balances, and there are none in recorded history). Combined with M1, this means both (a) the initial ingestion and (b) the subsequent backfill have independent loopholes.
- **Fix:** Consider treating EURC blacklist/unblacklist events with *unresolved* amounts as "suppression_reason = circle_mirror_zero_balance" defensively, with an explicit reconciliation flow to un-suppress rare legitimate non-zero freezes.

### M3 · Partial Tron scans can skip events across event types

- **File:** `worker/src/cron/blacklist/tron-source.ts:109-170`, `worker/src/cron/sync-blacklist.ts:234-238`
- **Issue:** `fetchTronEventsIncremental` iterates event types sequentially (`AddedBlackList`, then `RemovedBlackList`, then `DestroyedBlackFunds`) and updates a single shared `maxBlock`. If the first event type fetches all pages successfully (reaching a very recent `block_timestamp`), and the second event type times out mid-pagination, `result.maxBlock` is still the recent value from the first event type. `syncBlacklist` then advances `last_block` to that recent timestamp, silently skipping any un-fetched events from the other event types in the `[old_lastBlock, maxBlock]` window.
- **Impact:** Low — currently only USDT Tron and USD1 Tron are scanned via this path, and USDT Tron is mostly a "catch up" sync. But the bug is real and will bite if USDT Tron ever has a large paginated page over a long time window.
- **Fix:** Track `maxBlock` per event type and advance `last_block` to `min(perEventMax)` when any event type was incomplete, or short-circuit all pending event types when any one is incomplete.

### M4 · Tron `tronResultKey` fallback picks wrong positional slot for dual-address events

- **File:** `worker/src/cron/blacklist/tron-source.ts:50-54`
- **Issue:** For USD1 Tron Freeze events, `tronResultKey: "account"` tells the code to read `evt.result.account`. If TronGrid returns positional keys only (`{"0": "0xcaller", "1": "0xaccount"}`), the named lookup misses, `_user` / `_blackListedUser` also miss, and the fallback `evt.result["0"]` picks the **caller**, not the **affected account**. Production currently has zero USD1 Tron events so this is untested.
- **Impact:** Latent — a future USD1 Tron Freeze event could be recorded with the wrong target address. Non-diagnostic: would appear as a valid row, just pointing at the wrong account.
- **Fix:** When `eventDef.tronResultKey` is set and both slots `"0"`/`"1"` exist, treat `"0"` as `caller` and prefer `"1"` as the affected account for dual-indexed Freeze patterns. Or simply require `tronResultKey` to always resolve (throw if missing) for USD1-family events.

### M5 · Gnosis chain missing from `EVM_BLOCK_TIME` safety margin table

- **File:** `worker/src/cron/sync-blacklist.ts:40-53`
- **Issue:** Gnosis (chain ID 100) is not in the `EVM_BLOCK_TIME` map, so `evmSafetyMarginBlocks(100)` falls back to the default `2 s` block time and returns `450` blocks. Real Gnosis block time is ~5 s, so the margin corresponds to ~37.5 minutes rather than the intended 15 minutes. Over-conservative, not under-conservative, so it's not a data-loss bug, but the docs in `docs/blacklist-tracker.md:594-611` omit Gnosis entirely.
- **Fix:** Add `100: 5` to `EVM_BLOCK_TIME` and add a Gnosis row to the docs table.

### M6 · Duplicate mixed-case/lowercase `blacklist_sync_state` rows (legacy ghosts)

- **File:** `worker/src/lib/db.ts:48-77`
- **Evidence:** Production contains stale rows such as `ethereum-0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c`, `ethereum-0x45804880De22913dAFE09f4980848ECE6EcbAf78`, `ethereum-0x68749665FF8D2d112Fa859AA293F07A622782F38`, `optimism-0x01bFF41798a0BcF287b996046Ca68b395DbC1071`, and `tron-TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`. These were written before `setLastBlock` normalized config keys to lowercase. Since `getLastBlock` merges via `IN (lowercase, original)` and takes the max, correctness is maintained — but the stale rows are dead weight and will continue to drift.
- **Fix:** One-shot migration that deletes `blacklist_sync_state` rows whose key doesn't match `normalizeBlacklistSyncStateKey(key)` and whose corresponding lowercase row has a higher `last_block`. Not urgent.

### M7 · `fetchBlacklistAssetPriceFromCache` called once per row in `backfillAmounts`

- **File:** `worker/src/cron/blacklist/amount-recovery.ts:335-337`
- **Issue:** Inside the backfill for-loop, the per-row `assetPriceUsd` lookup is a fresh `SELECT price FROM price_cache WHERE asset_id = ?`. With `BACKFILL_BATCH_SIZE = 50`, that's up to 50 extra DB reads per cycle. Not a correctness issue, but wastes D1 quota and latency.
- **Fix:** Hoist the lookup out of the loop and memoize per `config.stablecoin`, or precompute a `Map<stablecoin, price>` over the distinct symbols in the batch.

---

## Low

### L1 · Methodology envelope inconsistency between `/api/blacklist` and `/api/blacklist-summary`

- **File:** `worker/src/api/blacklist.ts:124-141`, `worker/src/api/blacklist-summary.ts:55-77`
- **Issue:** `/api/blacklist` derives `methodology.version` from the latest returned event's stored version (so it can be "3.8" even when the tracker itself is at "3.9"). `/api/blacklist-summary` unconditionally reports the constant `BLACKLIST_TRACKER_METHODOLOGY_VERSION` ("3.9"). Once H1 is fixed both will line up, but the behavior difference is worth noting for anyone reconciling envelopes.
- **Fix:** Once H1 is resolved, double-check both envelopes return the same `version` for the same `asOf`.

### L2 · `blacklist-summary.ts` filters suppression in JS instead of SQL

- **File:** `worker/src/api/blacklist-summary.ts:31-42`
- **Issue:** `/api/blacklist-summary` pulls *all* rows (including suppressed) via `SELECT ... FROM blacklist_events ORDER BY timestamp DESC` and filters with `.filter((e) => e.suppressionReason == null)` in memory. Aggregators then see only unsuppressed rows (correct), but the DB still ships the suppressed rows over the wire. For EURC that's 451 extra rows per request today and grows forever. `/api/blacklist` uses `WHERE suppression_reason IS NULL` in SQL, which is cheaper.
- **Fix:** Add `WHERE suppression_reason IS NULL` to the summary query to reduce D1 rows_read.

### L3 · Docs drift: `Ethereum only` comment on A7A5 is partially accurate

- **File:** `worker/src/lib/blacklist-contracts.ts:557`
- **Issue:** The comment says `A7A5 (Old Vector — Ethereum only; Tron requires separate result-key verification)`, but the stablecoin JSON declares a Tron contract (`TLeVfrdym8RoJreJ23dAGyfJDygRtiWKBZ`). The exclusion is intentional, but the comment is easy to misread.
- **Fix:** Clarify the comment to note Tron coverage is deferred pending ABI verification, or inline the Tron contract address for future reference.

### L4 · `getBlacklistTopicHashes` dedup is technically unnecessary

- **File:** `worker/src/lib/blacklist-contracts.ts:640-644`
- **Issue:** The `[...new Set(...)]` dedup protects against a config that declares two events with the same topic hash. That never happens in practice (each event family has unique topics), and the only real collision would be across configs (not the same config). Minor.
- **Fix:** None required.

### L5 · `blacklist-tracker.md` L2 safety margin section omits Gnosis (see also M5)

- **File:** `docs/blacklist-tracker.md:594-611`
- **Fix:** Add Gnosis (5 s block time, 180 block margin) row.

---

## Verified Correct

These invariants were specifically checked and are currently working as intended:

1. **All 34 event topic hashes match Keccak256 of their declared signatures.** Verified by computing Keccak256 with `viem/utils` for every signature defined in `worker/src/lib/blacklist-contracts.ts:85-452` and comparing against the stored topic hash constants. No mismatches.
2. **Contract addresses align between `blacklist-contracts.ts` (via `resolveRequiredTrackedContractConfig`) and `shared/data/stablecoins/*.json`.** Spot-checked USDC, USDT (primary + Optimism traded), PAXG, XAUT, pyUSD, USD1, USDG, RLUSD, U, USDtb, A7A5, FDUSD, BRZ (Ethereum + Gnosis), AUSD (Arbitrum + Base), MNEE, EURI, USDQ, USDO (Ethereum + Base), USDX, AID, TGBP, EURC (3 chains), and BUIDL (6 chains). All primary/traded/decimal tuples match the tracked-contract resolver output.
3. **Decimals are correct for every sampled contract.** USDC/USDT-family = 6, PAXG = 18, XAUT = 6, BSC USDT = 18, BRZ Ethereum = 18, TGBP = 18, USD1 = 18, etc. No decimals collisions.
4. **Ethereum start blocks are accurate.** Binary-searched via `eth_getCode` on public Ethereum mainnet RPC for EURC, RLUSD, USDG, USDtb, A7A5, U, USD1, FDUSD, BRZ, MNEE, EURI, USDQ, USDO, USDX, AID, TGBP, BUIDL — every claimed `startBlock` matches the true deployment block.
5. **Avalanche start blocks are accurate.** USDC, USDT, EURC, TGBP, and BUIDL Avalanche confirmed against Routescan / Blockscout creation txs.
6. **Gnosis and Base start blocks are accurate.** BRZ Gnosis (`33_257_603`) and EURC Base (`15_107_859`), USDO Base (`25_154_101`), BUIDL Polygon (`63_877_025`), BUIDL Optimism (`127_565_419`) all confirmed via Blockscout creation-tx lookups.
7. **USDC, USDT, PAXG, pyUSD, USDG, RLUSD, USDtb, MNEE, BRZ, AUSD, FDUSD, EURI, USDQ, USDO, USDX, AID, TGBP, XAUT event ABI shapes match the code's assumptions** (indexed vs non-indexed address, `hasAmount`, `addressTopicIndex`, `addressDataIndex`, `amountTopicIndex`, `amountDataIndex`). Verified by fetching live contract ABIs from Blockscout for the implementation (post-proxy) of each contract. Notably:
   - USDG, pyUSD, USDtb, USDQ, MNEE, USD1, FDUSD, EURI, TGBP, USDO use **indexed** addresses (`topics[1]` or `topics[2]`).
   - USDT legacy, RLUSD, USDX, AID, USDtb-array, A7A5 all use **non-indexed** addresses (data field).
   - MNEE `FundsConfiscated(address indexed, uint256 indexed, address indexed)` uses **3 indexed params**; `amountTopicIndex: 2` is correct.
   - OmnibusSeize has `addressDataIndex: 0`, `amountDataIndex: 1` — correct for the `(omnibusWallet indexed, from, value, reason, assetTrackingMode)` shape.
8. **USDtb `AccountsBlocked(address[])` decoding via `decodeAbiParameters([{type:"address[]"}], data)` handles the real ABI-encoded layout.** Live data sample (block 22+) has `offset=0x20`, `length=0x0a`, followed by 10 address slots; parsed correctly.
9. **A7A5 topic hash reuse of `USDC_BLACKLISTED_TOPIC` is intentional and safe.** The A7A5 contract ABI defines `Blacklisted(address token)` with the address non-indexed; the same signature hashes identically to Circle's `Blacklisted(address _account)`. Config keying ensures each contract only runs its own event family, and the parser correctly reads from the data field for A7A5 (since `topics.length === 1`) and from `topics[1]` for USDC (since `topics.length === 2`).
10. **Suppression is hard-filtered in `GET /api/blacklist` SQL.** `worker/src/api/blacklist.ts:84` prepends `conditions.push("suppression_reason IS NULL")`, and `fetchPaginatedEvents` uses the same `conditions` for both the `SELECT` and the `COUNT(*)` — suppressed rows never leak into paginated output or into the total count.
11. **`/api/blacklist-summary` aggregators run on the filtered (unsuppressed) events list.** `allEvents.filter((e) => e.suppressionReason == null)` is passed to `buildBlacklistActiveRecords`, `computeBlacklistSummaryStats`, and `buildBlacklistChartData`; stats and chart are therefore unsuppressed-accurate. (See L2 for the efficiency concern.)
12. **`blacklist_current_balances` ledger does NOT receive suppressed rows.** `post-fetch.ts:118` filters `ledgerRows = newRows.filter((row) => row.suppression_reason == null)` before calling `syncCurrentBalanceCacheForRows`, so EURC mirror-zero rows are never persisted to the freeze ledger.
13. **USDC Ethereum sync-state advances as expected;** 13 methodology versions are represented in `blacklist_events`, indicating the ingestion path has been running correctly for most of the tracker's lifetime.
14. **Doc-count claim "53 contract configurations on 9 chains" matches the code.** Counted via structural parse of `CONTRACT_CONFIG_SPECS`: 53 entries spanning the 9 chains ETHEREUM, ARBITRUM, BASE, OPTIMISM, POLYGON, AVALANCHE, BSC, TRON, GNOSIS.
15. **`BLACKLIST_STABLECOINS` enum length (23) matches the docs "Cron-backed sync coverage" list (23) and the "Live API/UI filter enum" list (23).**
16. **Tron address format in `current-balance-cache` is consistent.** Stored addresses are 0x-prefix 40-char hex (as returned by TronGrid `_user`/`_blackListedUser`); `blacklist_current_balances.id` is keyed by `${stablecoin}:${chainId}:${address.toLowerCase()}`; `fetchTronTokenCurrentBalance` round-trips through `tronHexAddressToBase58` before hitting `/v1/accounts/{T...}`, and the stored trc20 entry key matches `config.contractAddress` (mixed-case base58) as verified against live TronGrid responses.
17. **EVM safety margins in code match docs for Ethereum/Arbitrum/Base/Optimism/Polygon/Avalanche/BSC** — 75/3600/450/450/450/450/300 blocks respectively. Only Gnosis is missing (M5).
18. **`batchExecute` uses `D1_BATCH_SIZE` chunking** so `insertBlacklistRows` cannot exceed D1 limits even for very large enrichment payloads.
19. **`decodeUint256AtSlot` correctly isolates a 32-byte slot** — tested implicitly by OmnibusSeize test case (`BUIDL_CONFIG` with `amountDataIndex: 1` returns `25` for `25_000_000n`).
20. **`decodeAddress` strips the leading 24 hex chars (12 zero bytes) before lowercasing** — no case-sensitivity issues.
21. **`INSERT OR IGNORE` deduplication via row ID `{chainId}-{txHash}-{logIndex}` works** — `filterNewBlacklistRows` prunes duplicates before enrichment, and the DB enforces primary-key uniqueness. USDtb batch events suffix with `-{arrayIndex}` to avoid collision within a single log.
22. **Current EURC Ethereum rows (451) are all `suppression_reason = circle_mirror_zero_balance`**, confirming the suppression pipeline is working for the ingestion path.
23. **No USDX, AID, BRZ, FDUSD (all chains), U (any chain), EURI, USDQ, TGBP, or BUIDL events exist on-chain today**, so the 0-row state in production is correct for those symbols — it is not a coverage gap.

---

## Summary

| Severity | Count |
| --- | --- |
| Critical | 1 |
| High | 5 |
| Medium | 7 |
| Low | 5 |

**Top-priority remediations (data-accuracy impact, in order):**

1. Fix H1 (methodology version tiebreak) — trivial change, immediate effect on every row ingested from now on.
2. Diagnose and fix H3 (`exception:Error` on USDG/RLUSD/USDO/EURC/EURI/USDC). These blocking exceptions are preventing actual Freeze/Pause/Ban events from ever being ingested. Start by enriching `recordApiErrorConfig` to capture `err.message` / `err.stack` so the root cause can be identified, then fix.
3. Patch C1 (BUIDL Seize amount decoding) before the first real BUIDL seizure lands. Add unit test coverage for Seize alongside OmnibusSeize.
4. Fix H2 (Arbitrum FDUSD/AUSD/BUIDL start blocks) — correct the values and hard-reset the affected `blacklist_sync_state` rows.
5. Harden EURC suppression end-to-end (M1 + M2) so late-resolving 0-balance rows do not leak into public aggregates.
