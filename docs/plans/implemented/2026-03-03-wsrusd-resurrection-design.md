# wsrUSD Resurrection Design

**Date:** 2026-03-03
**Status:** Approved

## Context

rUSD (Reservoir Stablecoin, DL ID 217) was in the cemetery after supply collapsed from $88M to <$700K in late 2025. The protocol is alive — activity consolidated onto **wsrUSD** (Wrapped Savings rUSD), the ERC-4626 NAV-appreciating vault token. rUSD remains dead and stays in the cemetery. We are not resurrecting rUSD; we are adding wsrUSD as a new tracked coin.

## Decision

Track **wsrUSD** as a NAV token. Do **not** track rUSD or srUSD as separate entries.

## Token Profile

| Field | Value |
|-------|-------|
| Pharos ID | `"cg-wrapped-savings-rusd"` (not in DL stablecoins) |
| CoinGecko ID | `wrapped-savings-rusd` |
| Symbol | `wsrUSD` |
| Name | `Wrapped Savings rUSD` |
| Ethereum contract | `0xd3fd63209fa2d55b07a0f6db36c2f43900be3094` |
| Standard | ERC-4626 |
| Decimals | 18 |
| Price | ~$1.048 (NAV-appreciating from $1.00) |
| Market cap | ~$96M |
| Backing | Multi-asset RWA + digital assets (via rUSD/srUSD stack) |
| Governance | `"centralized-dependent"` — permissionless protocol but collateral depends on centralized custodians/issuers |
| yieldBearing | `true` |
| navToken | `true` |
| yieldType | `"nav-appreciation"` |
| yieldSource | `"Reservoir savings vault (srUSD)"` |

## Classification

- `backing`: `"rwa-backed"` (multi-asset RWA collateral under rUSD)
- `governance`: `"centralized-dependent"` (permissionless contracts, but backing relies on centralized assets)
- `collateralQuality`: TBD during research (likely `"rwa"` or `"alt-lst-bridged-or-mixed"`)
- `custodyModel`: TBD during research (likely `"institutional"`)
- `governanceQuality`: TBD during research

## Yield Pipeline

wsrUSD is itself the yield-bearing token — no `YIELD_VARIANT_MAP` entry needed. APY resolves via:
- **Tier 2**: DL yields pool if DeFiLlama has a wsrUSD pool
- **Tier 3**: Price-derived APY from CoinGecko price history (primary path initially)

## Cemetery Change

Remove the `"Reservoir rUSD"` / `"rUSD"` entry from `src/lib/dead-stablecoins.ts`. rUSD the token remains dead; the cemetery entry exists to document collapsed stablecoins, and the protocol has moved on to wsrUSD.

## Implementation Phases

1. **Research** — `stablecoin-info-fetch` skill: collateral details, peg mechanism, jurisdiction, all chain contracts, proof of reserves
2. **stablecoins.ts entry** — `usd("cg-wrapped-savings-rusd", ...)` with all fields from research
3. **Logo** — fetch from CoinGecko (`wrapped-savings-rusd`)
4. **Contract populate** — `contract-populate` skill for multi-chain addresses
5. **AI summary** — `write-ai-summaries` skill
6. **Supply backfill** — `POST /api/backfill-cg-prices?stablecoin=cg-wrapped-savings-rusd`
7. **Cemetery removal** — delete rUSD entry from `dead-stablecoins.ts`
8. **Verify & push** — `npm run build`, `npm test`, then push

## Out of Scope

- Tracking rUSD or srUSD as separate entries
- Adding `YIELD_VARIANT_MAP` entries
- Tracking wsrUSD on chains not yet in `src/lib/chains.ts`
