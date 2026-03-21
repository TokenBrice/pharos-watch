# Live-Reserve-Sync Second-Pass Audit (2026-03-21)

Post-remediation audit of all 114 live-reserve-sync configs. First pass fixed 48 missing display blocks, 21 oversimplified reserves (via curated-validated migration), 1 risk mismatch, and the frxUSD hardcoded label. This second pass catches all remaining issues.

---

## Executive Summary

| Category | Count | Severity |
|----------|------:|----------|
| Missed migration to curated-validated (mixed-risk multi-component) | **1** | Critical |
| Risk rating mismatches (params.risk ≠ curated risk) | **5** | High |
| Missing coinId/depType in single-asset params | **3** | Medium |
| Multi-component coins that should migrate for coinId preservation | **2** | Medium |
| Label accuracy concerns | **2** | Low |
| Chain/contract, breaker scope, display, semantics | **0** | None |

---

## Issue 1 — CRITICAL: feusd-felix must migrate to curated-validated

**File:** `shared/data/stablecoins/usd-minor.json` (line 5640)

feUSD (Felix Protocol on Hyperliquid) has 4-component reserves with 3 distinct risk levels but uses `single-asset` adapter:

| Component | Pct | Curated Risk | Shown Risk |
|-----------|----:|-------------|------------|
| HYPE / kHYPE / wstHYPE | 60% | very-high | very-high |
| BTC (bridged UBTC) | 15% | medium | hidden |
| ETH (bridged) | 15% | medium | hidden |
| SOL (bridged) | 10% | high | hidden |

The single-asset adapter displays "WHYPE / HYPE branch collateral" at 100%/very-high. This hides 40% of the reserve composition (BTC, ETH, SOL) from users and misrepresents the risk profile.

**Fix:** Migrate to `curated-validated` adapter with `"semantics": "collateral-mix"`. Remove `params` block.

---

## Issue 2 — HIGH: 5 risk rating mismatches

Coins where `params.risk` in the single-asset config does not match the curated reserves risk.

| Coin ID | params.risk | Curated Risk | Direction | Severity |
|---------|------------|-------------|-----------|----------|
| pusd-plume | `low` | `medium` | **understated** | High |
| thbill-theo | `very-low` | `low` | **understated** | High |
| axcnh-anchorx | `low` | `very-low` | overstated | Medium |
| idrt-rupiah-token | `low` | `very-low` | overstated | Medium |
| tryb-bilira | `low` | `very-low` | overstated | Medium |

The first two are the most concerning: risk is understated, making the coin appear safer than it is.
- **pusd-plume**: USDC deployed via Nucleus BoringVault (smart contract risk → medium, not low)
- **thbill-theo**: tULTRA is a tokenized T-bill wrapper through Standard Chartered Libeara (counterparty/wrapper risk → low, not very-low)

The last three (axcnh, idrt, tryb) share a systematic pattern: non-USD fiat deposits marked "low" when they should be "very-low" per the curated reserves. Likely a copy-paste error.

---

## Issue 3 — MEDIUM: Missing coinId/depType in single-asset params

The `single-asset` adapter supports optional `coinId` and `depType` in params, which enables dependency tracking in the live reserve display. Three coins have these fields in curated reserves but not in the adapter params:

| Coin ID | Curated coinId | Curated depType | Effect |
|---------|---------------|----------------|--------|
| pht-pht | `usdt-tether` | `wrapper` | Dependency link lost in live mode |
| msusd-main-street | — | `wrapper` | depType lost in live mode |
| pusd-plume | `usdc-circle` | — | Dependency link lost in live mode |

**Fix:** Add `"coinId"` and/or `"depType"` to each coin's `params` block.

---

## Issue 4 — MEDIUM: 2 pre-existing coins should migrate for coinId preservation

Two coins added before today's expansion (commit `9208ff79`) have multi-component same-risk reserves with `coinId` links that are lost when displayed via single-asset:

### usdtb-ethena (2 components, both low risk)
- BlackRock BUIDL 90% (coinId: buidl-blackrock)
- USDC 10% (coinId: usdc-circle)
- Label: "BlackRock BUIDL-backed USD yield token" — acceptable but loses dependency info

### usdb-blast (3 components, all low risk)
- DAI/sDAI 60% (coinId: dai-makerdao)
- USDC 25% (coinId: usdc-circle)
- USDT 15% (coinId: usdt-tether)
- Label: "DAI / sDAI and bridged stablecoin reserve basket" — acceptable but loses 3 dependency links

**Fix:** Migrate both to `curated-validated` with `"semantics": "collateral-mix"`. This preserves coinId links for dependency map accuracy.

---

## Issue 5 — LOW: Label accuracy concerns

### feusd-felix
Label `"WHYPE / HYPE branch collateral"` only mentions HYPE. Should be resolved by migration to curated-validated (Issue 1).

### lusd-liquity
Label is just `"ETH"`. While technically accurate (100% ETH collateral), could be more descriptive: `"ETH (overcollateralized CDPs)"`. Minor — not misleading.

---

## Findings: No Issues

The following aspects were verified across all 114 coins and found clean:

- **Chain/contract alignment**: All on-chain inputs point to chains where the coin has a deployed contract (114/114)
- **Breaker scope uniqueness**: Shared scopes are intentional (sky-makercore shared by DAI/USDS, m0 shared by M/mUSD/USDN, mento shared by cEUR/cUSD). No accidental duplicates.
- **Display block completeness**: All coins have display blocks (only pre-existing usds-sky and dai-makerdao lack them, not in today's expansion scope)
- **Curated-validated configs**: All 21 have non-empty reserves, correct semantics, no leftover params, valid contracts
- **DOLA adapter**: Comprehensive asset classification (25+ known assets), proper risk bucketing, handles paused markets and unknown assets with warnings
- **Frax adapter**: Optional `coin` parameter working correctly, backward-compatible, both frax-frax and frxusd-frax return curated multi-slice breakdowns
- **Accountable adapter**: All 7 coins have valid configs, correct bucket strategies, appropriate riskMaps, all API endpoints accessible

---

## Remediation Priority

### P0 — Critical
1. Migrate **feusd-felix** to `curated-validated` with `"semantics": "collateral-mix"`

### P1 — High
2. Fix **pusd-plume** `params.risk` from `"low"` to `"medium"`
3. Fix **thbill-theo** `params.risk` from `"very-low"` to `"low"`
4. Fix **axcnh-anchorx** `params.risk` from `"low"` to `"very-low"`
5. Fix **idrt-rupiah-token** `params.risk` from `"low"` to `"very-low"`
6. Fix **tryb-bilira** `params.risk` from `"low"` to `"very-low"`

### P2 — Medium
7. Add `"coinId": "usdt-tether", "depType": "wrapper"` to **pht-pht** params
8. Add `"depType": "wrapper"` to **msusd-main-street** params
9. Add `"coinId": "usdc-circle"` to **pusd-plume** params (if not migrated)
10. Migrate **usdtb-ethena** to `curated-validated` with `"semantics": "collateral-mix"`
11. Migrate **usdb-blast** to `curated-validated` with `"semantics": "collateral-mix"`

### P3 — Low
12. Consider expanding **lusd-liquity** label to `"ETH (overcollateralized CDPs)"`

---

## Statistics

- **Coins audited:** 114
- **Coins with no issues:** 102 (89%)
- **Coins with issues:** 12 (11%)
- **Critical issues:** 1 (feusd-felix)
- **Issues actionable now:** 11 (all except lusd label which is cosmetic)
