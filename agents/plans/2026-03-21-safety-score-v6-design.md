# Safety Score v6 Design Plan

**Date:** 2026-03-21
**Status:** Draft — pending review
**Motivation:** User reports and observation have revealed structural unfairness in v5.9:
centralized custodians with top-tier banks score identically to sanctioned ones,
Solana-based coins are obliterated by chain penalties, native-multichain deployment
is penalized more harshly than third-party bridges, and well-built centralized
stablecoins structurally cap at grade B.

---

## Change 1: Custody Model Tiers

### Problem

`CUSTODY_MODEL_SCORE` maps all institutional custodians to a flat **50**. A7A5
(reserves at Promsvyazbank, a sanctioned Russian state bank) scores identically
to BUIDL (Bank of New York Mellon) and USDC (Circle Reserve Fund managed by
BlackRock, custodied at BNY Mellon).

Under v6's 2-factor Resilience (Change 4), custody is 1/2 of the dimension
(effective weight on final score: 22.2% × 50% = 11.1%). A 75-point spread
between best and worst custodian translates to ~8pts on the final grade.

### Proposal

Replace the flat `institutional = 50` with four tiers:

| Tier | Score | Criteria | Examples |
|------|-------|----------|----------|
| `institutional-top` | 80 | G-SIB bank, or SEC/MAS-regulated fund custodian, or SOC 2 Type II + MiFID/MiCA/Dodd-Frank | BNY Mellon (BUIDL), BlackRock fund (USDC), Circle EEA (EURC) |
| `institutional-regulated` | 55 | Operates under verifiable regulatory license (OCC charter, state trust, TCSP, BMA DABA, FINRA) but not G-SIB | Anchorage Digital (OCC), Hex Trust (TCSP), Cantor Fitzgerald (FINRA), Ankura Trust |
| `institutional-unregulated` | 30 | Claims institutional custody but no verifiable regulatory framework, offshore with minimal oversight | Unnamed offshore custodians, opaque arrangements |
| `institutional-sanctioned` | 5 | Custodian or primary banking partner under international sanctions (OFAC, EU, UN) | Promsvyazbank (A7A5) |

The ceiling at 80 (not 100) preserves the principle that any off-chain custody
carries inherent counterparty risk vs. fully on-chain custody.

### Implementation

- Add `CustodyModel` variants: `"institutional-top" | "institutional-regulated" | "institutional-unregulated" | "institutional-sanctioned"` to `shared/types/core.ts`
- Update `CUSTODY_MODEL_SCORE` in `shared/lib/report-cards.ts`
- Update `inferResilienceDefaults()` — the default for rwa-backed centralized
  becomes `institutional-regulated` (55). This is the conservative middle tier:
  close to the old flat 50, safe for unclassified coins, and only 5pts above
  the old value so new coins don't need immediate curation to avoid score drift.
  Explicit overrides are required to reach `institutional-top` or to flag
  `institutional-sanctioned`.
- Add `custodyModel` overrides to stablecoin metadata for the initial batch
  of coins with verified top-tier or sanctioned custodians (see table below)
- Update Zod schema in `shared/lib/stablecoins/schema.ts`
- Update docs: `docs/report-cards.md` Resilience section

### Classification for tracked coins (initial batch)

| Coin | v5.9 Custody | v6 Custody | Justification |
|------|-------------|------------|---------------|
| USDC | institutional (50) | institutional-top (80) | BlackRock fund, BNY Mellon custody |
| BUIDL | institutional (50) | institutional-top (80) | BNY Mellon custody |
| EURC | institutional (50) | institutional-top (80) | Circle EEA, regulated financial institutions |
| frxUSD | institutional (50) | institutional-top (80) | BlackRock BUIDL + Circle + Superstate (SEC) custodians |
| DAI | institutional (50) | institutional-top (80) | RWA at regulated institutions + USDC/Circle |
| USDS | institutional (50) | institutional-top (80) | Same reserve structure as DAI |
| USDT | institutional (50) | institutional-regulated (55) | Cantor Fitzgerald (primary dealer), BDO audit; El Salvador domicile |
| USDY | institutional (50) | institutional-regulated (55) | US prime brokerage, Ankura Trust; BVI domicile |
| USYC | institutional (50) | institutional-regulated (55) | BMA-regulated, DABA license, segregated prime brokerage |
| jupUSD | institutional (50) | institutional-regulated (55) | Porto / Anchorage Digital (OCC-chartered) |
| A7A5 | institutional (50) | institutional-sanctioned (5) | Promsvyazbank under international sanctions |

