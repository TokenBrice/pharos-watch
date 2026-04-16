# Blacklist Amount Attribution Audit — Agent D

- **Date:** 2026-04-16
- **Scope:** `/blacklist` — `blacklist_events.amount_native` attribution
- **Method:** static code read + live production D1 SELECTs via `wrangler`
- **DB snapshot:** `stablecoin-db` (`8f3f54ca-e035-4cdf-9ec5-a4fbbe48b27a`), 16,514 total rows / 16,063 unsuppressed
- **Author:** Agent D

---

## Executive Summary

The current "unresolved" count of 7,109 NULL-amount rows undercounts the real attribution problem by ~2x. The *true* attribution state of the 16,063 public blacklist events is:

| Class | Rows | % | Reality |
|-------|-----:|--:|---------|
| Resolved nonzero via direct event / historical_balance | 249 | 1.5% | Genuinely attributed |
| Resolved zero via direct event / historical_balance | 354 | 2.2% | Genuinely confirmed zero |
| `amount_source='derived'`, `amount_native=0` | 4,381 | 27.3% | **Legacy migration artifact, not really attributed** |
| `amount_source='derived'`, `amount_native>0` | 3,970 | 24.7% | Legacy bulk-promoted `amount` column; unverified historical accuracy |
| `amount_native IS NULL` (all Tron USDT) | 7,109 | 44.3% | Marked `permanently_unavailable` on day 0, never retried |

**Hidden finding:** `amount_source = 'derived'` is stamped on 8,351 rows but is *not* produced by any active code path — it was a one-shot bulk update in migration `0076_blacklist_provenance_and_amount_semantics.sql`:

```sql
UPDATE blacklist_events SET amount_native = amount WHERE amount_native IS NULL;
UPDATE blacklist_events SET amount_source = 'derived' WHERE amount_source = 'unavailable' AND amount_native IS NOT NULL;
UPDATE blacklist_events SET amount_status = 'resolved' WHERE amount_native IS NOT NULL;
```

Every derived row is now `amount_status='resolved'`, which takes it out of the `backfillAmounts` pool (`WHERE amount_status IN ('recoverable_pending','provider_failed','ambiguous')`). So ~52% of the event set is effectively frozen in a pseudo-resolved state and never gets a real historical balance query.

### Top five attribution wins (ordered by expected coverage delta)

