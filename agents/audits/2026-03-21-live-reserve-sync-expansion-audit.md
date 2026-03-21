# Live-Reserve-Sync Expansion Audit (2026-03-21)

Coverage expansion from 54 to 114 coins (commits `b74b4849`, `92c66ab0`, `999f75a0`, `e453159d`).
This audit reviews all 60 newly added configs for correctness, completeness, and fidelity.

---

## Executive Summary

| Category | Count | Severity |
|----------|------:|----------|
| Missing source/display attribution | **48** | Medium — no "Source" link on UI |
| Oversimplified reserve composition | **35** | High — multi-component reserves shown as single slice |
| Risk rating mismatches (curated vs live) | **8** | Critical — misleading risk signal |
| Frax adapter hardcoded label | **1** | Medium — stale if allocation changes |
| Chain/contract mismatches | **0** | None found |
| Breaker scope issues | **0** | None found |

---

## Issue 1: Missing Source/Display Attribution

**Impact:** When `display.url` is absent, the UI shows no "Source" link next to the live reserve data. Users cannot verify where the information comes from.

**Examples cited by user:** USDCV (usdcv-societe-generale-forge), EERR (eurr-stablr), VEUR (veur-vnx).

### All 48 coins missing `display` block

#### Commodity (2)
| Coin ID | Label |
|---------|-------|
| pgold-pleasing | Physical gold bars (LBMA 99.99%) |
| ggbr-goldfish-gold | Issuer-managed gold backing |

#### Non-USD (24)
| Coin ID | Label |
|---------|-------|
| a7a5-old-vector | Russian ruble bank deposits |
| brz-transfero | BRL fiat reserves |
| aeur-anchored-coins | Euro bank deposits |
| euri-banking-circle | Euro cash & EU government securities |
| eure-monerium | EUR Liquidity Fund & bank deposits |
| eurs-stasis | Euro fiat reserves |
| xsgd-straitsx | SGD deposits & MAS-eligible securities |
| gyen-gyen | JPY fiat reserves |
| audd-novatti | AUD bank deposits |
| jpyc-jpyc | JPY reserves |
| axcnh-anchorx | CNH cash reserves |
| idrt-rupiah-token | IDR bank deposits |
| tryb-bilira | TRY cash reserves |
| veur-vnx | Euro cash & equivalents |
| eurr-stablr | Fiat euro reserves |
| europ-schuman | Euro cash & equivalents |
| eurq-quantoz | Government bonds & cash |
| eurau-allunity | Euro bank deposits (CRR institutions) |
| vchf-vnx | CHF cash & equivalents |
| vgbp-vnx | GBP cash & equivalents |
| tgbp-tokenised | GBP bank deposits |
| zarp-zarp | ZAR fiat reserves |
| cadc-cad-coin | CAD bank deposits |
| pht-pht | apcxUSDT custodial wrapper |

#### USD-Minor (22)
| Coin ID | Label |
|---------|-------|
| gusd-gate | USD reserves (T-bonds & stablecoins) |
| rwausdi-multipli | Tokenized U.S. Treasuries & treasury-backed stablecoins |
| avusd-avant | USDC (delta-neutral via 0xPartners) |
| pusd-pleasing | USDT deposits & tokenized gold |
| pmusd-precious-metals | ION.au tokenized gold |
| mnee-mnee | U.S. Treasury bills & USD cash |
| tbill-openeden | U.S. Treasury bills (WAM <3 months) |
| cgusd-cygnus-finance | U.S. Treasury bills & stablecoins |
| usdx-hex-trust | U.S. Treasury bills & cash |
| xusd-straitsx | Tier 1 bank deposits & short-term securities |
| usdcv-societe-generale-forge | USD cash deposits (BNY Mellon segregated) |
| zeusd-zoth | Tokenized U.S. T-Bills & MMFs |
| usat-tether | U.S. Treasury bills & cash deposits |
| fidd-fidelity | U.S. Treasury securities & cash |
| msusd-main-street | USDC |
| pusd-plume | USDC via Nucleus BoringVault |
| wusd-worldwide | U.S. Treasury bills & cash |
| sbc-brale | Cash & U.S. Treasury securities |
| usdr-stablr | Cash & short-term government bonds |
| thbill-theo | tULTRA tokenized U.S. Treasury bills |
| aid-gaib | GPU compute-backed USD reserves |
| apxusd-apyx | Preferred equities & U.S. Treasury bills |

