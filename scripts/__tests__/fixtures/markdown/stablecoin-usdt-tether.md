---
title: "Tether (USDT) Stablecoin Analytics"
canonical: "https://pharos.watch/stablecoin/usdt-tether/"
description: "Build-time stablecoin profile for Tether (USDT). Live price, supply, peg, liquidity, and flow data are served by the Pharos API."
dateModified: "2026-05-18"
---



# Tether (USDT)

**Peg:** US Dollar

**Backing:** Real-World Asset Backed

**Governance:** Centralized (CeFi)

**Status:** active

## Overview

USDT remains the largest dollar stablecoin, with Tether's Q1 2026 attestation showing $191.77B of assets against $183.54B of liabilities. The reserve stack is still Treasury-heavy, with about $141B in direct and indirect U.S. T-bill exposure, plus material gold and Bitcoin positions. The core risk is issuer concentration, discretionary redemption access, and reliance on Tether's quarterly attestation model.

## Collateral

Q1 2026 attestation: $191.77B total assets vs $183.54B liabilities; about $141B direct/indirect U.S. Treasury bill exposure, $20B physical gold, $7B Bitcoin, and an $8.23B excess reserve buffer.

## Peg Mechanism

Direct 1:1 redemption through Tether. Supply figures include USDT0 (omnichain variant via LayerZero lock-and-mint) deployed on 20+ additional chains

## Jurisdiction

| Country | Regulator | License |
| --- | --- | --- |
| El Salvador | CNAD | Digital Asset Issuance / DASP |

## Contracts

| Chain | Address | Decimals |
| --- | --- | --- |
| ethereum | `0xdac17f958d2ee523a2206206994597c13d831ec7` | 6 |
| tron | `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` | 6 |
| arbitrum | `0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9` | 6 |
| optimism | `0x94b008aa00579c1307b0ef2c499ad98a8ce58e58` | 6 |
| polygon | `0xc2132d05d31c914a87c6611c10748aeb04b58e8f` | 6 |
| avalanche | `0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7` | 6 |
| bsc | `0x55d398326f99059ff775485246999027b3197955` | 18 |
| celo | `0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e` | 6 |
| solana | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` | 6 |
| ton | `EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs` | 6 |
| near | `usdt.tether-token.near` | 6 |
| aptos | `0x357b0b74bc833e95a115ad22604854d6b0fca151cecd94111770e5d6ffc9dc2b` | 6 |
| klaytn | `0xd077a400968890eacc75cdc901f0356c943e4fdb` | 6 |
| kava | `0x919c1c267bc06a7039e03fcc2ef738525769109c` | 6 |
| sui | `0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT` | 6 |
| polkadot | `1984` | 6 |
| tezos | `KT1XnTn74bUtxHfDtBmm2bGZAQfhPbvKWR8o` | 6 |
| injective | `peggy0xdAC17F958D2ee523a2206206994597C13D831ec7` | 6 |
| scroll | `0xf55bec9cafdbe8730f096aa55dad6d22d44099df` | 6 |
| fantom | `0x049d68029688eabf473097a2fc38ef61633a3c7a` | 6 |
| mantle | `0x779ded0c9e1022225f8e0630b35a9b54be713736` | 6 |
| ink | `0x0200c29006150606b650577bbe7b6248f58470c1` | 6 |
| berachain | `0x779ded0c9e1022225f8e0630b35a9b54be713736` | 6 |
| unichain | `0x9151434b16b9763660705744891fa906f660ecc5` | 6 |
| hyperevm | `0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb` | 6 |
| monad | `0xe7cd86e13ac4309349f30b3435a9d337750fc82d` | 6 |
| xlayer | `0x779ded0c9e1022225f8e0630b35a9b54be713736` | 6 |
| flare | `0xe7cd86e13ac4309349f30b3435a9d337750fc82d` | 6 |
| corn | `0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb` | 6 |
| megaeth | `0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb` | 6 |
| plasma | `0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb` | 6 |
| katana | `0x2dca96907fde857dd3d816880a0df407eeb2d2f2` | 6 |
| stable | `0x779ded0c9e1022225f8e0630b35a9b54be713736` | 6 |
| hyperliquid | `0x25faedc3f054130dbb4e4203aca63567` | 8 |

## Live Data

Real-time price, supply, peg score, liquidity, and flow data live at https://api.pharos.watch/api/stablecoin/usdt-tether.