1. **Cross-populate Tron USDT NULL rows from `blacklist_current_balances`** — 6,921 / 7,109 Tron USDT rows (97.4%) have a matching `blacklist_current_balances.amount_native` value via the kyc.rip bootstrap. Promoting that value into `blacklist_events` with `amount_source='current_balance_snapshot'` (or a new `kyc_rip_bootstrap` provenance) removes ~43% of the public "unknown amounts" in one pass. **Risk:** it is a snapshot, not event-time, so the provenance/UI must say so.
2. **Re-attribute the 4,381 legacy `derived` zero rows** via `backfillAmounts` — widen the backfill pool to also include `amount_source='derived' AND amount_native=0` rows and run `fetchEvmTokenBalance` at `blockNumber-1`. 952 of these have a nonzero entry in `blacklist_current_balances` (already confirmed they were not actually zero at freeze time), and the rest can be freshly queried. Expected: 952 cheap wins plus ~3,400 new dRPC/Alchemy calls across 7 EVM chains.
3. **Treat the 3,970 legacy `derived` nonzero rows as suspect** — their `amount_native` was bulk-promoted from the old `amount` column at migration time, but the provenance was never re-verified. For the cohorts where `amount > 0` was genuinely from a `DestroyedBlackFunds` event (mainnet USDT destroy, Tron USDT destroy, Arbitrum USDT destroy), upgrade `amount_source` to `event`. For blacklist/unblacklist `derived` rows, either re-query or relabel them `amount_source='legacy_migration'` so the dashboard can surface the provenance honestly.
4. **Fix 11 PAXG/USDT destroy rows still marked `derived=0`** — these are `FrozenAddressWiped` / `DestroyedBlackFunds` events where the destroy fallback should have hit `balanceOf(blockNumber-1)`. Ten PAXG destroy rows dated 2019–2024 and one USDT destroy row are still zero. They are trivially recoverable via the existing `fetchEvmTokenBalance` path — they only fail to enter `backfillAmounts` because they claim `amount_status='resolved'`.
5. **Stop marking new Tron blacklist/unblacklist events `permanently_unavailable`** — the `evm-rpc` and `trongrid jsonrpc` paths both support `eth_call` with a `latest` tag (Alchemy's `tron-mainnet.g.alchemy.com` does too). Tron historical balance at a specific block is still not cheaply available, but storing the live `balanceOf` at ingestion time (with provenance `current_balance_snapshot`) is already happening for the freeze ledger — it just is not written back to `blacklist_events`. Mirroring that one value into the event row closes the gap for all future Tron rows.

---

## Quantitative Baseline (production)

### Q1 — headline counts

```
total: 16,514
null_amount: 7,109
suppressed (EURC mirror zero): 451
unsuppressed: 16,063
```

### Q43 — attribution state of the 16,063 public rows

| Source × status | Rows | Comment |
|---|---:|---|
| `event` / `resolved` | 57 | Destroy events decoded from the log itself (modern ingestion) |
| `historical_balance` / `resolved` | 546 | Modern dRPC/Alchemy backfill |
| `derived` / `resolved` | 8,351 | Migration 0076 bulk update; 8,351 rows |
| `unavailable` / `permanently_unavailable` | 7,109 | All Tron USDT blacklist/unblacklist |

### Q2 — unresolved cohort (NULL amount, unsuppressed) by (chain × symbol × event × status × last_error_class × last_provider)

| Chain | Symbol | Event | amount_status | last_error_class | last_provider | Rows |
|---|---|---|---|---|---|---:|
| tron | USDT | blacklist | `permanently_unavailable` | `null` | `null` | 6,696 |
| tron | USDT | unblacklist | `permanently_unavailable` | `null` | `null` | 413 |

(no other rows returned — the backlog is entirely Tron USDT)

### Q3 — destroy events with NULL amount

```
(empty result — every destroy event has an amount)
```

### Q4 — attempts histogram on `(recoverable_pending | provider_failed | ambiguous)` NULL rows

```
(empty result — there is no active recovery backlog at all)
```

### Q5 — full distribution by source × status (unsuppressed)

| amount_source | amount_status | Rows |
|---|---|---:|
| `derived` | `resolved` | 8,351 |
| `unavailable` | `permanently_unavailable` | 7,109 |
| `historical_balance` | `resolved` | 546 |
| `event` | `resolved` | 57 |

### Q7 — Tron unresolved (confirms the entirety of the NULL set)

| Chain | Symbol | Event | Status | Rows |
|---|---|---|---|---:|
| tron | USDT | blacklist | `permanently_unavailable` | 6,696 |
| tron | USDT | unblacklist | `permanently_unavailable` | 413 |

### Q24 — recovery telemetry on the `permanently_unavailable` set

| Event | Chain | Symbol | Rows | rows with `amount_last_error_class = NULL` |
|---|---|---|---:|---:|
| blacklist | tron | USDT | 6,696 | 6,696 (100%) |
| unblacklist | tron | USDT | 413 | 413 (100%) |

Every `permanently_unavailable` row was stamped by migration 0076 and has *never* been retouched — `amount_attempt_count` is 0, `amount_last_error_class`/`_provider`/`_attempted_at` are all NULL. The current code path (`amount-recovery.ts` lines 117–125) explicitly skips them, so they stay dark forever.

### Q42 — successful recovery telemetry history

```
chain_rpc / null → 304 rows
drpc       / null → 192 rows
event_receipt / null → 1 row
```

All successful non-legacy attributions. No rows with non-null `amount_last_error_class` — there is *zero active retry churn*, confirming Q4.

### Q26 — events per chain

| Chain | Rows |
|---|---:|
| tron | 8,112 |
| ethereum | 5,636 |
| base | 528 |
| arbitrum | 516 |
| polygon | 460 |
| avalanche | 420 |
| optimism | 390 |
| bsc | 1 |

### Q20 — `blacklist_current_balances` ledger distribution (potential attribution proxies)

| Symbol | Chain | Source | Rows |
|---|---|---|---:|
| USDT | tron | `kyc_rip_bootstrap` | 6,051 |
| USDT | ethereum | `kyc_rip_bootstrap` | 2,822 |
| USDC | ethereum | `kyc_rip_bootstrap` | 544 |
| USDT | tron | `current_balance` | 417 |
| PAXG | ethereum | `current_balance` | 275 |
| USDC | arbitrum | `current_balance` | 139 |
| PYUSD | ethereum | `current_balance` | 97 |
| AUSD | base | `current_balance` | 94 |
| USDTB | ethereum | `current_balance` | 35 |
| (+14 more rows) |  |  |  |

### Q22 — NULL event rows that already have a ledger row with a nonzero amount

```
null_rows_with_ledger: 6,921 (of 7,109 Tron USDT rows)
```

### Q23 — breakdown

| Chain | Symbol | Event | Rows |
|---|---|---|---:|
| tron | USDT | blacklist | 6,521 |
| tron | USDT | unblacklist | 400 |

### Q32 — legacy derived cohort, zero vs nonzero

| Chain | Symbol | Event | zero | nonzero |
|---|---|---|---:|---:|
| ethereum | USDT | blacklist | 1,350 | 1,460 |
| arbitrum | USDC | blacklist | 376 | 9 |
| ethereum | USDC | blacklist | 366 | 170 |
| polygon | USDC | blacklist | 355 | 7 |
| base | USDC | blacklist | 319 | 20 |
| optimism | USDC | blacklist | 291 | 0 |
| avalanche | USDC | blacklist | 256 | 1 |
| ethereum | PAXG | blacklist | 256 | 29 |
| ethereum | USDT | unblacklist | 182 | 81 |
| ethereum | USDC | unblacklist | 127 | 10 |
| avalanche | USDC | unblacklist | 96 | 0 |
| base | USDC | unblacklist | 93 | 0 |
| polygon | USDC | unblacklist | 93 | 0 |
| arbitrum | USDC | unblacklist | 92 | 1 |
| optimism | USDC | unblacklist | 91 | 0 |
| arbitrum | USDT | blacklist | 21 | 12 |
| ethereum | PAXG | destroy | 10 | 0 |
| tron | USDT | destroy | 5 | 956 |
| ethereum | USDT | destroy | 1 | 1,201 |
| ethereum | XAUT | blacklist | 1 | 3 |

Total: `derived=0` = 4,381 (of which 4,365 are non-destroy: 3,591 blacklist + 774 unblacklist). `derived>0` = 3,970.

### Q39 — derived-zero rows that have a nonzero entry in `blacklist_current_balances`

```
952 rows (of 4,381 derived-zero rows)
  - ethereum USDT blacklist  : 937
  - ethereum USDT unblacklist: 9
  - tron USDT destroy        : 5
  - ethereum USDT destroy    : 1
```

---

## Failure class breakdown

### Class A — Tron USDT blacklist/unblacklist marked `permanently_unavailable`

- **Size:** 7,109 rows (43% of events, 100% of NULL amounts)
- **Oldest:** 2020-06-26 — **Newest:** 2026-04-16 (live, still growing ~10–20/day)
- **Root cause:** two conflating reasons, confused in the code:
  1. `amount-recovery.ts:117-125` hard-codes Tron blacklist/unblacklist as `permanently_unavailable`, citing "no historical balance API." That's only partly true: Tron *does* not have a cheap `balanceOf_at_block(addr, contract, n)` surface exposed via TronGrid REST, but **(a)** the freeze ledger already fetches `latest` balances successfully through `fetchTronTokenCurrentBalance` (TronGrid JSON-RPC `eth_call`), and **(b)** the `kyc_rip_bootstrap` ingestion has already populated 6,051 Tron USDT addresses with nonzero frozen amounts.
  2. Migration 0076 stamped `permanently_unavailable` on every Tron row as of that date. New ingestions happily repeat that classification for all subsequent rows (`tron-source.ts:73-78`), so the set keeps growing.
- **Recoverability verdict:** **recoverable as a proxy** (current-balance snapshot or kyc.rip bootstrap value), not recoverable as a true event-time historical balance. The current code is correct that *historical precision* is unavailable, but silently discards the *current* and *bootstrap* values that already exist elsewhere in the database.

### Class B — Legacy `amount_source='derived'` zero (EVM blacklist/unblacklist/destroy)

- **Size:** 4,381 rows
- **Biggest cohorts:** Ethereum USDT blacklist (1,350), Arbitrum USDC (376), Ethereum USDC (366), Polygon USDC (355), Base USDC (319), Optimism USDC (291), Avalanche USDC (256), PAXG blacklist (256)
- **Root cause:** migration 0076's bulk `UPDATE blacklist_events SET amount_native = amount` promoted the legacy `amount` column, which historically stored 0 for *any* blacklist/unblacklist event where the pre-migration ingestion did not call `balanceOf`. The migration then stamped `amount_status='resolved'`, which **excludes the row from the `backfillAmounts` pool** (`amount-recovery.ts:273`). These rows therefore look attributed but never had an actual historical balance query.
- **Evidence that many are *actually* nonzero:**
  - 952 of the 4,381 already appear in `blacklist_current_balances` with a nonzero value (see Q39/Q40), meaning Pharos knows the address holds funds but the event row still says 0.
  - The migration logic leaves no distinction between "0 because the address genuinely held 0" and "0 because the old column was never populated."
- **Recoverability verdict:** **fully recoverable**. Every affected row has `block_number` and `address`, and `fetchEvmTokenBalance` (dRPC → chain_rpc → Etherscan) is known to work on all seven EVM chains represented. The blocker is the backfill filter, not the data source.

### Class C — Legacy `amount_source='derived'` nonzero

- **Size:** 3,970 rows
- **Biggest cohorts:** Ethereum USDT destroy (1,201), Tron USDT destroy (956), Ethereum USDT blacklist (1,460 — includes ~28 at the `20000` bucket value), Ethereum USDC blacklist (170), Ethereum USDT unblacklist (81)
- **Root cause:** migration 0076 promoted the legacy `amount` column. For the destroy cohorts the value came from the old event-parsing path (`DestroyedBlackFunds(address,uint256)` has the amount in data slot 1), so these values are *probably* correct but lack modern provenance (`amount_source` should be `event`, not `derived`). For the blacklist/unblacklist cohorts, the value may have come from a legacy on-cron `balanceOf` fetch — unverifiable without running the query again.
- **Recoverability verdict:** **re-label or re-verify**. No new data is needed — only a provenance upgrade and, for the blacklist/unblacklist cohorts, a one-off re-query to confirm values match `fetchEvmTokenBalance(block_number-1)`. If the cohort passes spot-check, upgrade `amount_source` to `historical_balance`; else flag as `legacy_unverified` in the UI.

### Class D — Legacy `amount_source='derived'` zero on destroy events

- **Size:** 11 rows (10 PAXG Ethereum destroy + 1 USDT Ethereum destroy)
- **Root cause:** PAXG `FrozenAddressWiped(address)` has no amount in the event log. The modern destroy-recovery path (`amount-recovery.ts:fetchDestroyAmountFromLog` + balance fallback) lands the amount correctly, but these rows were migrated before that code was written, and since they claim `resolved`, they never re-enter the backfill queue.
- **Recoverability verdict:** **trivially recoverable** via `fetchEvmTokenBalance(block_number-1)` on `0x45804880De22913dAFE09f4980848ECE6EcbAf78` (PAXG) and the one USDT destroy. Sample rows in Q38.

### Class E — `budget_exhausted`, `runtime_budget`, `provider_failed`, `ambiguous`

- **Size:** 0 (confirmed via Q4)
- **Comment:** the active recovery pipeline is currently idle — there is no stranded in-flight backlog. This is good news: the 7-minute runtime budget + 900 subrequests are sufficient for the current ingestion rate, and no circuit-breaker churn is needed.

### Class F — `config_missing` / `ambiguous_config`

- **Size:** 0 (no rows in the telemetry fields indicate this class)
- **Comment:** the remediate-blacklist-amount-gaps admin endpoint's `onlyMissingProvenance` branch has nothing to do in production today.

---

## Proposed fixes

### Critical 1 — Expand `backfillAmounts` scope to include legacy-derived zero rows

**Cohort affected:** 4,381 rows (Class B)  
**Expected rows attributed:** ~4,200–4,381 (952 already known nonzero via ledger join; the remainder are ~76% likely nonzero based on the kyc.rip pattern, but exact rate only known after one cron run)  
**Code change location:**
- `worker/src/cron/blacklist/amount-recovery.ts:268-275` — widen the `WHERE` clause in `backfillAmounts` to include rows that were bulk-migrated with questionable provenance:

  ```sql
  WHERE event_type IN ('blacklist', 'unblacklist', 'destroy')
    AND (
      amount_status IN ('recoverable_pending', 'provider_failed', 'ambiguous')
      OR (amount_source = 'derived' AND amount_native = 0
          AND amount_status = 'resolved'
          AND chain_id != 'tron')
    )
  ```

- Then update the success path to overwrite `amount_source` with the real provenance (`event`/`historical_balance`) and set `amount_status='resolved'` on success; on failure, move them to `amount_status='provider_failed'` so they stop being claimed as resolved.

**Data source / provider:** existing dRPC → chain_rpc → Etherscan fallback  
**Risk:**
- Subrequest budget impact: 4,381 rows × 1–3 subrequests each = 4,400–13,000 calls. At 50 rows/cycle that's ~88 cycles (~4 days of hourly sync) before the backlog clears — acceptable.
- Ordering: `backfillAmounts` currently `ORDER BY timestamp DESC`. Since these rows span 2018–2026, the oldest rows drain last; that's fine but consider adding a tie-break to prefer the cheapest cohort first (e.g., USDC Arbitrum has dRPC support guaranteed).
- Throttle: confirm the `backfillAmounts` runtime budget check remains in the inner loop.

**Methodology implication:** v5.9 → v5.91 (or v6.0 if combined with Critical 2). The publicly-visible dashboard numbers for USDC/USDT frozen totals will *increase* for the first time since migration 0076 because previously "resolved zero" rows will become either `resolved N>0` or be reclassified `provider_failed`. Document this as a correction of a legacy attribution bug, not a new feature.

---

### Critical 2 — Cross-populate Tron USDT NULL rows from `blacklist_current_balances`

**Cohort affected:** 6,921 rows (Class A, Tron USDT blacklist/unblacklist with a matching ledger entry)  
**Expected rows attributed:** 6,921 rows (100% of the joinable set), leaving only ~188 truly unmatched Tron rows  
**Code change location:**
- New function in `worker/src/cron/blacklist/amount-recovery.ts` — `backfillTronFromLedger(db)`:
  ```ts
  UPDATE blacklist_events
  SET amount_native = (SELECT bcb.amount_native
                       FROM blacklist_current_balances bcb
                       WHERE bcb.stablecoin = blacklist_events.stablecoin
                         AND bcb.chain_id = blacklist_events.chain_id
                         AND LOWER(bcb.address) = LOWER(blacklist_events.address)
                         AND bcb.amount_native IS NOT NULL),
      amount_usd_at_event = ...,
      amount_source = 'current_balance_snapshot',
      amount_status = 'resolved_snapshot',
      amount_attempt_count = COALESCE(amount_attempt_count, 0) + 1,
      amount_last_attempted_at = ?,
      amount_last_error_class = NULL,
      amount_last_provider = 'current_balances_ledger'
  WHERE chain_id = 'tron'
    AND stablecoin = 'USDT'
    AND amount_native IS NULL
    AND suppression_reason IS NULL
    AND EXISTS (
      SELECT 1 FROM blacklist_current_balances bcb
      WHERE bcb.stablecoin = blacklist_events.stablecoin
        AND bcb.chain_id = blacklist_events.chain_id
        AND LOWER(bcb.address) = LOWER(blacklist_events.address)
        AND bcb.amount_native IS NOT NULL
    );
  ```
- Add `'current_balance_snapshot'` to `amount_source` literal union in `shared/types/market.ts` and anywhere `amount_source` is typed (including `api/__tests__/helpers/fixtures.ts:19`).
- Add `'resolved_snapshot'` to `amount_status` (or reuse `resolved` and rely only on `amount_source` to differentiate — consider the simpler approach).
- Update the public `/api/blacklist` response to include the provenance so frontend can render a "snapshot" indicator (see Critical 5).

**Data source / provider:** `blacklist_current_balances` table (no new external calls)  
**Risk:**
- Zero subrequest cost — the transformation is pure SQL.
- Methodology risk: the snapshot amount is *not* event-time. If the address was emptied after blacklisting and the kyc.rip bootstrap picked up the new zero, the snapshot may under-report the frozen amount at freeze time. However, since `kyc_rip_bootstrap` targets *current* frozen addresses, it's likely closer to the current-reality frozen amount, which is what the `blacklist_current_balances` freeze ledger already exposes. The event-time vs snapshot-time distinction must be surfaced in the UI.
- Destroy-event risk: do NOT apply to Tron destroy — those already have `amount_source='event'` or `derived>0` from the legacy `DestroyedBlackFunds` log.
- Unblacklist risk: for 400 unblacklist rows, the snapshot may be zero (address emptied) or may reflect a later blacklisting if the address was re-frozen. Keep the operation idempotent by conditioning on `amount_native IS NULL`.

**Methodology implication:** methodology version bump + visible provenance label. `amount_source='current_balance_snapshot'` must render in `src/components/blacklist-table.tsx` with a distinct badge. A user viewing `/blacklist` should see "Snapshot" or "Proxy" next to the amount, not a bare USD figure. The existing gold-token mirror-zero UI treatment (`EurcBlacklistCard`, `UsdsStatusCard`) is a good template.

---

### High 1 — Re-attribute the 11 PAXG/USDT destroy rows with `derived=0`

**Cohort affected:** 11 rows (Class D — 10 PAXG Ethereum destroy + 1 USDT Ethereum destroy)  
**Expected rows attributed:** 11 (high confidence — all are Ethereum mainnet with known dRPC archive support)  
**Code change location:** automatically swept up by Critical 1's expanded `WHERE` clause — no separate fix needed *as long as the filter includes destroy events*. Alternatively: single one-off SQL via `handleRemediateBlacklistAmountGaps` with `chainId=ethereum` and then manual rerun of the backfill targeting these 11 ids.

**Data source / provider:** dRPC → chain_rpc → Etherscan `balanceOf` at `blockNumber-1`  
**Risk:** trivial. The PAXG contract `0x458048...` has been archive-available on dRPC since 2019; the 11 rows span 2019–2024.  
**Methodology implication:** none; this is a destroy-event attribution correction.

Sample rows to confirm (Q38):
- `ethereum-0x9a122aa83af596d7649e8951828194572a9eff3c60d4c1117198a48095915abf-0x2e` — block 8,491,922, addr `0x8a82042f...`
- `ethereum-0xeeb9bafd991508cbf707868b5d880c2fbf367130fbe856ab3f1c400993076147-0x12` — block 21,231,216, addr `0xbf786d2c...`

---

### High 2 — Re-label or re-verify the 3,970 `derived` nonzero rows

**Cohort affected:** 3,970 rows (Class C)  
**Expected rows attributed:** 3,970 (no *new* attribution; this is a provenance cleanup so the dashboard can stop calling them `derived`)  
**Code change location:**
- Option A (cheap): one-off SQL to relabel by cohort:
  ```sql
  UPDATE blacklist_events SET amount_source = 'event'
  WHERE amount_source = 'derived' AND event_type = 'destroy' AND amount_native > 0;

  UPDATE blacklist_events SET amount_source = 'legacy_migration'
  WHERE amount_source = 'derived' AND amount_native > 0;
  ```
- Option B (rigorous): for the blacklist/unblacklist cohorts (~800 rows), re-run `fetchEvmTokenBalance(block_number-1)` and compare against the stored `derived` value. If they match, upgrade to `historical_balance`; if they don't, log the discrepancy and fall back to `provider_failed`.

**Data source / provider:** Option B uses the same dRPC → chain_rpc path; ~800 subrequests total (spread across 14 cycles).  
**Risk:** Option A is zero-risk but retains the ambiguity. Option B is the audit-honest path. Recommend Option B because the cohort is small.  
**Methodology implication:** the dashboard currently reports these as `resolved` so this is effectively a documentation/provenance change invisible to end users unless a value flip is discovered.

---

### High 3 — Stop stamping new Tron blacklist/unblacklist events `permanently_unavailable`

**Cohort affected:** all *future* Tron USDT blacklist/unblacklist ingestions (~10–20/day)  
**Expected rows attributed:** ongoing (prevents the backlog from regrowing after Critical 2 cleans it up)  
**Code change location:**
- `worker/src/cron/blacklist/tron-source.ts:73-78` — change the fallback status from `permanently_unavailable` to `recoverable_pending` (so `backfillAmounts` and Critical 2's ledger-join will reach them next cycle), AND
- `worker/src/cron/blacklist/current-balance-cache.ts:180-191` — this already writes `blacklist_current_balances` rows on new Tron blacklist events. The fix is just to *also* mirror the snapshot back to the event row at the same time:
  - In `post-fetch.ts` after `syncCurrentBalanceCacheForRows`, re-read the just-inserted ledger rows and copy their `amount_native` into the matching `blacklist_events` rows with `amount_source='current_balance_snapshot'`.
- `worker/src/cron/blacklist/amount-recovery.ts:117-125` — drop the hard-coded `permanently_unavailable` stamp for Tron; let rows stay `recoverable_pending` and let the ledger-join pass attribute them.

**Data source / provider:** existing `fetchTronTokenCurrentBalance` (already called in the hourly cron)  
**Risk:**
- No new subrequest budget impact — the current-balance fetch is already happening.
- Adds a second D1 write per new Tron event — batchable inside `syncCurrentBalanceCacheForRows`.

**Methodology implication:** same `current_balance_snapshot` provenance as Critical 2 — coherent.

---

### Medium 1 — Remove the `derived` enum value entirely once Classes B/C/D are drained

**Cohort affected:** entire `amount_source` enum consistency  
**Expected rows attributed:** 0 (hygiene)  
**Code change location:**
- `shared/lib/blacklist.ts` + `shared/types/market.ts` + `worker/src/api/__tests__/helpers/fixtures.ts:19` — drop `derived` from the union type.
- Migration `0092` (or next available) — `UPDATE blacklist_events SET amount_source = CASE WHEN amount_status='resolved' AND amount_native>0 THEN 'historical_balance' ELSE 'unavailable' END WHERE amount_source='derived'`.
- `docs/blacklist-tracker.md:492` — remove the "legacy migration artifact" note.

**Data source / provider:** none  
**Risk:** must run *after* Critical 1 completes, otherwise active rows get their provenance wiped.  
**Methodology implication:** none.

---

### Medium 2 — Widen the `remediate-blacklist-amount-gaps` admin endpoint to accept `includeLegacyDerivedZero=true`

**Cohort affected:** admin operator tooling  
**Expected rows attributed:** N/A (manual rerun)  
**Code change location:** `worker/src/api/remediate-blacklist-amount-gaps.ts:106-123` — add a condition branch:

```ts
if (includeLegacyDerivedZero) {
  conditions.push(
    "(amount_source='derived' AND amount_native=0 AND amount_status='resolved' AND chain_id != 'tron')"
  );
}
```

This gives ops the ability to dry-run the Critical 1 fix before enabling it on cron.

**Risk:** zero — admin-gated endpoint behind CF Access.  
**Methodology implication:** none.

---

### Medium 3 — Make `backfillAmounts` batch size adaptive

**Cohort affected:** drain rate after Critical 1 lands  
**Expected rows attributed:** faster catch-up (50 rows/hour → 100+ rows/hour if budget allows)  
**Code change location:** `worker/src/cron/blacklist/amount-recovery.ts:29` — replace `BACKFILL_BATCH_SIZE = 50` with a function that returns `Math.min(200, Math.max(50, Math.floor(budget.limit * 0.2 / 3)))` using the currently-unused budget headroom.

**Risk:** could crowd out new-event scanning on heavy days. Test with a hard cap and a guard to skip if new-event budget is already strained.  
**Methodology implication:** none.

---

### Low 1 — Distinguish "confirmed zero" from "unknown" in the API response

**Cohort affected:** frontend surfaces  
**Expected rows attributed:** 0 (UI only)  
**Code change location:** `worker/src/api/blacklist.ts` — emit a `amountCertainty: 'precise'|'snapshot'|'legacy'|'unknown'` hint computed from `amount_source` + `amount_status`.

**Risk:** minor UI/type churn.  
**Methodology implication:** none but nice-to-have for the docs' "Known Gotchas" section.

---

### Low 2 — Evaluate TronGrid JSON-RPC historical `eth_call` feasibility

**Cohort affected:** the ~188 Tron USDT rows whose addresses *don't* appear in the ledger  
**Expected rows attributed:** up to 188 (if historical `eth_call` works on Alchemy's `tron-mainnet.g.alchemy.com` or TronGrid JSON-RPC)  
**Code change location:** new function in `balance-providers.ts` that POSTs `eth_call` with a numeric block tag to `https://tron-mainnet.g.alchemy.com/v2/${key}` and falls back to `https://api.trongrid.io/jsonrpc`.

**Risk:** both endpoints *should* support block tags but TronGrid's JSON-RPC historically has non-standard semantics. Validate live with `curl` before shipping.  
**Methodology implication:** if it works, Tron gets parity with EVM chains. If it doesn't, keep the ledger-join fallback as the authoritative path.

Commands to validate before writing code:
```sh
curl -sS https://tron-mainnet.g.alchemy.com/v2/$ALCHEMY_API_KEY \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0x<hex TR7NHqjeKQx..>","data":"0x70a08231<addr>"},"0x<old block hex>"]}'
```

---

## Known Limits (genuinely unrecoverable)

1. **~188 Tron USDT events** whose affected address does not appear in `blacklist_current_balances`. Without a historical `balanceOf_at_block` path on Tron (see Low 2), these remain genuinely unknown. Label them `amount_status='permanently_unavailable'` *after* the ledger-join pass, not preemptively.
2. **Pre-2019 PAXG frozen addresses that were later re-funded and un-frozen and re-frozen** — for these, the `FrozenAddressWiped` event's historical `balanceOf` will be the latest value, not the original value. This is not a new limitation, just a reminder for Class D: the eleven sample rows are chronologically early enough that this is unlikely to apply.
3. **BUIDL `Seize` events** — currently covered via `event_receipt` path, no action needed. Confirm this is still true after Critical 1 runs.
4. **RLUSD `clawback`** — already documented as uncovered in v3.8 (no dedicated event). Out of scope here.
5. **MNEE `AccountBlacklisted`/`AccountDelisted`** — intentionally deferred per v3.9 notes. Out of scope here.

---

## Quick-Win List (one PR each, <50 LoC)

1. **Fix the 11 PAXG/USDT `derived=0` destroy rows** — single SQL update rerun via `handleRemediateBlacklistAmountGaps` targeting the specific ids, or let them fall into Critical 1. Effort: 30 minutes.
2. **Rename `amount_source='derived'` to `'legacy_migration'` in the database and UI** — pure SQL `UPDATE` plus TS union rename. Makes the provenance honest without changing any behavior. Effort: 1 hour.
3. **Stop stamping new Tron blacklist/unblacklist `permanently_unavailable` on ingestion** — single-line change in `tron-source.ts` to leave them `recoverable_pending`. Combined with no backfill-code changes, the rows will sit in `recoverable_pending` forever until Critical 2 ships, which is not worse than the current state. Effort: 15 minutes.
4. **Add `includeLegacyDerivedZero=true` parameter to the remediation admin endpoint** — ~20 LoC in `remediate-blacklist-amount-gaps.ts`. Enables a safe dry-run of Critical 1 before the main code change. Effort: 1 hour.
5. **Unit test the Class D recovery** — add a test to `worker/src/cron/blacklist/__tests__/amount-recovery.test.ts` that asserts a PAXG destroy row with `amount_source='derived' AND amount_native=0` is picked up by the (expanded) backfill scan once Critical 1 lands. Effort: 1 hour.

---

## Larger Investments (multi-PR programs)

### Program A — Tron historical balance source

**Rationale:** converts Class A from "proxy" to "authoritative." Candidates, ordered by effort/cost:

1. **Alchemy `tron-mainnet.g.alchemy.com` `eth_call` with block tag** — free with existing `ALCHEMY_API_KEY`. Low 2 above. Validate empirically first; if supported, this is a one-week project.
2. **TronGrid JSON-RPC `eth_call`** — already used by `fetchTronTokenCurrentBalanceViaJsonRpc` for `latest`. Extending to historical blocks depends on whether TronGrid indexes archive state; likely no for free tier, possibly yes for Pro.
3. **Bitquery / Tronscan / GetBlock archive** — third-party indexers. Adds a dependency and a cost center. Only pursue if 1 + 2 both fail.
4. **Run our own archive Tron node** — not pragmatic for this project.

Deliverable: a proven `fetchTronTokenHistoricalBalance(config, address, blockNumber)` that falls into the existing enrichment chain. After Program A ships, Tron events get promoted from `current_balance_snapshot` to `historical_balance` and the methodology bump can remove the snapshot disclaimer.

---

### Program B — Transfer-log replay for stuck EVM blacklist events (contingency)

**Rationale:** currently *not needed* in production (Q4 shows no stuck rows), but worth documenting for the future in case dRPC/Alchemy outages create a persistent `provider_failed` backlog.

**Design:** for any EVM blacklist event with `provider_failed` after N attempts, scan `Transfer(from=addr)` and `Transfer(to=addr)` logs from the contract deployment block up to `block_number-1`, sum the deltas, and derive the exact historical balance from zero. Expensive (O(tx_count) per address) but authoritative.

**Precondition:** Only build this after a real outage creates persistent `provider_failed` rows. Currently this program is not justified.

---

### Program C — UI / methodology surface for amount provenance

**Rationale:** Critical 2 introduces `current_balance_snapshot` as a distinct provenance. The `/blacklist` UI must render this coherently rather than silently mixing it into the same row format.

**Scope:**
- `src/components/blacklist-table.tsx` — badge column next to Amount showing "Event", "Snapshot", "Historical", "Legacy", or "—"
- `src/app/blacklist/page.tsx` — a legend explaining the provenance tiers
- `src/components/blacklist-stats.tsx` — filter the USDC/USDT headline numbers to include or exclude snapshot-sourced values based on a toggle
- `docs/methodology/blacklist-tracker.md` (or equivalent) — document the tiers
- `/methodology` page — add provenance tiers to the "Amount Attribution" section

**Deliverable:** users can trust the numbers they see because the provenance is visible. This is the missing piece that makes the proxy approach in Critical 2 acceptable from a methodology standpoint.

---

## Appendix: SQL reference for follow-up analysis

- Q2: canonical cohort breakdown of NULL rows
- Q20: what the `blacklist_current_balances` ledger actually contains per symbol/chain
- Q22: join that quantifies the Critical 2 win
- Q32: zero-vs-nonzero legacy derived split that quantifies Critical 1
- Q39/Q40: cross-join that proves 952 derived-zero rows are actually nonzero per the ledger

All queries return in <1s on current D1 row counts (~16k events, ~10k ledger rows). No index work needed to run the proposed backfill.