Coins with `onchain` or `cex` custody are unchanged (100 and 0 respectively).

---

## Change 2: Chain Tier — Split "established-alt-l1"

### Problem

The 66 → 20 cliff between `stage1-l2` and `established-alt-l1` is too large.
Solana (3+ years mainnet, massive validator set, proven incident recovery, major
TVL) gets the same 20 as any newer alt-L1.

This compounds with chain penalties: a multisig coin on Solana
(`chainInfraScore = 20`) gets a **-50 penalty** on decentralization, while the
same coin on a Stage 1 L2 (`chainInfraScore = 66`) gets only -15. Meanwhile
centralized issuers on the same chain are exempt.

### Proposal

Split `established-alt-l1` into two tiers:

| Tier | Score | Criteria | Examples |
|------|-------|----------|----------|
| `ethereum` | 100 | | Ethereum mainnet |
| `stage1-l2` | 66 | Stage 1+ rollup (L2Beat classification) | Arbitrum, Base, Optimism |
| `mature-alt-l1` | 45 | 3+ years mainnet, large validator set, proven recovery, major TVL | Solana, BNB Chain, Avalanche |
| `established-alt-l1` | 20 | 1+ year mainnet, functional but limited track record | Sui, Aptos, Berachain, Celo |
| `unproven` | 0 | New, canary, or compromised chains | PulseChain, Songbird, Harmony |

### Smoother penalty thresholds

Replace the current cliff-heavy thresholds with a 5-band curve:

| Combined infraScore | v5.9 Penalty | v6 Penalty |
|---------------------|-------------|------------|
| 80–100 | 0 | 0 |
| 60–79 | -15 | -10 |
| 40–59 | -15 | -25 |
| 20–39 | -50 | -40 |
| 0–19 | -65 | -60 |

The 35-point cliff between -15 and -50 (at score 50) is replaced by two
graduated steps (-10, -25). The worst penalty softens from -65 to -60.

### Implementation

- Add `"mature-alt-l1"` to `ChainTier` in `shared/types/core.ts`
- Update `CHAIN_TIER_SCORE` in `shared/lib/report-cards.ts`
- Replace 4-threshold penalty logic with 5-threshold in `scoreDecentralization()`
- Add `wrapper` to the chain-penalty exemption list (alongside `immutable-code`,
  `single-entity`, `regulated-entity`). Wrappers already pay for their thin
  governance via the low base score (10) and the dependency-risk ceiling
  (upstream_score - 3). Compounding a chain penalty on top double-counts the risk.
- Reclassify coins: update `chainTier` overrides in stablecoin JSON data
  - Solana-native coins → `mature-alt-l1`: jupUSD, USX, hyUSD, BUCK, CASH, etc.
  - BNB Chain coins → `mature-alt-l1`: lisusd, etc.
  - Keep `established-alt-l1` for: Sui, Aptos, Berachain, Celo, Tezos
- Update Zod schema, docs, chains.ts if needed

### Key combined-score examples under v6

| Scenario | Chain Score | Deploy Mult | Combined | Penalty |
|----------|-----------|-------------|----------|---------|
| Ethereum + single-chain | 100 | 1.00 | 100 | 0 |
| Ethereum + third-party-bridge | 100 | 0.60 | 60 | -10 |
| Stage1-L2 + single-chain | 66 | 1.00 | 66 | -10 |
| Mature-alt-L1 + single-chain | 45 | 1.00 | 45 | -25 |
| Mature-alt-L1 + native-multichain | 45 | 0.75 | 34 | -40 |
| Established-alt-L1 + single-chain | 20 | 1.00 | 20 | -40 |
| Unproven + any | 0 | any | 0 | -60 |

---

## Change 3: Bridge Penalty Reorder

### Problem

`native-multichain` (0.40) is penalized more harshly than `third-party-bridge`
(0.60). This ordering is backwards:

