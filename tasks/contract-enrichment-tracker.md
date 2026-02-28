# Contract Enrichment Tracker

> Persistent tracking file for the /contract-enrich skill.
> Updated as gaps are populated. Survives context resets.

## Context

**Goal:** Enrich stablecoin contract address data using DefiLlama chain coverage as discovery layer.

**Process per coin:**
1. DL reports chains where supply > threshold ($10M for USDT/USDC, $1M for others)
2. Compare with our existing contracts in `src/lib/stablecoins.ts`
3. For each gap: look up address via CoinGecko `detail_platforms`, verify on block explorer, write to file
4. If CG doesn't have the address: manually research using block explorer, project docs, etc.

**Key finding:** CoinGecko's `detail_platforms` is incomplete for many stablecoins (USDT: 11 platforms, DAI: 1, FRAX/USDS/PYUSD: 0). Many gaps will need manual address sourcing.

**Files modified:**
- `src/lib/stablecoins.ts` — contract entries
- `src/lib/chains.ts` — CHAIN_META for new chains

**Skills:**
- `/contract-enrich` — the main skill (DL discovery + CG population)
- `/contract-populate` — existing per-coin CG-only skill (fallback)

## Summary

- **Total gaps:** 88 across 34 coins
- **Mapped (actionable):** 77
- **Unmapped DL chains:** 11 (need DL_CHAIN_MAP update first)
- **Total untracked supply:** $7.0B
- **Data snapshot:** 2026-02-28

## Status Legend

- `todo` — gap identified, not yet addressed
- `in-progress` — currently being populated
- `done` — address found, verified, written to stablecoins.ts
- `skipped-cg-missing` — CG doesn't have this platform, needs manual research
- `skipped-unmapped` — DL chain name not in our DL_CHAIN_MAP
- `skipped-manual` — needs manual research (CG has no data)

## Coins

### USDT — Tether (id: 1, geckoId: tether)

**Gaps: 21 | Total untracked: $3075M**

| Status | DL Chain | Internal Chain | Supply | Address | Notes |
|--------|----------|---------------|--------|---------|-------|
| todo | Plasma | plasma | $1310.0M | | |
| todo | Mantle | mantle | $713.1M | | |
| todo | Ink | ink | $210.1M | | |
| todo | Hyperliquid L1 | hyperevm | $155.8M | | |
| todo | Monad | monad | $97.2M | | |
| todo | Fantom | fantom | $83.0M | | |
| skipped-unmapped | Omni | UNMAPPED:Omni | $80.1M | | |
| todo | X Layer | xlayer | $50.0M | | |
| todo | Flare | flare | $49.1M | | |
| todo | Berachain | berachain | $45.2M | | |
| todo | Tezos | tezos | $42.3M | | |
| todo | MegaETH | megaeth | $38.6M | | |
| todo | Polkadot | polkadot | $37.0M | | |
| todo | Unichain | unichain | $34.0M | | |
| skipped-unmapped | Mixin | UNMAPPED:Mixin | $31.9M | | |
| skipped-unmapped | Stable | UNMAPPED:Stable | $25.5M | | |
| todo | Sui | sui | $22.1M | | |
| todo | Injective | injective | $16.0M | | |
| skipped-unmapped | Katana | UNMAPPED:Katana | $12.3M | | |
| todo | Corn | corn | $11.8M | | |
| todo | Scroll | scroll | $10.5M | | |

### USDC — USD Coin (id: 2, geckoId: usd-coin)

**Gaps: 16 | Total untracked: $2305M**

| Status | DL Chain | Internal Chain | Supply | Address | Notes |
|--------|----------|---------------|--------|---------|-------|
| todo | BSC | bsc | $1280.4M | | |
| todo | Stellar | stellar | $219.1M | | |
| todo | Fantom | fantom | $181.5M | | |
| todo | Cronos | cronos | $179.4M | | |
| todo | Noble | noble | $167.9M | | |
| todo | Mantle | mantle | $55.8M | | |
| todo | Linea | linea | $35.0M | | |
| todo | Scroll | scroll | $30.9M | | |
| skipped-unmapped | Katana | UNMAPPED:Katana | $29.3M | | |
| todo | Osmosis | osmosis | $27.2M | | |
| todo | Stacks | stacks | $25.0M | | |
| todo | Etherlink | etherlink | $18.8M | | |
| todo | Cardano | cardano | $17.4M | | |
| todo | PulseChain | pulsechain | $14.5M | | |
| todo | Abstract | abstract | $11.5M | | |
| todo | Berachain | berachain | $11.3M | | |