### Remediation

Add a `display` block with `url` (issuer transparency / attestation page) and `label` (short source name) to each coin's `liveReservesConfig`. For the `single-asset` adapter on-chain-only configs, the display URL should point to the issuer's transparency or attestation page, not the blockchain explorer.

---

## Issue 2: Oversimplified Reserve Compositions

**Impact:** The `single-asset` adapter returns a single 100% slice regardless of actual reserve complexity. Coins with multi-component curated reserves lose all allocation granularity in live mode. Users see "100% T-bills & cash" when the actual backing may be 5 distinct asset classes.

**Examples cited by user:** frxUSD (hardcoded single label), DOLA (could show per-asset detail), USDP (3 components collapsed to 1).

### Severity classification

- **Critical** (C): 3+ reserve components with mixed risk levels. Live display is actively misleading.
- **High** (H): 2+ components with different risk levels, or 3+ same-risk components with meaningful allocation diversity.
- **Low** (L): 2 same-risk components. Oversimplified but not misleading.
- **OK**: Single-asset backing correctly represented.

### All 35 coins with multi-component reserves using single-asset adapter

#### Critical (9 coins)

| Coin ID | Curated Slices | Risk Spread | Live Risk | Live Label |
|---------|:--------------:|-------------|-----------|------------|
| apxusd-apyx | 5 | 75% high + 25% low | low | Preferred equities & U.S. Treasury bills |
| rwausdi-multipli | 4 | low/medium/medium/high | low | Tokenized U.S. Treasuries & treasury-backed stablecoins |
| gusd-gate | 3 | very-low/low/high | low | USD reserves (T-bonds & stablecoins) |
| u-united-stables | 4 | low/low/medium/very-low | low | USDC, USDT, USD1 & fiat/T-bill basket |
| usdai-usd-ai | 3 | low/low/high | low | wM Treasury, PYUSD & GPU-collateralized reserves |
| zeusd-zoth | 3 | low/medium/medium | low | Tokenized U.S. T-Bills & MMFs |
| avusd-avant | 2 | medium/medium | low | USDC (delta-neutral via 0xPartners) |
| pusd-pleasing | 2 | low/medium | low | USDT deposits & tokenized gold |
| aeur-anchored-coins | 2* | low/high (bankruptcy buffer) | low | Euro bank deposits |

*aeur-anchored-coins has warnings/notices about FlowBank SA bankruptcy, making the reserve situation uniquely complex.

#### High (12 coins)

| Coin ID | Curated Slices | Risk | Live Label |
|---------|:--------------:|------|------------|
| rlusd-ripple | 3 | all very-low | U.S. Treasury bills, money market funds & cash |
| usdg-paxos | 3 | all very-low | U.S. Gov Securities, cash & equivalents |
| usdp-paxos | 3 | all very-low | U.S. Treasury bills, reverse repos & cash deposits |
| euri-banking-circle | 2 | all very-low | Euro cash & EU government securities |
| eure-monerium | 2 | all very-low | EUR Liquidity Fund & bank deposits |
| eurq-quantoz | 2 | all very-low | Government bonds & cash |
| europ-schuman | 2 | very-low + low | Euro cash & equivalents |
| cgusd-cygnus-finance | 2 | very-low + low | U.S. Treasury bills & stablecoins |
| wusd-worldwide | 2 | very-low + low | U.S. Treasury bills & cash |
| ausd-agora | 3 | all very-low | U.S. Treasury bills, reverse repos & cash |
| fidd-fidelity | 2 | all very-low | U.S. Treasury securities & cash |
| sbc-brale | 2 | all very-low | Cash & U.S. Treasury securities |

#### Low (14 coins — same-risk 2-component, acceptable simplification)

