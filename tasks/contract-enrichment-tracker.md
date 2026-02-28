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

- **Total gaps identified:** 88 across 34 coins
- **Contracts added:** 78
- **Skipped:** 10 (unmapped/deprecated/unverified)
- **New CHAIN_META entries:** 18 (15 EVM + 3 non-EVM)
- **New chain logos:** 17
- **Data snapshot:** 2026-02-28
- **Completion date:** 2026-02-28

## Coins

### USDT — Tether (id: 1, geckoId: tether)

**Gaps: 21 | Added: 17 | Skipped: 4**

| Status | DL Chain | Internal Chain | Supply | Notes |
|--------|----------|---------------|--------|-------|
| done | Plasma | plasma | $1310.0M | USDT0 via LayerZero |
| done | Mantle | mantle | $713.1M | USDT0 |
| done | Ink | ink | $210.1M | USDT0 |
| done | Hyperliquid L1 | hyperevm | $155.8M | USDT0 |
| done | Monad | monad | $97.2M | USDT0 |
| done | Fantom | fantom | $83.0M | fUSDT (bridged) |
| skipped | Omni | — | $80.1M | Legacy frozen chain |
| done | X Layer | xlayer | $50.0M | USDT0 |
| done | Flare | flare | $49.1M | USDT0 |
| done | Berachain | berachain | $45.2M | USDT0 |
| done | Tezos | tezos | $42.3M | Native FA2 token |
| done | MegaETH | megaeth | $38.6M | USDT0 |
| done | Polkadot | polkadot | $37.0M | Asset Hub (ID: 1984) |
| done | Unichain | unichain | $34.0M | USDT0 |
| skipped | Mixin | — | $31.9M | Non-standard network |
| skipped | Stable | — | $25.5M | Insufficient research |
| done | Sui | sui | $22.1M | |
| done | Injective | injective | $16.0M | Peggy bridge |
| skipped | Katana | — | $12.3M | vbUSDT IOU, not native |
| done | Corn | corn | $11.8M | USDT0 |
| done | Scroll | scroll | $10.5M | |

### USDC — USD Coin (id: 2, geckoId: usd-coin)

**Gaps: 16 | Added: 16 | Skipped: 0**

| Status | DL Chain | Internal Chain | Supply | Notes |
|--------|----------|---------------|--------|-------|
| done | BSC | bsc | $1280.4M | Binance-Peg, 18 decimals |
| done | Stellar | stellar | $219.1M | 7 decimals (Stellar standard) |
| done | Fantom | fantom | $181.5M | Depegged ~$0.02 (Multichain exploit) |
| done | Cronos | cronos | $179.4M | |
| done | Noble | noble | $167.9M | Cosmos native (uusdc) |
| done | Mantle | mantle | $55.8M | |
| done | Linea | linea | $35.0M | |
| done | Scroll | scroll | $30.9M | |
| done | Katana | katana | $29.3M | vbUSDC |
| done | Osmosis | osmosis | $27.2M | IBC transfer |
| done | Stacks | stacks | $25.0M | USDCx (SIP-010) |
| done | Etherlink | etherlink | $18.8M | |
| done | Cardano | cardano | $17.4M | Policy ID format |
| done | PulseChain | pulsechain | $14.5M | |
| done | Abstract | abstract | $11.5M | |
| done | Berachain | berachain | $11.3M | |

### YLDS — YLDS (id: 272, geckoId: ylds)

**Gaps: 2 | Added: 2 | Skipped: 0**

| Status | DL Chain | Internal Chain | Supply | Notes |
|--------|----------|---------------|--------|-------|
| done | Solana | solana | $341.6M | |
| done | Provenance | provenance | $246.7M | uylds.fcc denom |

### RLUSD — Ripple USD (id: 250, geckoId: ripple-usd)

**Gaps: 1 | Added: 1 | Skipped: 0**

| Status | DL Chain | Internal Chain | Supply | Notes |
|--------|----------|---------------|--------|-------|
| done | XRPL | xrpl | $256.3M | Trust line format |

### USDS — Sky Dollar (id: 209, geckoId: usds)

**Gaps: 2 | Added: 2 | Skipped: 0**

| Status | DL Chain | Internal Chain | Supply | Notes |
|--------|----------|---------------|--------|-------|
| done | OP Mainnet | optimism | $100.3M | |
| done | Unichain | unichain | $100.0M | |

### AUSD — Agora Dollar (id: 205, geckoId: agora-dollar)

**Gaps: 6 | Added: 6 | Skipped: 0**

| Status | DL Chain | Internal Chain | Supply | Notes |
|--------|----------|---------------|--------|-------|
| done | Monad | monad | $47.2M | CREATE2 same address |
| done | Solana | solana | $33.8M | |
| done | Katana | katana | $9.3M | CREATE2 same address |
| done | Immutable zkEVM | immutable-zkevm | $8.7M | CREATE2 same address |
| done | Sui | sui | $7.8M | |
| done | Mantle | mantle | $5.2M | CREATE2 same address |

### TBILL — OpenEden TBILL (id: 257, geckoId: openeden-tbill)