- For centralized issuers (exempt from chain penalty anyway), native multichain
  IS the safest deployment — direct issuance on each chain, no bridge to hack.
- For DAO/multisig protocols, the risk of coordinating governance across chains
  is real but much less than depending on a third-party bridge (Wormhole, LayerZero)
  that could be exploited.
- Even on Ethereum (100), a DAO coin with native-multichain gets
  `chainInfraScore = 40`, triggering -50 in v5.9. That's the same penalty as
  third-party bridge on an alt-L1.

### Proposal

Reorder and adjust deployment multipliers:

| Model | v5.9 Mult | v6 Mult | Rationale |
|-------|----------|---------|-----------|
| `single-chain` | 1.00 | 1.00 | Unchanged |
| `canonical-bridge` | 0.85 | 0.90 | Rollup canonical bridges inherit rollup security; 10% discount is sufficient |
| `native-multichain` | 0.40 | 0.75 | Reordered above third-party; governance coordination risk is real but manageable |
| `third-party-bridge` | 0.60 | 0.60 | Unchanged; bridge exploits remain a material risk |

### Implementation

- Update `DEPLOYMENT_MULT` values in `shared/lib/report-cards.ts`
- No type changes needed (the enum values stay the same)
- Recompute `chainInfraScore()` matrix in docs

### Impact on USDT (native-multichain)

USDT is native-multichain and centralized, so it's exempt from chain penalty —
this change does not affect USDT's score. It primarily benefits DAO-governed
or multisig coins that issue natively across chains (e.g., if FRAX or GHO
adopted native multichain deployment).

---

## Change 4: Remove Blacklist from Resilience

### Problem

Blacklist capability is scored in **two** dimensions simultaneously:

1. **Decentralization:** governance quality tiers (single-entity 20,
   regulated-entity 40, dao-governance 85, immutable-code 100) already
   encode how much centralized control exists — including freeze capability.
2. **Resilience:** blacklist sub-factor (yes=33, possible=66, no=100) penalizes
   the same architectural trait again.

For centralized issuers, blacklisting is inseparable from their governance
structure — it's legally mandated, not a discretionary choice. Counting it in
both dimensions double-penalizes the architecture. This is the same principle
that led us to exempt wrappers from chain penalties: don't compound penalties
for the same risk.

For DeFi coins with "possible-inherited" blacklist (DAI, frxUSD — they hold
USDC in reserves), the double-counting is even more egregious: they already
pay for USDC dependency in the Dependency Risk dimension AND get penalized
for inherited blacklist in Resilience.

### Proposal

Remove blacklist capability as a scoring sub-factor from Resilience. Resilience
becomes a 2-factor solvency measure:

```
Resilience = round((Collateral Quality + Custody Model) / 2)
```

- **Collateral Quality** answers: "Are the underlying assets safe?"
- **Custody Model** answers: "Can you trust who holds them?"
- **Blacklist capability** answers: "Can individual users be censored?" — this
  is a governance/censorship question, fully handled by Decentralization.

Blacklist data remains computed (`isBlacklistable()`) and displayed on the
report card as descriptive context. It stops being a scoring input in Resilience.

### Implementation

- Simplify `scoreResilience()` in `shared/lib/report-cards.ts`: remove
  blacklist score from the average, use `(collateralScore + custodyScore) / 2`
- Keep `isBlacklistable()` computation for UI display and `RawDimensionInputs`
- Update `RawDimensionInputs` docs to note blacklist is descriptive only
- Update `docs/report-cards.md` Resilience section

### Impact

The shift is large and intentional — it corrects the structural double-counting:

| Coin | v5.9 Res (3-factor) | v6 Res (2-factor) | Δ | Why |
|------|--------------------|--------------------|---|-----|
| USDC | 61 | 90 | +29 | Blacklist=33 was the main drag |
| BUIDL | 61 | 90 | +29 | Same |
| USDY | 61 | 78 | +17 | Same — also resolves the USDY regression |
| USDT | 59 | 75 | +16 | Same |
| EURC | 44 | 65 | +21 | Same |
| DAI | 62 | 75 | +13 | Inherited blacklist=66 removed (already in Dep Risk) |
| frxUSD | 63 | 77 | +14 | Same |
| USDS | 62 | 75 | +13 | Same |
| USX | 80 | 88 | +8 | Inherited blacklist=66 was dragging |
| jupUSD | 75 | 65 | -10 | Blacklist=100 was helping; now only collateral+custody |
| BOLD | 94 | 92 | -2 | Blacklist=100 was a slight tailwind |
| LUSD | 100 | 100 | — | (100+100)/2 = 100, unchanged |
| USDe | 56 | 35 | -21 | CEX custody (0) fully exposed; blacklist=100 no longer masks it |
| A7A5 | 29 | 5 | -24 | Sanctioned custody (5) fully exposed |