| Coin ID | Curated Slices | Risk | Live Label |
|---------|:--------------:|------|------------|
| mnee-mnee | 2 | all very-low | U.S. Treasury bills & USD cash |
| usat-tether | 2 | all very-low | U.S. Treasury bills & cash deposits |
| usdx-hex-trust | 2 | all very-low | U.S. Treasury bills & cash |
| xusd-straitsx | 2 | all very-low | Tier 1 bank deposits & short-term securities |
| usdr-stablr | 2 | all very-low | Cash & short-term government bonds |
| usdq-quantoz | 2 | all very-low | Government bonds & cash deposits |
| tbill-openeden | 1 | very-low | U.S. Treasury bills (WAM <3 months) |
| xsgd-straitsx | 1* | very-low | SGD deposits & MAS-eligible securities |
| brz-transfero | 1 | low | BRL fiat reserves |
| eurs-stasis | 1 | very-low | Euro fiat reserves |
| eurau-allunity | 1 | very-low | Euro bank deposits (CRR institutions) |
| gyen-gyen | 1 | very-low | JPY fiat reserves |
| cadc-cad-coin | 1 | very-low | CAD bank deposits |
| audd-novatti | 1 | very-low | AUD bank deposits |

*xsgd-straitsx has 2 components in curated reserves but same risk.

### frxUSD Adapter — Hardcoded Label

The `frax` adapter at `worker/src/cron/reserve-adapters/frax.ts:24` returns:
```
"Tokenized T-bills and cash equivalents (BUIDL, USTB, USCC, USDC)" @ 100% risk "low"
```

The curated reserves show 5 distinct custodial allocations:
- BlackRock BUIDL: 55%
- Superstate USTB: 20%
- Circle USDC: 10%
- Superstate USCC: 5%
- Other custodians (AUSD, JTRSY, WTGXX, USDB): 10%

The Frax API (`api.frax.finance/combineddata/`) only provides aggregate metrics (collateralRatio, totalCollateralUsd), not per-custodian breakdowns. However, Frax's transparency page at `facts.frax.finance` may expose more granular data that could be scraped or API-queried.

**Remediation options:**
1. Investigate whether `facts.frax.finance` or another Frax endpoint exposes per-custodian allocations
2. If no detailed API exists, document the limitation and keep the current aggregate approach
3. At minimum, update the label dynamically if the API ever exposes composition

### DOLA Adapter — Category Granularity

The `dola-inverse` adapter at `worker/src/cron/reserve-adapters/dola-inverse.ts` is one of the better implementations. It buckets API data into 5 categories:
- Stablecoin collateral (low)
- ETH/Liquid staking (low)
- BTC (medium)
- Governance tokens (very-high)
- Other (high)

The Inverse Finance API provides per-market data with individual collateral types. The adapter could potentially provide per-asset granularity (e.g., "wstETH: 35%, sUSDe: 15%, cbBTC: 12%") instead of broad categories. This is a minor improvement opportunity, not a bug.

### Remediation approach for oversimplified coins

For the 9 Critical and 12 High coins, the single-asset adapter cannot represent multi-component reserves. Options:
1. **Static multi-slice adapter**: New adapter type that returns the curated reserves array as-is (no API fetch needed), but validates on-chain supply is non-zero. This is the simplest solution for coins without a transparency API.
2. **Per-coin transparency APIs**: Where issuers provide detailed attestation endpoints, build or extend adapters (like the accountable adapter pattern) to fetch real allocations.
3. **Accept the limitation**: For Low-severity 2-component same-risk coins, the current single-asset approach may be acceptable if the label is descriptive.

---

## Issue 3: Risk Rating Mismatches

**Impact:** The live reserve display shows a risk level that contradicts the curated reserves. This can mislead users about the actual safety of the backing.

| Coin ID | Curated Risk(s) | Live Risk | Severity | Details |
|---------|-----------------|-----------|----------|---------|
| apxusd-apyx | 75% high, 25% low | low | **Critical** | Crypto-linked preferred equities dominate |
| pmusd-precious-metals | 100% medium | very-low | **Critical** | Tokenized gold is medium risk, not very-low |
| gusd-gate | very-low/low/high mix | low | **High** | 5% unspecified yield instruments at high risk hidden |
| rwausdi-multipli | low/medium/medium/high | low | **High** | 10% hedge fund units at high risk hidden |
| avusd-avant | 95% medium, 5% medium | low | **High** | Delta-neutral strategies carry medium risk, rated low |
| aeur-anchored-coins | low + bankruptcy buffer | low | **High** | Active bankruptcy proceedings not reflected |
| usdai-usd-ai | low/low/high | low | **Medium** | 1% GPU collateral is high risk but tiny |
| europ-schuman | very-low + low | very-low | **Low** | 2% reserve fund at low risk, minor gap |