**Gaps: 1 | Added: 0 | Skipped: 1**

| Status | DL Chain | Internal Chain | Supply | Notes |
|--------|----------|---------------|--------|-------|
| skipped | XRPL | xrpl | $61.9M | Currency code unclear |

### USDA — Avalon USDa (id: 220, geckoId: usda-2)

**Gaps: 5 | Added: 4 | Skipped: 1**

| Status | DL Chain | Internal Chain | Supply | Notes |
|--------|----------|---------------|--------|-------|
| done | Movement | movement | $36.6M | |
| skipped | Cardano | cardano | $8.8M | DL misattribution (Anzens USDA) |
| done | Kaia | klaytn | $7.5M | |
| done | Berachain | berachain | $2.7M | |
| done | Nibiru | nibiru | $2.4M | |

### USDTB — Ethena USDtb (id: 221, geckoId: usdtb)

**Gaps: 1 | Added: 0 | Skipped: 1**

| Status | DL Chain | Internal Chain | Supply | Notes |
|--------|----------|---------------|--------|-------|
| skipped | Solana | solana | $55.1M | Decimals unverified |

### USDX — Hex Trust USDX (id: 263, geckoId: hex-trust-usdx)

**Gaps: 2 | Added: 2 | Skipped: 0**

| Status | DL Chain | Internal Chain | Supply | Notes |
|--------|----------|---------------|--------|-------|
| done | Flare | flare | $42.2M | |
| done | Songbird | songbird | $1.2M | |

### M — M by M0 (id: 213, geckoId: m)

**Gaps: 3 | Added: 2 | Skipped: 1**

| Status | DL Chain | Internal Chain | Supply | Notes |
|--------|----------|---------------|--------|-------|
| skipped | Noble | noble | $25.2M | Wrong denom (uusdn = USDN) |
| done | Solana | solana | $15.5M | |
| done | Hyperliquid L1 | hyperevm | $1.4M | |

### BRZ — Brazilian Digital (id: 249, geckoId: brz)

**Gaps: 1 | Added: 1 | Skipped: 0**

| Status | DL Chain | Internal Chain | Supply | Notes |
|--------|----------|---------------|--------|-------|
| done | Solana | solana | $38.6M | 4 decimals |

### DAI — Dai (id: 5, geckoId: dai)

**Gaps: 5 | Added: 4 | Skipped: 1**

| Status | DL Chain | Internal Chain | Supply | Notes |
|--------|----------|---------------|--------|-------|
| done | PulseChain | pulsechain | $14.4M | |
| done | Kaia | klaytn | $8.2M | |
| done | Kava | kava | $1.9M | |
| skipped | zkSync Lite | — | $1.7M | Chain deprecated |
| done | Near | near | $1.1M | Rainbow bridge |

### USDN — Noble Dollar (id: 282, geckoId: noble-dollar-usdn)

**Gaps: 1 | Added: 1 | Skipped: 0**

| Status | DL Chain | Internal Chain | Supply | Notes |
|--------|----------|---------------|--------|-------|
| done | Noble | noble | $25.2M | uusdn denom |

### HYUSD — Hylo HYUSD (id: 302, geckoId: hylo-usd)

**Gaps: 1 | Added: 1 | Skipped: 0**

| Status | DL Chain | Internal Chain | Supply | Notes |
|--------|----------|---------------|--------|-------|
| done | Solana | solana | $17.0M | |

### meUSD — Mezo USD (id: 303, geckoId: mezo-usd)

**Gaps: 1 | Added: 1 | Skipped: 0**

| Status | DL Chain | Internal Chain | Supply | Notes |
|--------|----------|---------------|--------|-------|
| done | Mezo | mezo | $16.4M | CREATE2 same address |

### FRAX — Frax (id: 6, geckoId: frax)

**Gaps: 1 | Added: 1 | Skipped: 0**

| Status | DL Chain | Internal Chain | Supply | Notes |
|--------|----------|---------------|--------|-------|
| done | Fraxtal | fraxtal | $15.6M | WFRAX wrapper (native gas token) |

### USDM — Moneta (id: 215, geckoId: usdm-2)

**Gaps: 1 | Added: 1 | Skipped: 0**

| Status | DL Chain | Internal Chain | Supply | Notes |
|--------|----------|---------------|--------|-------|
| done | Cardano | cardano | $14.5M | |

### PYUSD — PayPal USD (id: 120, geckoId: paypal-usd)

**Gaps: 1 | Added: 1 | Skipped: 0**

| Status | DL Chain | Internal Chain | Supply | Notes |
|--------|----------|---------------|--------|-------|
| done | Flow | flow | $10.0M | |

### TRYB — BiLira (id: 300, geckoId: bilira)

**Gaps: 1 | Added: 1 | Skipped: 0**

| Status | DL Chain | Internal Chain | Supply | Notes |
|--------|----------|---------------|--------|-------|
| done | Plasma | plasma | $6.3M | |

### USBD — Bima USBD (id: 253, geckoId: usbd)

**Gaps: 1 | Added: 1 | Skipped: 0**

