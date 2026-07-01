# Venue-Risk Calibration Anchor — Yearn yvUSDC Risk Report (2026-06)

**Scope:** sanity-anchor for the yield v8.292 venue-risk rubric. Documentation only —
Yearn's report is **not** a runtime feed (only ~2 tracked vaults have Yearn reports, so
runtime ingestion would create a "two-author" inconsistency).

## Why an anchor

Yield v8.292 replaced the hand-set 3-bucket venue tier with a Yearn-style 5-category
weighted rubric and scored 49 new venues (registry grew from 12 to 61). Before trusting our own scores we cross-checked
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
`spark-savings` (sUSDS) and `sparklend`. Under v8.298 (the 2026-07-01 Yearn-report
recalibration raised both legs' funds-management sub-score 1→2 for the shared MCD_VAT
backing risk Yearn scores at 1.8; both legs stay `low` / no-op):

| Pharos venue | weighted | derived tier | venue penalty |
|---|---|---|---|
| `spark-savings` | 1.80 | `low` | 0 (no-op) |
| `sparklend` | 1.95 | `low` | 0 (no-op) |

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

## v8.298 anchor-set extension (2026-07)

The 2026-07-01 Yearn-report cross-check added direct-match reports for more tracked venues than yvUSDC. These are recorded as calibration anchors spanning the accepted-risk range; each drove a venue-score recalibration shipped in yield v8.298.

### Venue anchors (direct product/protocol match)

| Yearn report | Yearn final | Pharos venue | Role |
|---|---|---|---|
| `fluid` | 1.4 Minimal | `fluid-lending` | blue-chip lending / bottom of scale |
| `maple-syrupusdc` | 2.33 Low | `maple` | institutional off-chain credit, low-medium band |
| `cap-stcusd` | 2.4 Low | `cap` | delta-neutral / operator-strategy venues |
| `centrifuge-jaaa` | 2.6 Medium | `centrifuge` | RWA / tokenized-CLO collateral class |
| `3jane-usd3` | 3.5 Medium | `3jane-lending` | top of accepted-risk scale (unsecured credit) |

Excluded as venue anchors (proxy mismatch — do **not** re-score the venue): `aave-sgho` (sGHO savings vault ≠ Aave lending market) and `gauntlet-gusda` (Gauntlet Aera V3 wrapper ≠ Morpho protocol).

### Maple Pool-Delegate concentration

`maple-syrupusdc`'s dependency graph shows a single off-chain Pool-Delegate EOA ("Maple Direct") originating ~97% of syrupUSDC/USDT AUM with no on-chain governance gate. Captured as `syrupusdc-maple` / `syrupusdt-maple` → `{ ecosystem: "Maple (Pool Delegate)", severity: "low" }` (informational, no added penalty — the medium `maple` venue tier already prices the credit risk). A HIGH severity was rejected as a double-count of the venue score.

### Asset-level anchors (reserve/safety cross-check, not yield-venue)

Yearn also publishes asset reports for tracked stablecoins. These are external anchors for future reserve/safety review; they are **not** consumed by yield source-risk:

`usdg-paxos`, `ustb-superstate`, `usr-resolv` (wstUSR), `ousd-origin-protocol`, `fxusd-f-x-protocol`, `meusd-mezo`, `srusde-strata`, `reusd-re-protocol`, `mglobal-midas-fasanara`, `mhyper-midas`, `usdat-saturn`, `apxusd-apyx`. (`buck` is ambiguous across `buck-bucket-protocol` / `buck-buck-assets` — confirm which the report covers before use.)

RWA-fund off-chain-counterparty couplings surfaced by the graph mining — `jaaa-janus-henderson-anemoy` / `jtrsy-anemoy` (Anemoy/Trident dual NAV+KYC role) and `usdf-falcon` (JAAA as collateral) — are **reserve/mechanism** risks, not yield-source concentration, so they are deferred to reserve/safety review rather than the yield dependency-concentration registry.
