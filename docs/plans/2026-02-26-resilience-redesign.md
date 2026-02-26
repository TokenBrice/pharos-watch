# Resilience Dimension Redesign

**Date:** 2026-02-26
**Status:** Approved

## Problem

The resilience dimension is binary (blacklistable=0, not=100) and misses critical risk factors. This lets coins like HYUSD (Solana + risky LSTs), USDe (opaque delta-neutral + CEX custody), and meUSD (unproven Bitcoin L2 + bridged BTC) score 100 on resilience despite carrying significant real-world risk.

## Design

Replace the binary blacklist check with a **4-sub-factor weighted average**, each scored 0-100 with equal 25% weight.

### Sub-factors

#### 1. Chain Risk (25%)

Score based on the primary chain where the protocol operates and collateral is held.

| Tier | Score | Examples |
|---|---|---|
| Ethereum mainnet | 100 | LUSD, BOLD, DAI, USDe |
| Stage 1+ L2 | 66 | Coins on Arbitrum, Optimism, Base |
| Established alt-L1 | 33 | HYUSD (Solana), BSC-native coins |
| Unproven chains | 0 | meUSD (Mezo Bitcoin L2) |

#### 2. Collateral Quality (25%)

Score based on the trust assumptions in the backing assets.

| Tier | Score | Examples |
|---|---|---|
| Native assets (ETH, BTC) | 100 | LUSD (pure ETH), BOLD (ETH) |
| Ethereum LSTs (stETH, wstETH, rETH) | 66 | USDS/DAI (partial wstETH) |
| Alt-L1 LSTs / Bridged assets | 33 | HYUSD (Solana LSTs), meUSD (tBTC) |
| Exotic/opaque strategies | 0 | USDe (delta-neutral) |

For mixed collateral (e.g. USDS: 40% RWA, 30% USDC, 20% ETH LSTs), use the tier that best represents the dominant non-stablecoin collateral. Stablecoin collateral (USDC, USDT) is captured by the dependency risk dimension, not here.

#### 3. Custody Model (25%)

Score based on where collateral is held and who controls it.

| Tier | Score | Examples |
|---|---|---|
| Fully on-chain / self-custodied | 100 | LUSD, BOLD, DAI, HYUSD, meUSD |
| Institutional custodian + PoR | 50 | USDC (BNY Mellon), USDT (Cantor) |
| Off-exchange / CEX custody | 0 | USDe (Copper/Ceffu + Binance/Bybit) |

#### 4. Blacklist Capability (25%)

Retained from the current system.

| Tier | Score |
|---|---|
| Not blacklistable | 100 |
| Blacklistable | 0 |

### Dimension Weights

Resilience increases from 10% to 15%, taken from dependency risk (30%→25%). All other weights unchanged.

| Dimension | Old | New |
|---|---|---|
| Peg Stability | 25% | **25%** |
| Liquidity | 25% | **25%** |
| Resilience | 10% | **15%** |
| Decentralization | 10% | **10%** |
| Dependency Risk | 30% | **25%** |

### Data Model

Add three new optional enum fields to `StablecoinMeta` (in `src/lib/types.ts` and `src/lib/stablecoins.ts`):

```typescript
type ChainRisk = "ethereum" | "stage1-l2" | "established-alt-l1" | "unproven";
type CollateralQuality = "native" | "eth-lst" | "alt-lst-bridged" | "exotic";
type CustodyModel = "onchain" | "institutional" | "cex";
```

Fields are **optional** — when not set, the scoring function infers defaults from existing metadata:

#### Default Inference Rules

| Backing + Governance | `chainRisk` | `collateralQuality` | `custodyModel` |
|---|---|---|---|
| `rwa-backed` + `centralized` | `ethereum` | `native` | `institutional` |
| `crypto-backed` + `decentralized` | `ethereum` | `native` | `onchain` |
| `crypto-backed` + `centralized-dependent` | `ethereum` | `eth-lst` | `onchain` |
| `algorithmic` + any | `ethereum` | `native` | `onchain` |

These defaults are conservative and correct for the majority of coins (USDC, USDT, LUSD, BOLD, etc.). Only coins where reality diverges from the default need explicit overrides — estimated ~20 out of 141.

#### Known Overrides (non-exhaustive)

| Coin | `chainRisk` | `collateralQuality` | `custodyModel` |
|---|---|---|---|
| HYUSD | `established-alt-l1` | `alt-lst-bridged` | — |
| USDe | — | `exotic` | `cex` |
| meUSD | `unproven` | `alt-lst-bridged` | — |
| USDD | — | `alt-lst-bridged` | — |
| sUSD (Synthetix) | — | `exotic` | — |
| USDJ | `unproven` | `alt-lst-bridged` | — |

("—" = default is correct, no override needed)

### Data Population: `resilience-classify` Skill

A new Claude Code skill (`.claude/skills/resilience-classify/SKILL.md`) to research and classify coins that need overrides. Modeled on the existing `stablecoin-info-fetch` skill.