**USDe note:** The large drop is correct — USDe stores collateral at CEXes
(Binance, Deribit via Ceffu/Copper). CEX custody IS the primary solvency risk.
The old blacklist=100 score was masking this by averaging in a non-solvency
signal. A Resilience of 35 accurately reflects the custody risk.

**jupUSD note:** The -10 drop is offset by the +25 Decen improvement from
Change 2 (chain tier fix). Net effect is still positive (+1.8 base points).

---

## Impact Analysis: 15 Selected Coins

### Scoring inputs per coin

Columns: Collateral quality (from reserves or enum fallback), Custody model,
Governance quality, Chain infrastructure score. Blacklist is no longer a
Resilience scoring input (Change 4) — it remains as descriptive context.

| # | Coin | Type | Collat. | v5.9 Custody | v6 Custody | GovQual | v5.9 Infra | v6 Infra |
|---|------|------|---------|-------------|------------|---------|-----------|---------|
| 1 | BOLD | Immutable CDP | 83 | onchain (100) | 100 | immutable (100) | exempt | exempt |
| 2 | frxUSD | DAO + RWA custodians | 74 | instit. (50) | top (80) | dao (85) | ETH×3P=60 | 60 |
| 3 | USDY | Centralized RWA | 100 | instit. (50) | regulated (55) | single (20) | exempt | exempt |
| 4 | USYC | Centralized RWA | 100 | instit. (50) | regulated (55) | single (20) | exempt | exempt |
| 5 | jupUSD | CeFi-dep on Solana | 75 | instit. (50) | regulated (55) | multisig (55) | altL1=20 | mature=45 |
| 6 | USX | Wrapper on Solana | 75 | onchain (100) | 100 | wrapper (10) | altL1=20 | exempt |
| 7 | USDC | Regulated centralized | 100 | instit. (50) | top (80) | reg-entity (40) | exempt | exempt |
| 8 | A7A5 | Sanctioned centralized | 5 | instit. (50) | sanctioned (5) | single (20) | exempt | exempt |
| 9 | BUIDL | Centralized RWA | 100 | instit. (50) | top (80) | single (20) | exempt | exempt |
| 10 | USDe | CeFi-dep + CEX custody | 69 | cex (0) | 0 | multisig (55) | ETH×3P=60 | 60 |
| 11 | DAI | DAO + mixed collateral | 70 | instit. (50) | top (80) | dao (85) | ETH×3P=60 | 60 |
| 12 | USDT | Regulated centralized | 95 | instit. (50) | regulated (55) | reg-entity (40) | exempt | exempt |
| 13 | LUSD | Immutable CDP | 100 | onchain (100) | 100 | immutable (100) | exempt | exempt |
| 14 | USDS | DAO + mixed collateral | 70 | instit. (50) | top (80) | dao (85) | ETH×3P=60 | 60 |
| 15 | EURC | Regulated centralized | 50* | instit. (50) | top (80) | reg-entity (40) | exempt | exempt |

\* EURC uses `rwa` enum fallback (50) — no curated reserves yet. Would rise with reserve curation.

### Dimension-level impact

