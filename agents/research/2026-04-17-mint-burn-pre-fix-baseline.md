# Mint-Burn Pre-Fix Baseline Metrics

Captured 2026-04-17, prior to executing the comprehensive remediation plan
(`agents/plans/2026-04-17-mint-burn-comprehensive-remediation.md`).

D1 database: `stablecoin-db` (id `8f3f54ca-e035-4cdf-9ec5-a4fbbe48b27a`).
Source: `npx wrangler d1 execute stablecoin-db --remote --command ...`.

---

## Q1 — CCIP coin bridge MINTS misclassified as standard (last 90 days)

Currently classified as economic mints; will be re-tagged as `bridge_transfer`
once Task 1.1 ships and the operator runs the backfill replay (Task 1.7).

| stablecoin_id                 | count | volume_usd     |
|-------------------------------|-------|----------------|
| usdo-openeden                 |     6 | $20,455,571    |
| avusd-avant                   |   134 | $15,937,762    |
| usd1-world-liberty-financial  |     0 | n/a            |
| zchf-frankencoin              |     0 | n/a            |

**Total at risk:** 140 events, $36.4M of standard mint volume that is actually bridge in/out flow.
This was inflating the per-coin Net Flow 24h, the Bank Run Gauge, and DEWS inputs for
those two coins. avUSD is most affected by event count; USDO most by volume.

---

## Q2 — USDC/EURC TokenMinterV2 burns currently classified as effective_burn (90d)

Empty result — no rows match. CCTP V2 TokenMinterV2 burns either (a) haven't occurred in
this window, (b) are not landing in `mint_burn_events` with that counterparty, or (c)
already classified correctly via the existing CCTP detection (commit 831812bb).

**Implication for the plan:** the CCIP/CCTP mint-side fix (Task 1.1) is still necessary
because it covers destination MINTS regardless of whether burns are flowing. USDC/EURC
isolated bridge mints will surface after Task 1.1 ships and replay runs.

---

## Q3 — reUSD null-counterparty rate

| direction | total | null_cp | null_pct |
|-----------|-------|---------|----------|
| burn      |   392 |       0 |     0.0% |
| mint      |   698 |     698 |   100.0% |

**Confirms BUG 1.3:** every reUSD `Deposited` event has `counterparty=NULL` because
`parse.ts:71` reads `topics[2]` for mints, but the user param is unindexed (in data).
698 events affected. The burn side is fine because `InstantRedemptionRouted` has
`address indexed user` at `topics[1]`, which matches the default extraction.

After Task 1.3 ships, all NEW reUSD mint events will have correct counterparty.
Historical rows can be repaired via the operator's `/api/backfill-mint-burn` replay
over the relevant block range; counterparty field will populate from the new
`counterpartyEncoding: { source: "data", slot: 0 }` config.

---

## Q4 — Atomic-roundtrip groups with amount mismatch (last 30 days)

| Metric        | Value |
|---------------|-------|
| Total groups  | 7,151 |
| Mismatched    | 2,252 |
| Mismatch rate | 31.5% |

**Confirms BUG 1.4:** ~31% of atomic-roundtrip groups have `|sum(mint) - sum(burn)| > 0.5%`,
meaning they are NOT true round-trips. Today these rows are tagged `atomic_roundtrip` and
fully excluded from economic flow. After Task 1.4 ships and the operator runs
`/api/reclassify-atomic-roundtrips`, 2,252 groups will flip back to `flow_type='standard'`,
restoring real net economic flow that has been silently erased.

This is the largest correction in the plan by row count.

---

## Q5 — NULL price backlog by coin

| stablecoin_id    | null_rows |
|------------------|-----------|
| ustb-superstate  |       486 |
| usdnr-nerona     |        13 |
| usbd-bima        |        10 |

**Total backlog:** 509 NULL-price rows.

This is small. The cron auto-heal (48h window, 500 rows/run) will continue to chip away.
Task 4.1 promotes the metric so operators can monitor growth. No urgent action required;
ustb-superstate's backlog is the only one worth investigating (likely the price source
is not in `price_cache` or `supply_history` for that coin's earliest events).

---

## Notes for the operator

- All queries above are reproducible via `npx wrangler d1 execute stablecoin-db --remote`.
  Re-run after Phase 1 ships to capture deltas in
  `agents/research/2026-04-17-mint-burn-post-fix-results.md`.
- Q2 returned empty — leave the query in place; if USDC/EURC volume picks up post-fix,
  this row will show non-zero.
- The plan's references to a `pharos-db` database name are placeholders — the real D1
  binding is `stablecoin-db`.
- Coordination note: the Task 6.1 v6.0 methodology bump should land only AFTER the
  operator runs the Task 1.7 backfill playbook and confirms numbers reflect the new
  semantics. Otherwise the v6.0 label will publish before historical rows are healed.
