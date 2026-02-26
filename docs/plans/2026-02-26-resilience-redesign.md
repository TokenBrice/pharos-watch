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

Add three new enum fields to `StablecoinMeta` (in `src/lib/types.ts` and `src/lib/stablecoins.ts`):

```typescript
type ChainRisk = "ethereum" | "stage1-l2" | "established-alt-l1" | "unproven";
type CollateralQuality = "native" | "eth-lst" | "alt-lst-bridged" | "exotic";
type CustodyModel = "onchain" | "institutional" | "cex";
```

These go in `StablecoinOpts` and propagate to `StablecoinMeta`. Defaults when not set:
- `chainRisk`: infer from `contracts[]` — if only Ethereum, default `"ethereum"`; otherwise require explicit
- `collateralQuality`: no default, require explicit for all coins
- `custodyModel`: default `"onchain"` for decentralized/centralized-dependent, `"institutional"` for centralized

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
2. **Metadata**: Add fields to `StablecoinOpts` in `src/lib/stablecoins.ts`, classify all ~141 coins
3. **Scoring**: Rewrite `scoreResilience()` in `src/lib/report-cards.ts` to use 4-factor model
4. **Worker**: Update `worker/src/api/report-cards.ts` to pass new fields to `scoreResilience()`
5. **Weights**: Update `DIMENSION_WEIGHTS` from `{res: 0.10, dep: 0.30}` to `{res: 0.15, dep: 0.25}`
6. **UI**: Update resilience detail display in report card component to show sub-factor breakdown
7. **Docs**: Update `docs/report-cards.md`
