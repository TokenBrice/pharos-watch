# Deployment Model Classification — Batch Handover

**Date:** 2026-02-28
**Status:** In progress — 18/69 classified, 51 remaining

## What Was Done

Replaced single `chainRisk: ChainRisk` with two-axis model: `chainTier: ChainTier` × `deploymentModel: DeploymentModel`. See `docs/plans/2026-02-28-multichain-risk-design.md` for full design.

### Implementation (complete)

- Types: `ChainTier` + `DeploymentModel` in `src/lib/types.ts`
- Scoring: `chainInfraScore()` = `CHAIN_TIER_SCORE[tier] × DEPLOYMENT_MULT[model]` in `src/lib/report-cards.ts`
- Multipliers: single-chain=1.0, canonical-bridge=0.85, third-party-bridge=0.60, native-multichain=0.40
- Decentralization penalty: threshold-based on combined score (≥80→0, ≥50→-15, ≥15→-50, <15→-65)
- Docs: `docs/report-cards.md`, `docs/api-reference.md`, `.claude/skills/resilience-classify/SKILL.md` all updated
- All deployed and verified in production at pharos.watch

### Classification (batch 1 complete, batch 2+ needed)

18 coins classified so far:

| Symbol | ID | deploymentModel | Reasoning |
|--------|-----|----------------|-----------|
| USDC | 2 | native-multichain | Circle mints natively on 30+ chains |
| USDT | 1 | native-multichain | Tether mints natively on 12+ chains |
| FDUSD | 119 | native-multichain | First Digital mints natively per chain |
| EURC | 50 | native-multichain | Circle mints EURC natively per chain |
| DAI | 5 | canonical-bridge | MakerDAO canonical L2 rollup bridges |
| LUSD | 8 | canonical-bridge | Liquity v1 canonical L2 rollup bridges |
| BOLD | 269 | third-party-bridge | Chainlink CCIP |
| USDe | 146 | third-party-bridge | LayerZero OFT |
| USDS | 209 | third-party-bridge | Wormhole NTT / LayerZero for Solana |
| GHO | 118 | third-party-bridge | Chainlink CCIP |
| crvUSD | 110 | third-party-bridge | LayerZero OFT |
| FRAX | 6 | third-party-bridge | LayerZero OFT |
| DOLA | 15 | third-party-bridge | Chainlink CCIP |
| MIM | 10 | third-party-bridge | LayerZero OFT |
| PYUSD | 120 | third-party-bridge | LayerZero OFT for expansion chains |
| USDTB | 221 | third-party-bridge | LayerZero OFT |
| rwaUSDi | 340 | native-multichain | Independent minting on multiple chains |
| satUSD | 218 | third-party-bridge | LayerZero OFT |

## What Remains: 51 Coins

Listed by chain count descending. Each needs research to determine `deploymentModel`.

### High priority (5+ chains, likely need overrides)

```
FRXUSD   id=235  chains=20  rwa-backed       centralized-dependent
USDY     id=129  chains=9   rwa-backed       centralized
USD1     id=262  chains=8   rwa-backed       centralized
BUIDL    id=173  chains=8   rwa-backed       centralized
SBC      id=324  chains=8   rwa-backed       centralized
TUSD     id=7    chains=7   rwa-backed       centralized
EURA     id=55   chains=7   crypto-backed    centralized-dependent
USDD     id=14   chains=6   crypto-backed    centralized-dependent
USR      id=197  chains=6   crypto-backed    centralized-dependent
AUSD     id=205  chains=6   rwa-backed       centralized
reUSD    id=339  chains=6   crypto-backed    centralized-dependent
VEUR     id=158  chains=6   rwa-backed       centralized
EURAU    id=319  chains=5   rwa-backed       centralized
DEURO    id=cg   chains=5   crypto-backed    decentralized
```

### Medium priority (3-4 chains)

```
USDf     id=246  chains=4   crypto-backed    centralized-dependent
M        id=213  chains=4   rwa-backed       centralized
USD0     id=195  chains=4   rwa-backed       centralized-dependent
EURCV    id=254  chains=4   rwa-backed       centralized
USDQ     id=275  chains=4   rwa-backed       centralized
SUSD     id=22   chains=4   crypto-backed    centralized-dependent
ALUSD    id=20   chains=4   crypto-backed    decentralized
EUROP    id=247  chains=4   rwa-backed       centralized
USDG     id=286  chains=3   rwa-backed       centralized
USDai    id=309  chains=3   rwa-backed       centralized-dependent
USDA     id=220  chains=3   crypto-backed    centralized-dependent
USDz     id=202  chains=3   rwa-backed       centralized
TBILL    id=257  chains=3   rwa-backed       centralized
USDO     id=241  chains=3   rwa-backed       centralized
YUSD     id=255  chains=3   crypto-backed    centralized
EUSD     id=106  chains=3   crypto-backed    centralized-dependent
MSUSD    id=326  chains=3   crypto-backed    centralized-dependent
syrupUSDC id=cg  chains=3   rwa-backed       centralized-dependent
```

### Lower priority (2 chains)

```
USYC     id=237  AEUR   id=147  EURI   id=325  GUSD    id=19
USDP     id=11   XUSD   id=290  MUSD   id=313  USDCV   id=307
EURE     id=101  GYD    id=185  EURS   id=51   cUSD    id=24
pUSD     id=266  WUSD   id=234  USBD   id=253  U       id=336
DUSD     id=252  avUSD  id=271  USDU   id=283
```

## How To Classify Remaining Coins

Use the `resilience-classify` skill or research manually. The decision tree:

```
Can the protocol mint/redeem on >1 chain independently?
  YES → native-multichain
  NO → Is the token on >1 chain?
    NO → single-chain (no override needed)
    YES → Does cross-chain transfer use the L2's canonical rollup bridge?
      YES → canonical-bridge
      NO → third-party-bridge (CCIP, LayerZero, Wormhole, etc.)
```

### Batch workflow

1. Pick 15 coins (diversified by type/governance)
2. Research each with `WebSearch "{coin name} cross-chain bridge multichain"`
3. Classify per decision tree
4. Add `deploymentModel: "xxx"` to each coin in `src/lib/stablecoins.ts`
5. Run `npm run build && cd worker && npx tsc --noEmit`
6. Commit and push

### Key patterns observed from batch 1

- **Centralized RWA issuers** (Circle, Tether, First Digital): usually `native-multichain` — they mint independently on each chain
- **DeFi protocols** (Curve, Aave, Abracadabra): usually `third-party-bridge` — they mint on Ethereum and use LayerZero/CCIP
- **Legacy DeFi** (MakerDAO, Liquity v1): usually `canonical-bridge` — they use official L2 rollup bridges
- **Newer protocols** with LayerZero/CCIP in their collateral/mechanism text: `third-party-bridge`
- **2-chain coins**: many may be `single-chain` if the second chain presence is just organic bridging

### Edge cases to watch for

- **PYUSD-style hybrids**: native on 2 chains + LayerZero for rest → classify as `third-party-bridge` (worst bridge determines risk)
- **USDS-style mixed**: canonical for L2s + Wormhole for Solana → `third-party-bridge`
- **Defunct bridges**: some coins may still have Multichain/Anyswap remnants but no active cross-chain — verify if bridged supply is live