### YLDS — YLDS (id: 272, geckoId: ylds)

**Gaps: 2 | Total untracked: $588M**

| Status | DL Chain | Internal Chain | Supply | Address | Notes |
|--------|----------|---------------|--------|---------|-------|
| todo | Solana | solana | $341.6M | | |
| todo | Provenance | provenance | $246.7M | | |

### RLUSD — Ripple USD (id: 250, geckoId: ripple-usd)

**Gaps: 1 | Total untracked: $256M**

| Status | DL Chain | Internal Chain | Supply | Address | Notes |
|--------|----------|---------------|--------|---------|-------|
| todo | XRPL | xrpl | $256.3M | | |

### USDS — Sky Dollar (id: 209, geckoId: usds)

**Gaps: 2 | Total untracked: $200M**

| Status | DL Chain | Internal Chain | Supply | Address | Notes |
|--------|----------|---------------|--------|---------|-------|
| todo | OP Mainnet | optimism | $100.3M | | |
| todo | Unichain | unichain | $100.0M | | |

### AUSD — Agora Dollar (id: 205, geckoId: agora-dollar)

**Gaps: 6 | Total untracked: $112M**

| Status | DL Chain | Internal Chain | Supply | Address | Notes |
|--------|----------|---------------|--------|---------|-------|
| todo | Monad | monad | $47.2M | | |
| todo | Solana | solana | $33.8M | | |
| skipped-unmapped | Katana | UNMAPPED:Katana | $9.3M | | |
| todo | Immutable zkEVM | immutable-zkevm | $8.7M | | |
| todo | Sui | sui | $7.8M | | |
| todo | Mantle | mantle | $5.2M | | |

### TBILL — OpenEden TBILL (id: 257, geckoId: openeden-tbill)

**Gaps: 1 | Total untracked: $62M**

| Status | DL Chain | Internal Chain | Supply | Address | Notes |
|--------|----------|---------------|--------|---------|-------|
| todo | XRPL | xrpl | $61.9M | | |

### USDA — Avalon USDa (id: 220, geckoId: usda-2)

**Gaps: 5 | Total untracked: $58M**

| Status | DL Chain | Internal Chain | Supply | Address | Notes |
|--------|----------|---------------|--------|---------|-------|
| todo | Movement | movement | $36.6M | | |
| todo | Cardano | cardano | $8.8M | | |
| todo | Kaia | klaytn | $7.5M | | |
| todo | Berachain | berachain | $2.7M | | |
| skipped-unmapped | Nibiru | UNMAPPED:Nibiru | $2.4M | | |

### USDTB — Ethena USDtb (id: 221, geckoId: usdtb)

**Gaps: 1 | Total untracked: $55M**

| Status | DL Chain | Internal Chain | Supply | Address | Notes |
|--------|----------|---------------|--------|---------|-------|
| todo | Solana | solana | $55.1M | | |

### USDX — Hex Trust USDX (id: 263, geckoId: hex-trust-usdx)

**Gaps: 2 | Total untracked: $43M**

| Status | DL Chain | Internal Chain | Supply | Address | Notes |
|--------|----------|---------------|--------|---------|-------|
| todo | Flare | flare | $42.2M | | |
| todo | Songbird | songbird | $1.2M | | |

### M — M by M0 (id: 213, geckoId: m)

**Gaps: 3 | Total untracked: $42M**

| Status | DL Chain | Internal Chain | Supply | Address | Notes |
|--------|----------|---------------|--------|---------|-------|
| todo | Noble | noble | $25.2M | | |
| todo | Solana | solana | $15.5M | | |
| todo | Hyperliquid L1 | hyperevm | $1.4M | | |

### BRZ — Brazilian Digital (id: 249, geckoId: brz)

