# Venue-Risk Calibration Anchor — Yearn yvUSDC Risk Report (2026-06)

**Scope:** sanity-anchor for the yield v8.292 venue-risk rubric. Documentation only —
Yearn's report is **not** a runtime feed (only ~2 tracked vaults have Yearn reports, so
runtime ingestion would create a "two-author" inconsistency).

## Why an anchor

Yield v8.292 replaced the hand-set 3-bucket venue tier with a Yearn-style 5-category
weighted rubric and scored 29 new venues. Before trusting our own scores we cross-checked
them against Yearn's **own published risk report** for a vault we already track, to confirm
the rubric lands where a battle-tested external assessment lands.

## Yearn's published yvUSDC report (verbatim)

Source: `github.com/yearn/risk-score/reports/report/yearn-yvusdc.md` (May 11 2026 snapshot).

**Final score: 1.3 / 5.0 — "Minimal Risk — Approved, high confidence."**

| Yearn category | Score | Weight |
|---|---|---|
| Audits & Historical Track Record | 1.5 | 20% |
| Centralization & Control Risks | 1.5 | 30% |
| Funds Management | 1.0 | 30% |
| Liquidity Risk | 1.5 | 15% |
| Operational Risk | 1.0 | 5% |

**Funded allocation:** ~97.15% Sky / sUSDS Lender, ~2.85% Spark USDC Lender. The Morpho
leg was **revoked** between the May 5 and May 11 snapshots, leaving the vault
**~100% Sky-governance-coupled**. Yearn's report names that single-ecosystem concentration
(its Centralization "Dependencies" sub-score of 2.5) as the **dominant** risk — not the
vault architecture or collateral quality.

## How Pharos maps it

`yvusdc-yearn` sources its yield through the Yearn v3 vault, whose funded legs are
`spark-savings` (sUSDS) and `sparklend`. Under v8.292:

| Pharos venue | weighted | derived tier | venue penalty |
|---|---|---|---|
| `spark-savings` | 1.50 | `low` | 0 (no-op) |
| `sparklend` | 1.65 | `low` | 0 (no-op) |

**Agreement:** both legs derive to `low`, consistent with Yearn's "Minimal" (1.3/5). The
blue-chip no-op is preserved, so our venue tiering does not over- or under-penalize the
vault relative to Yearn's external assessment.

**The concentration gap, captured separately:** per-venue tiering scores each Sky leg
`low` independently and *structurally cannot* see that both legs sit behind one governance
ecosystem — exactly Yearn's #1 flagged risk. v8.292's reviewer-set
`dependencyConcentration` registry captures it directly:
`yvusdc-yearn → { ecosystem: "Sky", severity: "medium" }`, adding +0.10 to the source-risk
penalty that the two independently-`low` legs never produced.

## Reassessment triggers

- Yearn republishes `yearn-yvusdc.md` with a materially different score or allocation.
- The vault re-diversifies away from Sky (e.g. a new non-Sky strategy is funded) → revisit
  the `dependencyConcentration` entry.
- Our `spark-savings` / `sparklend` category scores change such that either leg leaves `low`.

## Byproduct (deferred)

`shared/data/stablecoins/coins/yvusdc-yearn.json` prose still lists "Aave, Compound, Morpho,
Sky" as routed strategies; the Morpho leg was revoked (now ~100% Sky). Deferred from this
methodology change to avoid regenerating the `coins.generated.*` artifacts in the same diff;
fix via the normal coin-data refresh path. The runtime concentration signal already reflects
the accurate ~100%-Sky reality.