| Status | DL Chain | Internal Chain | Supply | Notes |
|--------|----------|---------------|--------|-------|
| done | Hemi | hemi | $5.4M | CREATE2 same address |

### AUDD — AUDD (id: 165, geckoId: novatti-australian-digital-dollar)

**Gaps: 1 | Added: 1 | Skipped: 0**

| Status | DL Chain | Internal Chain | Supply | Notes |
|--------|----------|---------------|--------|-------|
| done | Stellar | stellar | $5.2M | 7 decimals (Stellar standard) |

### satUSD — River Stablecoin (id: 218, geckoId: satoshi-stablecoin)

**Gaps: 1 | Added: 1 | Skipped: 0**

| Status | DL Chain | Internal Chain | Supply | Notes |
|--------|----------|---------------|--------|-------|
| done | Bsquared | bsquared | $4.9M | |

### USD1 — World Liberty Financial USD (id: 262, geckoId: usd1-wlfi)

**Gaps: 1 | Added: 1 | Skipped: 0**

| Status | DL Chain | Internal Chain | Supply | Notes |
|--------|----------|---------------|--------|-------|
| done | Abcore | abcore | $3.2M | AB Chain |

### MIM — Magic Internet Money (id: 10, geckoId: magic-internet-money)

**Gaps: 2 | Added: 2 | Skipped: 0**

| Status | DL Chain | Internal Chain | Supply | Notes |
|--------|----------|---------------|--------|-------|
| done | Kava | kava | $1.8M | |
| done | Blast | blast | $1.2M | |

### BtcUSD — Bitcoin USD (id: 183, geckoId: bitcoin-usd-btcfi)

**Gaps: 1 | Added: 1 | Skipped: 0**

| Status | DL Chain | Internal Chain | Supply | Notes |
|--------|----------|---------------|--------|-------|
| done | Bifrost Network | bifrost | $2.9M | |

### EUROP — Schuman EUROP (id: 247, geckoId: schuman-europ)

**Gaps: 1 | Added: 1 | Skipped: 0**

| Status | DL Chain | Internal Chain | Supply | Notes |
|--------|----------|---------------|--------|-------|
| done | Plasma | plasma | $2.6M | |

### ISC — International Stable Currency (id: 186, geckoId: international-stable-currency)

**Gaps: 1 | Added: 1 | Skipped: 0**

| Status | DL Chain | Internal Chain | Supply | Notes |
|--------|----------|---------------|--------|-------|
| done | Solana | solana | $2.5M | |

### ZeUSD — Zoth ZeUSD (id: 225, geckoId: zeusd)

**Gaps: 1 | Added: 1 | Skipped: 0**

| Status | DL Chain | Internal Chain | Supply | Notes |
|--------|----------|---------------|--------|-------|
| done | Manta | manta | $2.0M | CREATE2 same address |

### VCHF — VNX Swiss Franc (id: 157, geckoId: vnx-swiss-franc)

**Gaps: 1 | Added: 1 | Skipped: 0**

| Status | DL Chain | Internal Chain | Supply | Notes |
|--------|----------|---------------|--------|-------|
| done | Solana | solana | $1.8M | 9 decimals |

### USDP — Pax Dollar (id: 11, geckoId: paxos-standard)

**Gaps: 1 | Added: 1 | Skipped: 0**

| Status | DL Chain | Internal Chain | Supply | Notes |
|--------|----------|---------------|--------|-------|
| done | BSC | bsc | $1.4M | |

### USN — Noon USN (id: 230, geckoId: noon-usn)

**Gaps: 1 | Added: 1 | Skipped: 0**

| Status | DL Chain | Internal Chain | Supply | Notes |
|--------|----------|---------------|--------|-------|
| done | Sophon | sophon | $1.2M | |

### EURS — Stasis Euro (id: 51, geckoId: stasis-eurs)

**Gaps: 1 | Added: 1 | Skipped: 0**

| Status | DL Chain | Internal Chain | Supply | Notes |
|--------|----------|---------------|--------|-------|
| done | Stellar | stellar | $1.2M | 7 decimals (Stellar standard) |

### ZCHF — Frankencoin (id: 226, geckoId: frankencoin)

**Gaps: 1 | Added: 1 | Skipped: 0**

| Status | DL Chain | Internal Chain | Supply | Notes |
|--------|----------|---------------|--------|-------|
| done | Base | base | $1.2M | |

## Skipped Items

| Coin | Chain | Supply | Reason |
|------|-------|--------|--------|
| USDT | Omni | $80.1M | Legacy frozen chain |
| USDTB | Solana | $55.1M | Decimals unverified |
| USDT | Mixin | $31.9M | Non-standard network |
| USDT | Stable | $25.5M | Insufficient research |
| M | Noble | $25.2M | Wrong denom returned (uusdn = USDN, not M) |
| USDT | Katana | $12.3M | vbUSDT IOU, not native USDT |
| USDA | Cardano | $8.8M | DL misattribution (Anzens USDA, not Avalon) |
| TBILL | XRPL | $61.9M | Currency code unclear |
| DAI | zkSync Lite | $1.7M | Chain deprecated |