#### When to invoke

- After the types and defaults are implemented (step 2 of implementation)
- Run once in batch to identify and apply all needed overrides
- Run per-coin when a new stablecoin is added to the tracker

#### Process

**Step 1 — Identify candidates**: Read all coins from `src/lib/stablecoins.ts`. For each, apply the default inference rules. Flag coins where the default is likely wrong based on:
- `collateral` text containing keywords: "Solana", "tBTC", "WBTC", "delta-neutral", "perpetual", "CEX", "off-exchange", "Copper", "Ceffu", "Fireblocks"
- `pegMechanism` text containing: "Solana", "Bitcoin L2", "not Ethereum"
- `contracts[]` listing only non-Ethereum chains
- `backing` = `crypto-backed` but collateral text mentions RWAs, bridges, or exotic strategies

**Step 2 — Research each candidate**: For each flagged coin, in parallel:
- `WebFetch` official docs for collateral composition, custody arrangement, and chain architecture
- `WebSearch` for `"{coin name}" stablecoin collateral custody chain` to find independent analysis
- Cross-reference with existing `collateral` and `pegMechanism` text fields

**Step 3 — Classify**: For each coin, determine the correct tier for each sub-factor:

| Sub-factor | Question to answer | Sources |
|---|---|---|
| `chainRisk` | Where does the core protocol live and where is collateral held? | contracts[], docs, pegMechanism text |
| `collateralQuality` | What are the trust assumptions in the backing assets? | collateral text, official docs |
| `custodyModel` | Who holds the collateral and can it be verified on-chain? | collateral text, pegMechanism text, official docs |

**Step 4 — Present findings**: For each coin needing an override:

```
## {Name} ({Symbol}) — ID: {id}

### Default inference
- chainRisk: {inferred} — {correct/wrong because...}
- collateralQuality: {inferred} — {correct/wrong because...}
- custodyModel: {inferred} — {correct/wrong because...}

### Proposed overrides
- {field}: {value} — {justification with source URL}

### No override needed
- {fields where default is correct}
```

**Step 5 — Apply**: After user approval, edit `src/lib/stablecoins.ts` to add only the override fields that differ from defaults. Run `npm run build` to verify.

#### Classification Guidelines

- **chainRisk**: Based on where the protocol's smart contracts and collateral vaults live, NOT where the token is bridged to. A coin minted on Ethereum but bridged to Solana is still `ethereum`.
- **collateralQuality**: For mixed collateral, use the tier of the **riskiest significant component** (>15% of backing). USDS has ETH LSTs + RWAs — the LSTs are the riskiest crypto component, so `eth-lst`. Stablecoin portions (USDC, USDT in the backing) don't count here — they're handled by dependency risk.
- **custodyModel**: If ANY significant portion of collateral is held off-chain by a non-institutional custodian (CEX, market maker), classify as `cex`. Institutional means regulated custodians (BNY Mellon, State Street, etc.) with proof of reserves.
- When uncertain between two tiers, choose the **riskier** (lower score) tier. Be conservative.

### Impact on Example Coins

| Coin | Chain | Collateral | Custody | Blacklist | Resilience | Overall (old→new) |
|---|---|---|---|---|---|---|
| BOLD | 100 | 100 | 100 | 100 | **100** | 89→**89** (0) |
| LUSD | 100 | 100 | 100 | 100 | **100** | 80→**80** (0) |
| HYUSD | 33 | 33 | 100 | 100 | **66** | 85→**80** (-5) |
| USDe | 100 | 0 | 0 | 100 | **50** | 84→**78** (-6) |
| USDS | 100 | 66 | 100 | 100 | **92** | 86→**86** (0) |
| meUSD | 0 | 33 | 100 | 100 | **58** | 81→**75** (-6) |
| USDC | 100 | 100 | 50 | 0 | **63** | 80→**85** (+5) |
| USDT | 100 | 100 | 50 | 0 | **63** | 79→**83** (+4) |
| DAI | 100 | 66 | 100 | 100 | **92** | 81→**81** (0) |

### Implementation Scope

1. **Types**: Add `ChainRisk`, `CollateralQuality`, `CustodyModel` types to `src/lib/types.ts`
2. **Scoring**: Rewrite `scoreResilience()` in `src/lib/report-cards.ts` — 4-factor model with default inference from backing+governance when fields are not set
3. **Worker**: Update `worker/src/api/report-cards.ts` to pass `StablecoinMeta` to `scoreResilience()`
4. **Weights**: Update `DIMENSION_WEIGHTS` from `{res: 0.10, dep: 0.30}` to `{res: 0.15, dep: 0.25}`
5. **Skill**: Create `.claude/skills/resilience-classify/SKILL.md`
6. **Overrides**: Run `resilience-classify` skill to identify and apply ~20 overrides in `src/lib/stablecoins.ts`
7. **UI**: Update resilience detail display in report card component to show sub-factor breakdown
8. **Docs**: Update `docs/report-cards.md`
