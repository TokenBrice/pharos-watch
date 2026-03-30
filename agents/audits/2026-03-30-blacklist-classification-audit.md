# Blacklist Classification Audit — 2026-03-30

## Problem Statement

44 stablecoins are reported as non-blacklistable when many should be "Upstream" (inherited). The system under-reports blacklist risk.

## Root Causes

### 1. Transitive inheritance is broken (logic bug)

`blacklistableIds` in `worker/src/lib/report-cards-snapshot.ts` is built with only **first-order** coins:

```typescript
const blacklistableIds: ReadonlySet<string> = new Set(
  ACTIVE_STABLECOINS
    .filter((meta) => isBlacklistable(meta) === true)  // ← strict equality, only first-order
    .map((meta) => meta.id),
);
```

This means `coinId` links to coins like DAI, USDe, crvUSD, USDS, frxUSD — which are themselves "upstream"-blacklistable — have **zero effect**. The system can only see one level deep.

**Example chain**: USDC (Yes) → USDe (should be Upstream) → DOLA (should be Upstream) — but DOLA shows "No" because USDe is not in the lookup set.

### 2. Reserve data staleness

Several coins have outdated curated reserves that don't match live data:

| Coin | Curated | Live |
|------|---------|------|
| DOLA | wstETH 35%, sUSDe 15%, cbBTC 12%... | 96.6% stablecoin collateral (sUSDe, sUSDS, crvUSD) |
| GHO | sDAI 18%, GSMs 13% | stataUSDC GSM 25.5%, stataUSDT GSM 10.8%, residual 63.7% |

## Coins That Should Flip to "Upstream" (from initial audit)

### Status-changing (9 coins, pre-transitive-fix)

1. **FRAX** — USTB slice (50%) missing `coinId: "ustb-superstate"`
2. **USDB** — DAI slice coinId doesn't resolve (not first-order)
3. **GYD** — sDAI + crvUSD coinIds don't resolve
4. **dUSD** — Zero annotations on any slice
5. **FPI** — FRAX coinId doesn't resolve
6. **rwaUSDi** — Stablecoins slice unannotated
7. **reUSD** — crvUSD + frxUSD coinIds don't resolve
8. **USDp** — sfrxUSD + sUSDe coinIds don't resolve
9. **eBUSD** — sUSDe + XAUt0 unannotated

### Additional coins likely to flip after transitive fix + data updates

- DOLA, GHO, and others with >50% transitive centralized exposure

## Proposed Fix: Transitive Inheritance

Make `blacklistableIds` iterative: process coins in topological order, and after each coin is evaluated, if it's blacklistable (true OR inherited), add it to the set so downstream coins can see it. This eliminates the need for per-slice `blacklistable: true` overrides on most coins.

## Tier 2: Accuracy annotations (non-status-changing)

| Coin | Slice | Fix |
|------|-------|-----|
| frxUSD | Superstate USTB | Add `coinId: "ustb-superstate"` |
| alUSD | DAI slice | Add `blacklistable: true` |
| msUSD | DAI + FRAX slices | Add `blacklistable: true` |
| GHO | sDAI slice | Add `blacklistable: true` |
| DOLA | sFRAX slice | Add `blacklistable: true` |
| USDf (Falcon) | USTB slice | Add `coinId: "ustb-superstate"` |
| dEURO | DAI slice | Add `blacklistable: true` |