| # | Coin | v5.9 Resilience | v6 Resilience | ΔRes | v5.9 Decen | v6 Decen | ΔDec | Est. ΔBase |
|---|------|----------------|--------------|------|-----------|---------|------|-----------|
| 1 | **BOLD** | 94 | 92 | -2 | 100 | 100 | — | **-0.4** |
| 2 | **frxUSD** | 63 | 77 | +14 | 70 | 75 | +5 | **+3.9** |
| 3 | **USDY** | 61 | 78 | +17 | 20 | 20 | — | **+3.8** |
| 4 | **USYC** | 61 | 78 | +17 | 20 | 20 | — | **+3.8** |
| 5 | **jupUSD** | 75 | 65 | -10 | 5 | 30 | +25 | **+1.9** |
| 6 | **USX** | 80 | 88 | +8 | 0 | 10 | +10 | **+3.4** |
| 7 | **USDC** | 61 | 90 | +29 | 40 | 40 | — | **+6.4** |
| 8 | **A7A5** | 29 | 5 | -24 | 20 | 20 | — | **-5.3** |
| 9 | **BUIDL** | 61 | 90 | +29 | 20 | 20 | — | **+6.4** |
| 10 | **USDe** | 56 | 35 | -21 | 40 | 45 | +5 | **-3.8** |
| 11 | **DAI** | 62 | 75 | +13 | 70 | 75 | +5 | **+3.7** |
| 12 | **USDT** | 59 | 75 | +16 | 40 | 40 | — | **+3.6** |
| 13 | **LUSD** | 100 | 100 | — | 100 | 100 | — | **0** |
| 14 | **USDS** | 62 | 75 | +13 | 70 | 75 | +5 | **+3.7** |
| 15 | **EURC** | 44 | 65 | +21 | 40 | 40 | — | **+4.7** |

**Est. ΔBase** = ΔResilience × (0.20/0.90) + ΔDecentralization × (0.15/0.90).
The base dimension weights sum to 0.90; division by `ratedWeight` normalizes
to a proper weighted average (effective weights: 33.3% / 22.2% / 16.7% / 27.8%).

### Computation detail: Resilience

`Resilience = round((Collateral + Custody) / 2)` — blacklist removed (Change 4)

| Coin | Collat | v5.9 Cust | v6 Cust | v5.9 Res (3-factor) | v6 Res (2-factor) |
|------|--------|----------|---------|--------------------|--------------------|
| BOLD | 83 | 100 | 100 | 94 | 92 |
| frxUSD | 74 | 50 | 80 | 63 | 77 |
| USDY | 100 | 50 | 55 | 61 | 78 |
| USYC | 100 | 50 | 55 | 61 | 78 |
| jupUSD | 75 | 50 | 55 | 75 | 65 |
| USX | 75 | 100 | 100 | 80 | 88 |
| USDC | 100 | 50 | 80 | 61 | 90 |
| A7A5 | 5 | 50 | 5 | 29 | 5 |
| BUIDL | 100 | 50 | 80 | 61 | 90 |
| USDe | 69 | 0 | 0 | 56 | 35 |
| DAI | 70 | 50 | 80 | 62 | 75 |
| USDT | 95 | 50 | 55 | 59 | 75 |
| LUSD | 100 | 100 | 100 | 100 | 100 |
| USDS | 70 | 50 | 80 | 62 | 75 |
| EURC | 50 | 50 | 80 | 44 | 65 |

### Computation detail: Decentralization

`Decen = GovQualityScore + chainPenalty` (exempt types skip penalty)

| Coin | GovQual | Exempt? | v5.9 Infra | v5.9 Pen | v5.9 Dec | v6 Infra | v6 Pen | v6 Dec |
|------|---------|---------|-----------|---------|---------|---------|--------|--------|
| BOLD | immut 100 | yes | — | 0 | 100 | — | 0 | 100 |
| frxUSD | dao 85 | no | 60 | -15 | 70 | 60 | -10 | 75 |
| USDY | single 20 | yes | — | 0 | 20 | — | 0 | 20 |
| USYC | single 20 | yes | — | 0 | 20 | — | 0 | 20 |
| jupUSD | multi 55 | no | 20 | -50 | 5 | 45 | -25 | 30 |
| USX | wrap 10 | v5.9 no | 20 | -50 | 0 | v6 yes | 0 | 10 |
| USDC | reg-ent 40 | yes | — | 0 | 40 | — | 0 | 40 |
| A7A5 | single 20 | yes | — | 0 | 20 | — | 0 | 20 |
| BUIDL | single 20 | yes | — | 0 | 20 | — | 0 | 20 |
| USDe | multi 55 | no | 60 | -15 | 40 | 60 | -10 | 45 |
| DAI | dao 85 | no | 60 | -15 | 70 | 60 | -10 | 75 |
| USDT | reg-ent 40 | yes | — | 0 | 40 | — | 0 | 40 |
| LUSD | immut 100 | yes | — | 0 | 100 | — | 0 | 100 |
| USDS | dao 85 | no | 60 | -15 | 70 | 60 | -10 | 75 |
| EURC | reg-ent 40 | yes | — | 0 | 40 | — | 0 | 40 |