**Gaps: 1 | Total untracked: $39M**

| Status | DL Chain | Internal Chain | Supply | Address | Notes |
|--------|----------|---------------|--------|---------|-------|
| todo | Solana | solana | $38.6M | | |

### DAI — Dai (id: 5, geckoId: dai)

**Gaps: 5 | Total untracked: $27M**

| Status | DL Chain | Internal Chain | Supply | Address | Notes |
|--------|----------|---------------|--------|---------|-------|
| todo | PulseChain | pulsechain | $14.4M | | |
| todo | Kaia | klaytn | $8.2M | | |
| todo | Kava | kava | $1.9M | | |
| skipped-unmapped | zkSync Lite | UNMAPPED:zkSync Lite | $1.7M | | |
| todo | Near | near | $1.1M | | |

### USDN — Noble Dollar (id: 282, geckoId: noble-dollar-usdn)

**Gaps: 1 | Total untracked: $25M**

| Status | DL Chain | Internal Chain | Supply | Address | Notes |
|--------|----------|---------------|--------|---------|-------|
| todo | Noble | noble | $25.2M | | |

### HYUSD — Hylo HYUSD (id: 302, geckoId: hylo-usd)

**Gaps: 1 | Total untracked: $17M**

| Status | DL Chain | Internal Chain | Supply | Address | Notes |
|--------|----------|---------------|--------|---------|-------|
| todo | Solana | solana | $17.0M | | |

### meUSD — Mezo USD (id: 303, geckoId: mezo-usd)

**Gaps: 1 | Total untracked: $16M**

| Status | DL Chain | Internal Chain | Supply | Address | Notes |
|--------|----------|---------------|--------|---------|-------|
| todo | Mezo | mezo | $16.4M | | |

### FRAX — Frax (id: 6, geckoId: frax)

**Gaps: 1 | Total untracked: $16M**

| Status | DL Chain | Internal Chain | Supply | Address | Notes |
|--------|----------|---------------|--------|---------|-------|
| todo | Fraxtal | fraxtal | $15.6M | | |

### USDM — Moneta (id: 215, geckoId: usdm-2)

**Gaps: 1 | Total untracked: $15M**

| Status | DL Chain | Internal Chain | Supply | Address | Notes |
|--------|----------|---------------|--------|---------|-------|
| todo | Cardano | cardano | $14.5M | | |

### PYUSD — PayPal USD (id: 120, geckoId: paypal-usd)

**Gaps: 1 | Total untracked: $10M**

| Status | DL Chain | Internal Chain | Supply | Address | Notes |
|--------|----------|---------------|--------|---------|-------|
| todo | Flow | flow | $10.0M | | |

### TRYB — BiLira (id: 300, geckoId: bilira)

**Gaps: 1 | Total untracked: $6M**

| Status | DL Chain | Internal Chain | Supply | Address | Notes |
|--------|----------|---------------|--------|---------|-------|
| todo | Plasma | plasma | $6.3M | | |

### USBD — Bima USBD (id: 253, geckoId: usbd)

**Gaps: 1 | Total untracked: $5M**

| Status | DL Chain | Internal Chain | Supply | Address | Notes |
|--------|----------|---------------|--------|---------|-------|
| todo | Hemi | hemi | $5.4M | | |

### AUDD — AUDD (id: 165, geckoId: novatti-australian-digital-dollar)

**Gaps: 1 | Total untracked: $5M**

| Status | DL Chain | Internal Chain | Supply | Address | Notes |
|--------|----------|---------------|--------|---------|-------|
| todo | Stellar | stellar | $5.2M | | |

### satUSD — River Stablecoin (id: 218, geckoId: satoshi-stablecoin)

**Gaps: 1 | Total untracked: $5M**

| Status | DL Chain | Internal Chain | Supply | Address | Notes |
|--------|----------|---------------|--------|---------|-------|
| skipped-unmapped | Bsquared | UNMAPPED:Bsquared | $4.9M | | |

### USD1 — World Liberty Financial USD (id: 262, geckoId: usd1-wlfi)

**Gaps: 1 | Total untracked: $3M**

