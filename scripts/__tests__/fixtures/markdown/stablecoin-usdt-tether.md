---
title: "Tether (USDT) Stablecoin Analytics"
canonical: "https://pharos.watch/stablecoin/usdt-tether/"
description: "Build-time stablecoin profile for Tether (USDT). Live price, supply, peg, liquidity, and flow data are served by the Pharos API."
dateModified: "2026-10-19"
---



# Tether (USDT)

**Peg:** US Dollar

**Backing:** Real-World Asset Backed

**Governance:** Centralized (CeFi)

**Status:** active

## Overview

USDT held Safety Score A (83/100) as of 2026-10-22 in Pharos's scores-latest release dataset. The current Safety Score and live assessment are available on the interactive page.

## Collateral

Q2 2026 attestation: $187.75B total assets vs $183.64B liabilities; about $140.6B in U.S. Treasury bills and reverse repurchase agreements, $18.8B precious metals, $5.8B Bitcoin, $13.5B secured loans, and a $4.11B excess reserve buffer.

## Peg Mechanism

Direct redemption through Tether for verified customers at $1 less applicable fees, subject to Tether's terms. Supply figures include USDT0 (omnichain variant via LayerZero lock-and-mint) deployed on 20+ additional chains

## Jurisdiction

| Country | Regulator | License |
| --- | --- | --- |
| El Salvador | CNAD | Digital Asset Issuance / DASP |

## Quick answers

### What is Tether (USDT)?

USDT (Tether) is the largest dollar stablecoin, mostly backed by short-term U.S. Treasuries with a centralized issuer and quarterly attestations. The static profile records its US Dollar peg mechanism as: Direct redemption through Tether for verified customers at $1 less applicable fees, subject to Tether's terms. Supply figures include USDT0 (omnichain variant via LayerZero lock-and-mint) deployed on 20+ additional chains.

### Is USDT safe?

As of Oct 22, 2026, Pharos grades USDT A (83/100) on its Safety Score. Pharos's reviews record that the issuer or an admin can freeze individual holders' balances, and direct redemption is limited to customers the issuer has verified. That grade is in the Score's upper band, which does not rule out losses. The grade moves as reserve, redemption, peg and control evidence changes; the live Safety Score on this page shows the current reading.

### What backs USDT?

Pharos records USDT's reserves as of Jun 30, 2026 as 61.2% U.S. Treasury bills, 10% Precious metals, 9.9% Overnight reverse repurchase agreements, and 8 smaller holdings. Reserve evidence: Independent Attestation by BDO Italia, latest period ending Jun 30, 2026. Pharos classifies the backing as Real-World Asset Backed.

### Can USDT be frozen or blacklisted?

Based on tracked contract metadata and blacklist coverage, issuer or admin freeze controls are recorded. Live freeze and blacklist events for USDT, when applicable, appear in the live dossier on this page.

### How do you redeem USDT?

Under the route Pharos reviewed on Apr 16, 2026, customers the issuer has verified can redeem USDT for a single stable asset, such as cash or a stablecoin, with a $100,000 minimum. Settlement takes multiple days. The reviewed redemption fee is at most 0.1%. Whether a given holder qualifies is set by the route's own terms, not by this summary.

## Sources

### Reserve sources

- [BDO ISAE 3000R report at 2026-06-30, signed 2026-07-31; report page 4 / PDF page 9, footnotes 3-13 reverified 2026-10-02 UTC](<https://assets.ctfassets.net/vyse88cgwfbl/2kYf7r64h3tzwiu6F0CbUB/2997abd2f11ecea74a21528048b50707/Opinion___Report_-_Tether_International_Financial_Figure_30-06-2026.pdf>)
- [Tether latest-report index and presentation, inspected 2026-09-27](<https://tether.to/en/transparency/?tab=reports>)
- [Tether live transparency balance endpoint (separate balance-sheet observation, not composition)](<https://app.tether.to/transparency.json>)
- [BDO ISAE 3000R report at 2026-03-31, signed 2026-04-30 (prior-quarter equity comparison), reviewed 2026-10-19](<https://assets.ctfassets.net/vyse88cgwfbl/6crn1tXbl6AtWZBWucZnfg/c4ff472d70c1b48c2f689f27b54c84f5/ISAE_3000R_-_Opinion_Tether_International_Financial_Figure_31-03-2026.pdf>)
- [Tether Q2 2026 reports and reserves](<https://tether.to/transparency/?tab=reports>)
- [Reserve source](<https://tether.to/en/transparency>)

### Redemption sources

- [Tether Transparency](<https://tether.to/en/transparency>)
- [Tether legal terms](<https://tether.to/en/legal/>)
- [Tether fees](<https://tether.to/en/fees/>)

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
| gnosis | `0x4ECaBa5870353805a9F068101A40E0f32ed605C6` | 6 |
| pulsechain | `0x0Cb6F5a34ad42ec934882A05265A7d5F59b51A2f` | 6 |
| moonriver | `0xB44a9B6905aF7c801311e8F4E76932ee959c663C` | 6 |
| xdc | `0xd4b5f10d61916bd6e0860144a91ac658de8a1437` | 6 |
| taiko | `0x2DEF195713CF4a606B49D07E520e22C17899a736` | 6 |
| flow | `0x674843C06FF83502ddb4D37c2E09C01cdA38cbc8` | 6 |
| sei | `0x9151434b16b9763660705744891fa906f660ecc5` | 6 |
| linea | `0xA219439258ca9da29E9Cc4cE5596924745e12B93` | 6 |
| zksync | `0x493257fD37EDB34451f62EDf8D2a0C418852bA4C` | 6 |
| mode | `0xf0F161fDA2712DB8b566946122a5af183995e2eD` | 6 |
| manta | `0xf417F5A458eC102B90352F697D6e2Ac3A3d2851f` | 6 |
| boba | `0x5DE1677344D3Cb0D7D465c10b72A8f60699C062d` | 6 |
| conflux | `0xaf37E8B6C9ED7f6318979f56Fc287d76c30847ff` | 6 |
| morph-l2 | `0xe7cd86e13AC4309349F30B3435a9d337750fC82D` | 6 |
| tempo | `0x20C00000000000000000000014f22CA97301EB73` | 6 |
| rootstock | `0x779dED0C9e1022225F8e0630b35A9B54Be713736` | 6 |
| hedera | `0x00000000000000000000000000000000009Ce723` | 6 |

## Public snapshots

Public release snapshots (2026-10-22); each file records its own source dates and coverage.

- [Top stablecoins](https://pharos.watch/datasets/top-stablecoins/2026-10-22.json)
- [Safety Scores](https://pharos.watch/datasets/scores-latest/2026-10-22.json)
- [Depeg history](https://pharos.watch/datasets/depeg-history/2026-10-22.json)

These bounded datasets can omit this asset and do not replace authenticated live analytics. See [API access](https://pharos.watch/api/) and [API reference](https://pharos.watch/api/reference/).