---

## Summary of Winners, Losers, and Unchanged

### Biggest winners (+3 or more estimated base points)

| Coin | ΔBase | Primary driver |
|------|-------|----------------|
| USDC | +6.4 | Custody upgrade (50→80) + blacklist double-count removed |
| BUIDL | +6.4 | Same as USDC |
| EURC | +4.7 | Custody upgrade + blacklist removed (biggest Res gain: 44→65) |
| frxUSD | +3.9 | Custody upgrade + inherited blacklist removed + softer chain band |
| USDY | +3.8 | Blacklist removed (was the main drag); custody upgrade |
| USYC | +3.8 | Same as USDY |
| DAI | +3.7 | Custody upgrade + inherited blacklist removed + softer chain band |
| USDS | +3.7 | Same as DAI |
| USDT | +3.6 | Custody upgrade + blacklist removed |
| USX | +3.4 | Inherited blacklist removed + wrapper chain-penalty exemption |

### Moderate winners (+1 to +2 base points)

| Coin | ΔBase | Primary driver |
|------|-------|----------------|
| jupUSD | +1.9 | Chain tier fix (+25 Decen) offset by blacklist removal (-10 Res) |

### Losers

| Coin | ΔBase | Primary driver |
|------|-------|----------------|
| A7A5 | -5.3 | Sanctioned custody (50→5) fully exposed without blacklist buffer |
| USDe | -3.8 | CEX custody (0) fully exposed; blacklist=100 was masking solvency risk |

### Near-unchanged

| Coin | ΔBase | Why |
|------|-------|-----|
| BOLD | -0.4 | Blacklist=100 was a slight tailwind; grade unaffected |
| LUSD | 0 | (100+100)/2 = 100, identical to 3-factor |

---

## Design Principles

### Core invariant

The Safety Score must be a framework where **two fundamentally different but
well-executed stablecoins can both fare well:**

- A maximally decentralized, immutable, on-chain coin (BOLD, LUSD)
- A centralized but regulated, transparent, top-custodied coin (USDC, EURC)

v5.9 fails this test. The structural ceiling for a perfectly-run centralized
stablecoin is ~70 (grade B). Even USDC — independently audited, NYDFS-regulated,
custodied at BNY Mellon — cannot reach A-. Only immutable DeFi coins can. This
doesn't reflect a real safety insight; it reflects a scoring framework biased
toward one architecture.

v6 corrects this by recognizing that custodian quality, regulatory framework,
and transparency are meaningful safety signals for centralized issuers, just as
immutability and on-chain collateral are for decentralized ones. The net uplift
for well-built centralized coins is intentional — it is a correction of
structural under-scoring, not grade inflation.

### Why these specific numbers

Each parameter is derived from two constraints:

**Constraint 1 — Meaningful grade separation.** Each tier must be spaced far
enough apart that the difference produces at least a half-grade shift on the
final score. With custody at 50% of Resilience (effective weight on base:
22.2% × 50% = 11.1%), a 25pt custody gap shifts the base score by ~2.8pts
(roughly half a grade band). The chosen tiers (80, 55, 30, 5) have minimum
25pt gaps — right at this threshold.

**Constraint 2 — Ceiling preservation.** Off-chain custody always carries
counterparty risk that on-chain custody does not (custodian insolvency, asset
freezes, operational failure, jurisdictional seizure). Even the best
institutional custodian (BNY Mellon) cannot match the risk profile of
immutable smart contracts holding ETH. The 20-point gap between
`institutional-top` (80) and `onchain` (100) encodes this irreducible risk
premium.

Applied to each change:

| Parameter | Value | Anchoring rationale |
|-----------|-------|---------------------|
| `institutional-top` | 80 | 20pt gap to onchain: irreducible off-chain counterparty risk |
| `institutional-regulated` | 55 | 25pt gap from top: regulated but not G-SIB caliber |
| `institutional-unregulated` | 30 | 25pt gap from regulated: no verifiable framework |
| `institutional-sanctioned` | 5 | Near-zero: custody assurance functionally destroyed |
| `mature-alt-l1` | 45 | Midpoint between stage1-l2 (66) and established (20); must land in a different penalty band than both |
| Penalty band 60-79 | -10 | Softer than v5.9's -15; recognizes that Ethereum + third-party bridge (60) is still a strong chain |
| Penalty band 40-59 | -25 | New graduated step; eliminates the 35pt cliff at score 50 |
| `native-multichain` mult | 0.75 | Above third-party-bridge (0.60): native issuance removes bridge exploit risk |
| `canonical-bridge` mult | 0.90 | Rollup canonical bridges inherit rollup security; 10% discount suffices |
| Blacklist removal | n/a | Censorship risk is a governance concern (Decentralization), not a solvency concern (Resilience) |

### Theoretical ceilings under v6

To verify the core invariant, here are the maximum achievable scores for
each architecture, assuming perfect execution across all dimensions.

**Important: the base score formula normalizes by the sum of rated
weights.** The four base dimension weights sum to 0.90 (not 1.0, since
peg is a multiplier with weight 0). When all four are rated, the formula
`weightedSum / ratedWeight` divides by 0.90, yielding a proper 0–100
weighted average. All computations below include this normalization.

**Decentralized, immutable, on-chain (BOLD-like):**
- Resilience: (100 collateral + 100 onchain) / 2 = **100**
- Decentralization: immutable-code = **100**
- Dependency Risk: decentralized, no deps = **90**
- Liquidity: assume **95**
- weightedSum: 95×0.30 + 100×0.20 + 100×0.15 + 90×0.25 = 86
- Base: 86 / 0.90 = **95.6** → grade **A+**

**Centralized, regulated, top-custodied (USDC-like):**
- Resilience: (100 collateral + 80 top-custody) / 2 = **90**
- Decentralization: regulated-entity = **40**
- Dependency Risk: centralized, no deps = **95**
- Liquidity: assume **95**
- weightedSum: 95×0.30 + 90×0.20 + 40×0.15 + 95×0.25 = 76.25
- Base: 76.25 / 0.90 = **84.7** → grade **A**

Both architectures reach A range. The ~11pt gap between the ceilings
represents the genuine structural difference: on-chain custody eliminates
counterparty risk, immutable governance eliminates key-compromise risk.
These are real security advantages, not scoring artifacts. But the gap
is no longer so wide that a well-built centralized coin is structurally
excluded from top grades.

For comparison, v5.9 ceilings (3-factor Resilience, flat institutional=50):
- BOLD-like: Resilience=100, Base = (95×0.30 + 100×0.20 + 100×0.15 + 90×0.25) / 0.90 = **95.6** (A+)
- USDC-like: Resilience=61, Base = (95×0.30 + 61×0.20 + 40×0.15 + 95×0.25) / 0.90 = **78.3** (B+)
- v6 lifts the USDC-like ceiling from **78 to 85** (+7pts, from B+ to A).

### Regression invariants

Sanity checks that v6 must satisfy. These encode the core invariant and serve
as test cases during implementation:

1. **Architecture neutrality:** BOLD (decentralized) and USDC (centralized)
   should both be able to reach grade A or above with strong peg and liquidity.
2. **Custody discrimination:** USDC Resilience > A7A5 Resilience (top-tier
   custodian must beat sanctioned custodian).
3. **Immutable baseline:** BOLD and LUSD overall grades are unaffected.
   (BOLD Resilience drops 94→92 from blacklist removal — a slight tailwind
   lost — but the grade remains unchanged.)
4. **Custody floor preserved:** `institutional-top` (80) < `onchain` (100) —
   off-chain always carries counterparty risk.
5. **Chain tier ordering preserved:** no coin should score higher on
   decentralization by moving to a less mature chain.
6. **No letter-grade cliff:** no coin should change by more than one full
   letter grade (e.g., B to D) from methodology alone — except where the
   change reflects a genuinely corrected risk assessment (A7A5 sanctioned
   custody, USDe CEX custody exposure).