| Status | DL Chain | Internal Chain | Supply | Address | Notes |
|--------|----------|---------------|--------|---------|-------|
| skipped-unmapped | Abcore | UNMAPPED:Abcore | $3.2M | | |

### MIM — Magic Internet Money (id: 10, geckoId: magic-internet-money)

**Gaps: 2 | Total untracked: $3M**

| Status | DL Chain | Internal Chain | Supply | Address | Notes |
|--------|----------|---------------|--------|---------|-------|
| todo | Kava | kava | $1.8M | | |
| todo | Blast | blast | $1.2M | | |

### BtcUSD — Bitcoin USD (id: 183, geckoId: bitcoin-usd-btcfi)

**Gaps: 1 | Total untracked: $3M**

| Status | DL Chain | Internal Chain | Supply | Address | Notes |
|--------|----------|---------------|--------|---------|-------|
| skipped-unmapped | Bifrost Network | UNMAPPED:Bifrost Network | $2.9M | | |

### EUROP — Schuman EUROP (id: 247, geckoId: schuman-europ)

**Gaps: 1 | Total untracked: $3M**

| Status | DL Chain | Internal Chain | Supply | Address | Notes |
|--------|----------|---------------|--------|---------|-------|
| todo | Plasma | plasma | $2.6M | | |

### ISC — International Stable Currency (id: 186, geckoId: international-stable-currency)

**Gaps: 1 | Total untracked: $3M**

| Status | DL Chain | Internal Chain | Supply | Address | Notes |
|--------|----------|---------------|--------|---------|-------|
| todo | Solana | solana | $2.5M | | |

### ZeUSD — Zoth ZeUSD (id: 225, geckoId: zeusd)

**Gaps: 1 | Total untracked: $2M**

| Status | DL Chain | Internal Chain | Supply | Address | Notes |
|--------|----------|---------------|--------|---------|-------|
| todo | Manta | manta | $2.0M | | |

### VCHF — VNX Swiss Franc (id: 157, geckoId: vnx-swiss-franc)

**Gaps: 1 | Total untracked: $2M**

| Status | DL Chain | Internal Chain | Supply | Address | Notes |
|--------|----------|---------------|--------|---------|-------|
| todo | Solana | solana | $1.8M | | |

### USDP — Pax Dollar (id: 11, geckoId: paxos-standard)

**Gaps: 1 | Total untracked: $1M**

| Status | DL Chain | Internal Chain | Supply | Address | Notes |
|--------|----------|---------------|--------|---------|-------|
| todo | BSC | bsc | $1.4M | | |

### USN — Noon USN (id: 230, geckoId: noon-usn)

**Gaps: 1 | Total untracked: $1M**

| Status | DL Chain | Internal Chain | Supply | Address | Notes |
|--------|----------|---------------|--------|---------|-------|
| todo | Sophon | sophon | $1.2M | | |

### EURS — Stasis Euro (id: 51, geckoId: stasis-eurs)

**Gaps: 1 | Total untracked: $1M**

| Status | DL Chain | Internal Chain | Supply | Address | Notes |
|--------|----------|---------------|--------|---------|-------|
| todo | Stellar | stellar | $1.2M | | |

### ZCHF — Frankencoin (id: 226, geckoId: frankencoin)

**Gaps: 1 | Total untracked: $1M**

| Status | DL Chain | Internal Chain | Supply | Address | Notes |
|--------|----------|---------------|--------|---------|-------|
| todo | Base | base | $1.2M | | |

## Unmapped DL Chains

These DL chain names need to be added to the DL_CHAIN_MAP in `.claude/skills/contract-enrich/SKILL.md` before they can be processed.

| DL Chain | Coins Affected | Max Supply |
|----------|---------------|------------|
| Abcore | USD1 | $3.2M |
| Bifrost Network | BtcUSD | $2.9M |
| Bsquared | satUSD | $4.9M |
| Katana | AUSD, USDC, USDT | $29.3M |
| Mixin | USDT | $31.9M |
| Nibiru | USDA | $2.4M |
| Omni | USDT | $80.1M |
| Stable | USDT | $25.5M |
| zkSync Lite | DAI | $1.7M |

