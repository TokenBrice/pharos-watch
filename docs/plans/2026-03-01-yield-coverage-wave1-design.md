# Yield Coverage Expansion — Wave 1: Native Yield Coins

**Date:** 2026-03-01
**Status:** Approved

## Goal

Extend the yield intelligence pipeline from 14 to 22 coins by adding 8 stablecoins rated C+ or above that have protocol-native savings/staking mechanisms.

## Coins

| Coin | ID | Wrapper | yieldType | yieldSource | DL Pool UUID |
|------|----|---------|-----------|-------------|--------------|
| USDS | 209 | sUSDS | governance-set | Sky Savings Rate (sUSDS) | d8c4eff5-c8a9-46fc-a888-057c4c668e72 |
| GHO | 118 | sGHO | governance-set | Aave Safety Module (sGHO) | ff2a68af-030c-4697-b0a1-b62a738eaef0 |
| DAI | 5 | sDAI | governance-set | Dai Savings Rate (sDAI) | 13392973-be6e-4b2f-bce9-4f7dd53d1c3a |
| crvUSD | 110 | scrvUSD | nav-appreciation | Curve Savings (scrvUSD) | 5fd328af-4203-471b-bd16-1705c726d926 |
| FRXUSD | 235 | sfrxUSD | nav-appreciation | Frax Staking (sfrxUSD) | 42523cca-14b0-44f6-95fb-4781069520a5 |
| DOLA | 15 | sDOLA | nav-appreciation | Inverse Finance Savings (sDOLA) | bf0f95c9-bc46-467d-9762-1d80ff50cd74 |
| BOLD | 269 | yBOLD | lending-vault | Stability Pool (via Yearn yBOLD) | 4c29f645-12db-461f-a1d7-16900d624271 |
| ZCHF | 226 | *(none)* | governance-set | Frankencoin Savings | 8b427366-7bfb-4c61-88be-8dc004fdc3da |

### Classification rationale

- **navToken = false** for all 8 — the base tokens still peg to $1.
- **governance-set**: USDS, GHO, DAI, ZCHF — rates determined by protocol governance.
- **nav-appreciation**: crvUSD, FRXUSD, DOLA — ERC-4626 wrapper whose price rises as yield accrues.
- **lending-vault**: BOLD — Yearn vault depositing into Liquity Stability Pool.

## Changes

### `src/lib/stablecoins.ts`

Add `yieldBearing: true` and `yieldConfig` to 8 existing coin definitions. No structural changes.

### `worker/src/cron/yield-config.ts`

- `YIELD_VARIANT_MAP`: 7 new entries (USDS→sUSDS, GHO→sGHO, DAI→sDAI, crvUSD→scrvUSD, FRXUSD→sfrxUSD, DOLA→sDOLA, BOLD→yBOLD). ZCHF has no wrapper.
- `YIELD_POOL_MAP`: 8 new DL pool UUIDs.

### `docs/yield-intelligence.md`

Update tracked coin count and add the 8 new entries.

## What does NOT change

- No new types or type changes
- No DB schema changes
- No sync logic changes (pipeline already iterates all `yieldBearing` coins)
- No API changes
- No frontend changes
- No new Tier 1 (on-chain) configs

## Risk

- Zero marginal API cost (DL Yields is a single bulk fetch).
- ~140K additional rows/year in yield_history (well within D1 limits).
- All 8 coins already rated C+ or above, so PYS benefits from lower risk penalties.