### Remediation

Fix `params.risk` in each coin's `liveReservesConfig` to reflect the weighted risk of the actual reserves, or (better) switch to a multi-slice adapter that represents each component's risk individually.

---

## Issue 4: Other Findings

### 4a. Semantic mismatch — `single-asset` semantics for multi-component coins

35 coins use `"semantics": "single-asset"` despite having multi-component curated reserves. The `semantics` field affects how the UI interprets and displays the data. Coins with diverse backing should use `"collateral-mix"` or `"attestation-mix"` semantics.

### 4b. Coins verified as correct

The following aspects were verified and found to have **no issues**:
- **Chain configurations**: All 69 on-chain single-asset configs point to a chain where the coin has a deployed contract
- **Breaker scopes**: All unique and correctly formatted
- **Adapter dispatch**: All adapter keys in configs match registered adapters in `index.ts`
- **DOLA adapter**: Correctly categorizes 25+ known assets across 5 risk buckets with proper warning generation for unknown assets
- **Accountable adapter** (usdu-unitas): Properly configured with bucket strategy and risk map

### 4c. Commodity coins — generally correct

The 6 commodity coins (xaut, xaum, dgld, pgold, ggbr, kag) use single-asset with gold/silver backing, which is genuinely single-asset. Their only issue is missing `display` blocks (4/6 have display, 2 don't).

### 4d. frxUSD adapter semantics mismatch

frxUSD uses `"semantics": "attestation-mix"` but the adapter returns a single hardcoded slice. Either the semantics should be `"single-asset"` to match what the adapter actually returns, or the adapter should be enhanced to return multiple slices to match the `attestation-mix` semantics.

---

## Remediation Priority Matrix

### P0 — Fix immediately (risk misrepresentation)

1. Fix `params.risk` for **pmusd-precious-metals** (medium, not very-low)
2. Fix `params.risk` for **apxusd-apyx** (high, not low)
3. Fix `params.risk` for **avusd-avant** (medium, not low)

### P1 — Fix soon (missing source, high-severity oversimplification)

4. Add `display` blocks to all 48 coins missing source attribution
5. Design and implement a static multi-slice adapter (or equivalent pattern) for the 9 Critical oversimplified coins
6. Fix `params.risk` for gusd-gate, rwausdi-multipli, aeur-anchored-coins

### P2 — Improve when capacity allows

7. Investigate Frax per-custodian API for frxUSD adapter enhancement
8. Consider per-asset granularity improvement for DOLA adapter
9. Switch 12 High-severity coins to multi-slice representation
10. Update `semantics` fields to match actual adapter behavior

### P3 — Acceptable as-is

11. Low-severity 2-component same-risk coins (14 coins) — current single-asset approach is adequate if label is descriptive
12. Commodity coins — genuinely single-asset, just need display block fixes

---

## Full Coin Inventory (60 new configs)

### From commodity.json (6)
| # | Coin ID | Adapter | Display | Oversimplified | Risk OK |
|---|---------|---------|:-------:|:--------------:|:-------:|
| 1 | xaut-tether | single-asset | Yes | No | Yes |
| 2 | xaum-matrixdock | single-asset | Yes | No | Yes |
| 3 | dgld-gold-token-sa | single-asset | Yes | No | Yes |
| 4 | pgold-pleasing | single-asset | **No** | No | Yes |
| 5 | ggbr-goldfish-gold | single-asset | **No** | No | Yes |
| 6 | kag-kinesis | single-asset | Yes | No | Yes |

### From non-usd.json (24)
| # | Coin ID | Adapter | Display | Oversimplified | Risk OK |
|---|---------|---------|:-------:|:--------------:|:-------:|
| 7 | a7a5-old-vector | single-asset | **No** | No | Yes |
| 8 | brz-transfero | single-asset | **No** | No | Yes |
| 9 | aeur-anchored-coins | single-asset | **No** | **Critical** | **No** |
| 10 | euri-banking-circle | single-asset | **No** | High | Yes |
| 11 | eure-monerium | single-asset | **No** | High | Yes |
| 12 | eurs-stasis | single-asset | **No** | No | Yes |
| 13 | xsgd-straitsx | single-asset | **No** | No | Yes |
| 14 | gyen-gyen | single-asset | **No** | No | Yes |
| 15 | audd-novatti | single-asset | **No** | No | Yes |
| 16 | jpyc-jpyc | single-asset | **No** | No | Yes |
| 17 | axcnh-anchorx | single-asset | **No** | No | Yes |
| 18 | idrt-rupiah-token | single-asset | **No** | No | Yes |
| 19 | tryb-bilira | single-asset | **No** | No | Yes |
| 20 | veur-vnx | single-asset | **No** | No | Yes |
| 21 | eurr-stablr | single-asset | **No** | No | Yes |
| 22 | europ-schuman | single-asset | **No** | High | **No** (minor) |
| 23 | eurq-quantoz | single-asset | **No** | High | Yes |
| 24 | eurau-allunity | single-asset | **No** | No | Yes |
| 25 | vchf-vnx | single-asset | **No** | No | Yes |
| 26 | vgbp-vnx | single-asset | **No** | No | Yes |
| 27 | tgbp-tokenised | single-asset | **No** | No | Yes |
| 28 | zarp-zarp | single-asset | **No** | No | Yes |
| 29 | cadc-cad-coin | single-asset | **No** | No | Yes |
| 30 | pht-pht | single-asset | **No** | No | Yes |

### From usd-major.json (4)
| # | Coin ID | Adapter | Display | Oversimplified | Risk OK |
|---|---------|---------|:-------:|:--------------:|:-------:|
| 31 | usdg-paxos | single-asset | Yes | High | Yes |
| 32 | rlusd-ripple | single-asset | Yes | High | Yes |
| 33 | u-united-stables | single-asset | Yes | **Critical** | Yes |
| 34 | usdai-usd-ai | single-asset | Yes | **Critical** | **No** (minor) |

### From usd-minor.json (26)
| # | Coin ID | Adapter | Display | Oversimplified | Risk OK |
|---|---------|---------|:-------:|:--------------:|:-------:|
| 35 | dola-inverse | dola-inverse | Yes | No* | Yes |
| 36 | ausd-agora | single-asset | Yes | High | Yes |
| 37 | gusd-gate | single-asset | **No** | **Critical** | **No** |
| 38 | rwausdi-multipli | single-asset | **No** | **Critical** | **No** |
| 39 | avusd-avant | single-asset | **No** | **Critical** | **No** |
| 40 | pusd-pleasing | single-asset | **No** | **Critical** | Yes |
| 41 | pmusd-precious-metals | single-asset | **No** | No | **No** |
| 42 | mnee-mnee | single-asset | **No** | Low | Yes |
| 43 | tbill-openeden | single-asset | **No** | Low | Yes |
| 44 | usdu-unitas | accountable | Yes | No | Yes |
| 45 | cgusd-cygnus-finance | single-asset | **No** | High | Yes |
| 46 | usdq-quantoz | single-asset | Yes | Low | Yes |
| 47 | usdx-hex-trust | single-asset | **No** | Low | Yes |
| 48 | xusd-straitsx | single-asset | **No** | Low | Yes |
| 49 | usdcv-societe-generale-forge | single-asset | **No** | No | Yes |
| 50 | zeusd-zoth | single-asset | **No** | **Critical** | Yes |
| 51 | usat-tether | single-asset | **No** | Low | Yes |
| 52 | fidd-fidelity | single-asset | **No** | High | Yes |
| 53 | msusd-main-street | single-asset | **No** | No | Yes |
| 54 | pusd-plume | single-asset | **No** | No | Yes |
| 55 | wusd-worldwide | single-asset | **No** | High | Yes |
| 56 | sbc-brale | single-asset | **No** | High | Yes |
| 57 | usdr-stablr | single-asset | **No** | Low | Yes |
| 58 | thbill-theo | single-asset | **No** | No | Yes |
| 59 | aid-gaib | single-asset | **No** | No | Yes |
| 60 | apxusd-apyx | single-asset | **No** | **Critical** | **No** |

*DOLA uses a sophisticated custom adapter; could be further improved with per-asset granularity.

---

## Statistics

- **Total new configs:** 60
- **Configs with no issues:** 8 (13%)
- **Configs with display-only issue:** 23 (38%)
- **Configs with oversimplification issue:** 12 (20%)
- **Configs with both display + oversimplification:** 17 (28%)
- **Configs with risk mismatch:** 8 (includes overlap with above)