7. **Sanctioned penalty:** A coin with a sanctioned custodian must score
   lower on Resilience than the same coin with an unregulated custodian
   (institutional-sanctioned < institutional-unregulated).
8. **No double-counting:** No single architectural trait should be penalized
   in more than one dimension. Censorship risk → Decentralization only.
   Wrapper dependency → Dependency Risk only. Solvency risk → Resilience only.

---

## Open Questions

1. **USDe magnitude:** USDe drops -3.8 base points as CEX custody (0) is
   fully exposed without the blacklist=100 buffer. This correctly reflects the
   solvency risk of CEX-custodied delta-neutral positions, but the magnitude
   may warrant review — verify that USDe's final grade still feels appropriate
   relative to peers.

## Resolved

- **Wrapper chain penalty exemption:** Wrappers are now exempt from chain
  penalty. They already pay through the low governance base (10) and the
  dependency-risk ceiling (upstream - 3). Compounding a chain penalty
  double-counts the risk.

- **Custody tier classification approach:** Manual overrides with a conservative
  default. Automated inference is unreliable because our metadata describes the
  **issuer** (jurisdiction, license) while custody quality depends on the
  **custodian** (BNY Mellon, Anchorage, etc.) — these are different entities.
  A BVI-domiciled fund can use a G-SIB bank as custodian (BUIDL does this).
  The default for all `institutional` custody is `institutional-regulated` (55),
  close to the old flat 50, minimizing disruption for unclassified coins.
  Explicit overrides to `institutional-top` or `institutional-sanctioned` are
  curated manually.

- **USDY regression:** No longer an issue. Removing blacklist from Resilience
  eliminates the USDY regression entirely — USDY gains +3.8 base points
  instead of dropping -0.2. The blacklist score (33) was USDY's worst
  sub-factor and was double-counting governance risk already in Decentralization.

- **Blacklist regulated/unregulated split (former Change 4):** Superseded by
  the decision to remove blacklist from Resilience entirely. The reg/unreg
  distinction is no longer needed as a scoring input. Blacklist capability
  remains as descriptive context on the report card.

---

## Implementation Order

### Phase 1: v6.0 launch (initial batch)

1. **Types + constants** — Add new enum values to `shared/types/core.ts`, update
   score maps and penalty thresholds in `shared/lib/report-cards.ts`
2. **Metadata classification (initial batch)** — Update `custodyModel` and
   `chainTier` overrides in `shared/data/stablecoins/*.json` for the ~15 coins
   with verified custodian data (see "Classification for tracked coins" table
   in Change 1). All other `institutional` coins default to
   `institutional-regulated` (55).
3. **Tests** — Update `shared/lib/__tests__/report-cards.test.ts` with new tiers
   and penalty thresholds
4. **Documentation** — Update `docs/report-cards.md`, `docs/report-cards-timeline.md`,
   methodology page
5. **Version bump** — Add v6.0 entry to `shared/lib/safety-score-version.ts`

All changes are to the pure grading engine (`shared/lib/report-cards.ts`) and
stablecoin metadata (`shared/data/stablecoins/*.json`). No worker, API, or
frontend code changes needed beyond the version bump.

### Phase 2: Custodian curation sweep

After v6.0 ships, systematically curate `custodyModel` overrides for all
remaining `institutional` coins that still sit at the default
`institutional-regulated` (55). Priority order:

1. **Top-30 by market cap** — highest user impact, most likely to have
   verifiable custodian information
2. **Coins with curated reserves** — we already researched their backing;
   the custodian is often documented in the `collateral` free-text field
3. **Remaining coins** — lower-cap and newer assets; many will legitimately
   stay at the `institutional-regulated` default

For each coin, verify the custodian identity and classify:
- Look up the custodian named in the `collateral` field or issuer documentation
- Check if the custodian is a G-SIB bank or SEC/MAS-regulated fund → `institutional-top`
- Check for regulatory licenses (OCC, TCSP, FINRA, etc.) → `institutional-regulated` (confirm default)
- Flag any sanctioned entities → `institutional-sanctioned`
- Flag opaque/unverifiable custodians → `institutional-unregulated`

This can be done incrementally — each curated override improves scoring
precision without blocking the v6.0 launch.
