# Live Reserve Coverage Expansion — Comprehensive Research

**Date:** 2026-03-14
**Current state:** 28 live-enabled stablecoins / 156 tracked (18% coverage)
**Goal:** Identify all feasible candidates and prioritize by impact + feasibility

---

## Executive Summary

This research surveyed all 128 stablecoins without live reserve adapters. We found:

- **21 HIGH-feasibility candidates** — structured APIs, on-chain oracles, or reusable adapter patterns
- **~18 MEDIUM-feasibility candidates** — scrapable dashboards, undocumented APIs, or complex on-chain reads
- **~89 LOW/NONE** — PDF-only attestations, non-EVM chains, or no public data

If all HIGH candidates are implemented, coverage rises from **28 → 49 coins (31%)**.
Including MEDIUM brings it to **~67 coins (43%)**.

### New Adapter Types Needed

Two new generic adapters would unlock large batches of coins:

1. **`chainlink-por`** — reads Chainlink AggregatorV3Interface `latestRoundData()` for total reserves. Serves: EURS, PAXG, TUSD, USD1, XAUT (pending), AUSD (Chaos Labs variant).
2. **`chainlink-nav`** — reads NAV oracles (Chainlink-compatible) + token `totalSupply()`. Serves: USYC (also has HTTP API), OUSG, USDY, mTBILL, USTB.

Plus several coins can reuse existing adapters with config-only additions.

---

## Tier 1 — HIGH Feasibility (Build These)

Sorted by impact (market cap / user traffic) then effort.

### 1.1 Top-10 Stablecoins

| # | Coin | Symbol | Backing | Best Data Source | Adapter Type | Effort |
|---|------|--------|---------|-----------------|-------------|--------|
| 1 | **Tether** | USDT | RWA | `https://app.tether.to/transparency.json` — JSON API, no auth. Returns total assets/liabilities + per-chain supply. **No asset-class breakdown** (T-bills/cash/gold split is PDF-only quarterly). | `http-json` (new `tether` adapter) | Small |
| 2 | **Aave GHO** | GHO | Crypto | `GhoToken.getFacilitatorsList()` + `getFacilitatorBucket()` at `0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f`. GSM USDC: `0xFeeb...9535`, GSM USDT: `0x535b...6B7B`. | `onchain-evm` (new `gho` adapter) | Medium |
| 3 | **USD0 (Usual)** | USD0 | RWA | Treasury `0xdd82875f0840AAD58a455A70B88eEd9F59ceC7c7` holds USYC, UsualM, UsualUSDtb. ERC-20 balance reads + DefiLlama pricing. | `evm-branch-balances` | Small |
| 4 | **World Liberty USD1** | USD1 | RWA | Chainlink oracle at `0x691b74146cdba162449012aa32d3cbf5df77d4c4`. `latestBundle()` with 18 decimals. Real-time. Also has PoR dashboard at `por.worldlibertyfinancial.com`. | `chainlink-por` (new) | Small |
| 5 | **Hashnote USYC** | USYC | RWA | **Public JSON API** at `https://usyc.hashnote.com/api/price` — returns `{roundId, price, nextPrice, timestamp}`. Also on-chain oracle at `0x74f2199AEb743f68f05943e5715A33EaF2b61f53`. | `http-json` or `chainlink-nav` | Small |
| 6 | **Frax FRXUSD** | FRXUSD | RWA | JSON API at `https://api.frax.finance/combineddata/` — collateral ratio + protocol treasury breakdown. Also Chaos Labs PoR (behind Cloudflare). On-chain custodian contracts for BUIDL/USTB/USCC/etc. | `http-json` (new `frax` adapter) | Medium |
| 7 | **TrueUSD** | TUSD | RWA | Chainlink PoR at `0xBE456fd14720C3aCCc30A2013Bffd782c9Cb75D5`. Updated every 24h or 5% deviation. Total reserves only. | `chainlink-por` (new) | Small |

### 1.2 RWA / Tokenized Yield Tokens

| # | Coin | Symbol | Best Data Source | Adapter Type | Effort |
|---|------|--------|-----------------|-------------|--------|
| 8 | **Ondo USDY** | USDY | NAV oracle at `0xA0219AA5B31e65Bc920B5b6DFb8EdF0988121De0` (`RWADynamicOracle.getPrice()`). Daily updates. | `chainlink-nav` (new) | Small |
| 9 | **Ondo OUSG** | OUSG | NAV oracle at `0x9Cad45a8BF0Ed41Ff33074449B357C7a1fAb4094`. Same interface as USDY. | `chainlink-nav` (new) | Small |
| 10 | **Midas mTBILL** | mTBILL | Ankura Trust oracle at `0x056339C044055819E8Db84E71f5f2E1F536b2E5b`. Chainlink AggregatorV3 compatible. Daily updates. | `chainlink-nav` (new) | Small |
| 11 | **Superstate USTB** | USTB | Custom continuous oracle at `0xe4fa682f94610ccd170680cc3b045d77d9e528a8` OR Chainlink feed at `0x289B5036cd942e619E1Ee48670F98d214E745AAC`. 24/7 pricing. | `chainlink-nav` (new) | Small |
| 12 | **BlackRock BUIDL** | BUIDL | NAV fixed at $1/token. On-chain `totalSupply()` at `0x7712c34205737192402172409a8f7ccef8aa2aec` gives AUM. Single-asset: 100% U.S. Treasuries. | `single-asset` (existing) | Minimal |
| 13 | **OpenEden TBILL** | TBILL | Test `https://prod-gw.openeden.com/tbill/sys/reserve-composition-last` (following USDO pattern). If it works, reuse/generalize `openeden-usdo` adapter. | `http-json` (existing pattern) | Small |

### 1.3 Crypto-Backed DeFi

| # | Coin | Symbol | Best Data Source | Adapter Type | Effort |
|---|------|--------|-----------------|-------------|--------|
| 14 | **Origin OUSD** | OUSD | **Documented JSON API** at `https://api.originprotocol.com/api/v2/ousd/collateral`. Per-asset collateral breakdown. No auth. | `http-json` (new `ousd` adapter) | Small |
| 15 | **Blast USDB** | USDB | 100% backed by sDAI. Read sDAI balance at Blast L1 bridge contract on Ethereum. | `single-asset` (existing) | Minimal |
| 16 | **Lybra eUSD** | eUSD | Contract `0x97de57ec338ab5d51557da3434828c5dbfada371` exposes `totalDepositedEther` + `totalEUSDCirculation`. Single-chain. | `onchain-evm` (new `lybra` adapter) | Small |
| 17 | **Reserve HYUSD** | HYUSD | `FacadeRead.primeBasket()` returns basket composition. Standard Reserve Protocol interface. Reusable for any RToken. | `onchain-evm` (new `reserve-protocol` adapter) | Medium |

### 1.4 Existing Adapter Reuse (Config-Only)

| # | Coin | Symbol | Existing Adapter | Notes |
|---|------|--------|-----------------|-------|
| 18 | **XSY UTY** | UTY | `accountable` | Uses Accountable platform. Dashboard at `accountable.xsy.fi`. Just add config entry. |
| 19 | **Stasis EURS** | EURS | `chainlink-por` (new) | Chainlink PoR feed "EURR Reserves" at `0x652A...Ac2d` (ENS: `eurr-reserves.data.eth`). 10-min updates. |
| 20 | **Paxos Gold PAXG** | PAXG | `chainlink-por` (new) | Confirmed active Chainlink PoR feed. Token: `0x45804880De22913dAFE09f4980848ECE6EcbAf78`. |
| 21 | **Ethena USDtb** | USDtb | `evm-branch-balances` (existing) | ~90% BUIDL + ~10% USDC at treasury addresses. Requires address discovery. |

---

## Tier 2 — MEDIUM Feasibility (Worth Pursuing)

| # | Coin | Symbol | Backing | Data Source | Challenge |
|---|------|--------|---------|-------------|-----------|
| 1 | **Circle USDC** | USDC | RWA | `circle.com/transparency` HTML page. Weekly reserve disclosure with asset-class + dollar amounts. | HTML scraping (no JSON API). JS-rendered Chart.js — need to reverse-engineer internal JSON endpoints or scrape. |
| 2 | **Circle EURC** | EURC | RWA | Same page as USDC. EUR reserve breakdown with amounts. | Same scraping challenge as USDC. Could share adapter. |
| 3 | **First Digital FDUSD** | FDUSD | RWA | `firstdigitallabs.com/transparency` HTML. Reserve breakdown by asset class with percentages. | HTML scraping. Monthly update cadence. |
| 4 | **Ripple RLUSD** | RLUSD | RWA | `ripple.com/.../transparency/` HTML. Total circulation + reserves. | Headline numbers only on page; detail in PDFs. |
| 5 | **Gemini GUSD** | GUSD | RWA | `gemini.com/trust-center` HTML. CUSIP-level Treasury data. | Detailed but HTML-only. Monthly updates. |
| 6 | **Agora AUSD** | AUSD | RWA | Chaos Labs PoR oracle (on-chain). Total NAV vs supply. | Need to find specific oracle contract address. |
| 7 | **Sky DAI/USDS** | DAI/USDS | Crypto | Block Analitica API (powers `info.skyeco.com/collateral`) or on-chain Vat.ilks multicall at `0x35D1b3F3D7966A1DFe207aa4514C12a259A0492B`. | No documented public API. Need reverse-engineering or complex multi-ilk on-chain reads. Highest-value MEDIUM target. |
| 8 | **Inverse DOLA** | DOLA | Crypto | Transparency portal at `inverse.finance/transparency/dola`. Updates every few minutes. | Need to discover backend JSON API. |
| 9 | **Abracadabra MIM** | MIM | Crypto | Per-cauldron on-chain data: `totalCollateralShare()`, `collateral()`. Documented at `dev.abracadabra.money`. | Multi-chain (ETH, ARB, FTM, AVAX). Many cauldrons. |
| 10 | **Synthetix sUSD** | sUSD | Crypto | V3 Core vault contracts. `@synthetixio/queries` library. | Complex V3 architecture, transitional state. |
| 11 | **Lista lisUSD** | lisUSD | Crypto | MakerDAO-fork Vat on BNB Chain. | BSC RPC needed. |
| 12 | **BeraBorrow NECT** | NECT | Crypto | Multi-collateral Dens on Berachain (EVM-compatible). | Need contract addresses + Berachain RPC. |
| 13 | **Gyroscope GYD** | GYD | Crypto | Reserve vault contracts on Ethereum. `github.com/gyrostable/gyd-core`. | Small protocol, needs address discovery. |
| 14 | **SG Forge EURCV** | EURCV | RWA | `sgforge.com/product/coinvertible/` HTML. Daily circulating supply. 100% cash. | HTML scraping, similar to `mento` adapter. |
| 15 | **Alchemix alUSD** | alUSD | Crypto | Alchemist.sol contracts on Ethereum. Per-vault collateral reads. | Well-documented contracts but complex yield strategies. |
| 16 | **Resupply REUSD** | REUSD | Crypto | On-chain CDP (Convex + Yearn). Curve Lend/Fraxlend vault tokens. | CDP contract reads. ~$38M supply. |
| 17 | **Plume pUSD** | pUSD | RWA | Simple USDC wrapper. BoringVault on Ethereum at `0x6104fe10ca937a086ba7AdbD0910A4733d380cB6`. | Single-asset read, straightforward. |
| 18 | **Tether Gold XAUT** | XAUT | RWA | Chainlink PoR announced for 2026 — contract not yet confirmed. Fallback: scrape `gold.tether.to/reports`. | Pending PoR deployment confirmation. |

---

## Tier 3 — LOW / NONE Feasibility (Skip for Now)

### PDF-Only Attestations (no machine-readable data)
PYUSD, USDG, USDP (all Paxos), BRZ, XSGD, GYEN, JPYC, IDRT, TRYB, EURI, EURE, CADC, tGBP, VCHF, VGBP, ZARP, AUDD, MNEE, FIDD, CASH, USDQ.

### Non-EVM Chains (no adapter support)
USDD (Tron primary), JUPUSD (Solana), BUCK (Sui), HOLLAR (Polkadot), YLDS (Provenance/Cosmos), USX (Solana).

### Opaque/Custodial Models
USDA-Avalon (off-chain BTC custody), USDF-Astherus (delta-neutral), DUSD-StandX (delta-neutral), rwUSDi (KYB-gated), USDU-Unitas (multi-chain delta-neutral).

### Winding Down / Too Small
USDM-Moneta (winding down Aug 2025), AEUR (MiCAR wind-down), ebUSD (~$600K), pmUSD (~$9M).

---

## New Adapter Designs

### `chainlink-por` — Chainlink Proof-of-Reserve Reader

Reads total reserves from a Chainlink AggregatorV3 PoR feed and compares with on-chain token supply.

**Input kind:** `onchain-evm`
**Params:**
```typescript
{
  porFeedAddress: string;      // Chainlink AggregatorV3 proxy address
  tokenAddress: string;        // ERC-20 token for totalSupply comparison
  assetLabel: string;          // e.g. "EUR Cash Reserves", "Physical Gold (LBMA)"
  assetRisk: ReserveRisk;      // e.g. "very-low" for cash, "medium" for gold
  priceSource?: string;        // DefiLlama asset ID for USD conversion (e.g. for gold tokens)
  feedDecimals?: number;       // Override if feed doesn't use standard 8/18 decimals
}
```
**Output:** Single `ReserveSlice` at 100% with the configured label and risk.
**Metadata:** `{ totalReserves, totalSupply, collateralizationRatio, feedTimestamp, feedRoundId }`
**Applicable to:** EURS, PAXG, TUSD, USD1, XAUT (pending), potentially AUSD.

### `chainlink-nav` — NAV Oracle Reader

Reads per-token NAV from an on-chain oracle + token `totalSupply()` to derive AUM and reserve composition.

**Input kind:** `onchain-evm`
**Params:**
```typescript
{
  oracleAddress: string;       // Oracle contract (Chainlink AggregatorV3 or custom)
  oracleMethod?: string;       // Default: "latestRoundData", alt: "getPrice"
  tokenAddress: string;        // ERC-20 token for totalSupply
  assetLabel: string;          // e.g. "U.S. Treasury Bills"
  assetRisk: ReserveRisk;
  navDecimals?: number;        // Decimals for NAV price (default 18)
  tokenDecimals?: number;      // Token decimals (default 18)
}
```
**Output:** Single `ReserveSlice` at 100%.
**Metadata:** `{ navPerToken, totalSupply, totalAumUsd, oracleTimestamp }`
**Applicable to:** USYC, OUSG, USDY, mTBILL, USTB.

---

## Implementation Roadmap (Recommended Batches)

### Batch 1: Quick Wins (config-only + simple adapters) — +9 coins
Effort: Small. Can be done in a single implementation cycle.

| Coin | Approach |
|------|----------|
| BUIDL | `single-asset` existing adapter. Config only. |
| USDB | `single-asset` existing adapter. Config only. |
| UTY | `accountable` existing adapter. Config only. |
| USDtb | `evm-branch-balances` existing adapter. Config + address discovery. |
| USD0 | `evm-branch-balances` existing adapter. Treasury balance reads. |
| OUSD | New `ousd` adapter (trivial — single JSON fetch). |
| USYC | New adapter or `single-asset` with HTTP JSON probe. |
| TBILL | Test OpenEden API pattern, extend existing `openeden-usdo`. |
| USDT | New `tether` adapter (JSON API, but only total assets/liabilities). |

### Batch 2: New Generic Adapters — +8 coins
Effort: Medium. Build `chainlink-por` and `chainlink-nav`, then config-add coins.

| Coin | Adapter |
|------|---------|
| TUSD | `chainlink-por` |
| USD1 | `chainlink-por` |
| EURS | `chainlink-por` |
| PAXG | `chainlink-por` |
| OUSG | `chainlink-nav` |
| USDY | `chainlink-nav` |
| mTBILL | `chainlink-nav` |
| USTB | `chainlink-nav` |

### Batch 3: Protocol-Specific Adapters — +4 coins
Effort: Medium-Large. Each needs a custom adapter with on-chain reads.

| Coin | Adapter |
|------|---------|
| GHO | New `gho` adapter (facilitator model + GSM balances) |
| eUSD | New `lybra` adapter (totalDepositedEther reads) |
| HYUSD | New `reserve-protocol` adapter (FacadeRead.primeBasket()) |
| FRXUSD | New `frax` adapter (combineddata API or custodian contracts) |

### Batch 4: HTML Scrapers + Reverse-Engineering — +2-4 coins
Effort: Medium. Fragile (HTML structure can change).

| Coin | Adapter |
|------|---------|
| USDC | New `circle` adapter (scrape transparency page or find internal API) |
| EURC | Same `circle` adapter (same page, different section) |
| FDUSD | New `firstdigital` adapter (HTML transparency page) |
| EURCV | New `sgforge` adapter (HTML product page) |

### Batch 5: Complex On-Chain Reads — +3-5 coins
Effort: Large. Multi-contract / multi-ilk reads.

| Coin | Adapter |
|------|---------|
| DAI/USDS | New `sky` adapter (Block Analitica API or Vat multicall) |
| DOLA | New `inverse` adapter (transparency API or FiRM reads) |
| MIM | New `abracadabra` adapter (multi-cauldron reads) |

---

## Impact Summary

| Batch | Coins Added | Cumulative Total | Coverage % |
|-------|-------------|-----------------|------------|
| Current | — | 28 | 18% |
| Batch 1 | +9 | 37 | 24% |
| Batch 2 | +8 | 45 | 29% |
| Batch 3 | +4 | 49 | 31% |
| Batch 4 | +2-4 | 51-53 | 33-34% |
| Batch 5 | +3-5 | 54-58 | 35-37% |

---

## Key Contract Addresses Reference

### Chainlink PoR / NAV Oracles

| Coin | Contract | Address | Chain | Interface |
|------|----------|---------|-------|-----------|
| TUSD | PoR Feed (Reserves) | `0xBE456fd14720C3aCCc30A2013Bffd782c9Cb75D5` | Ethereum | AggregatorV3 |
| TUSD | PoR Feed (Supply) | `0x807b029DD462D5d9B9DB45dff90D3414013B969e` | Ethereum | AggregatorV3 |
| USD1 | PoR Oracle | `0x691b74146cdba162449012aa32d3cbf5df77d4c4` | Ethereum | Custom (latestBundle) |
| EURS | EURR Reserves | `0x652A...Ac2d` (ENS: `eurr-reserves.data.eth`) | Ethereum | AggregatorV3 |
| PAXG | PoR Feed | Lookup at `docs.chain.link/data-feeds/proof-of-reserve/addresses` | Ethereum | AggregatorV3 |
| USYC | NAV Oracle | `0x74f2199AEb743f68f05943e5715A33EaF2b61f53` | Ethereum | AggregatorV3 |
| OUSG | NAV Oracle | `0x9Cad45a8BF0Ed41Ff33074449B357C7a1fAb4094` | Ethereum | Custom (getPrice) |
| USDY | NAV Oracle | `0xA0219AA5B31e65Bc920B5b6DFb8EdF0988121De0` | Ethereum | Custom (getPrice) |
| mTBILL | Ankura Oracle | `0x056339C044055819E8Db84E71f5f2E1F536b2E5b` | Ethereum | AggregatorV3 (IDataFeed) |
| USTB | Superstate Oracle | `0xe4fa682f94610ccd170680cc3b045d77d9e528a8` | Ethereum | AggregatorV3 |
| USTB | Chainlink NAV | `0x289B5036cd942e619E1Ee48670F98d214E745AAC` | Ethereum | AggregatorV3 |

### Token Contracts

| Coin | Address | Chain |
|------|---------|-------|
| GHO | `0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f` | Ethereum |
| GHO GSM USDC | `0xFeeb6FE430B7523fEF2a38327241eE7153779535` | Ethereum |
| GHO GSM USDT | `0x535b2f7C20B9C83d70e519cf9991578eF9816B7B` | Ethereum |
| USD0 Treasury | `0xdd82875f0840AAD58a455A70B88eEd9F59ceC7c7` | Ethereum |
| USD0 USYC collateral | `0x136471a34f6ef19fE571EFFC1CA711fdb8E49f2b` | Ethereum |
| USD0 UsualM collateral | `0x4Cbc25559DbBD1272EC5B64c7b5F48a2405e6470` | Ethereum |
| USD0 UsualUSDtb collateral | `0x58073531a2809744D1bF311D30FD76B27D662abB` | Ethereum |
| BUIDL | `0x7712c34205737192402172409a8f7ccef8aa2aec` | Ethereum |
| eUSD | `0x97de57ec338ab5d51557da3434828c5dbfada371` | Ethereum |
| OUSD API | `https://api.originprotocol.com/api/v2/ousd/collateral` | — |
| USYC API | `https://usyc.hashnote.com/api/price` | — |
| USDT API | `https://app.tether.to/transparency.json` | — |
| FRXUSD API | `https://api.frax.finance/combineddata/` | — |
| DAI Vat | `0x35D1b3F3D7966A1DFe207aa4514C12a259A0492B` | Ethereum |
| PAXG | `0x45804880De22913dAFE09f4980848ECE6EcbAf78` | Ethereum |
| USYC Token | `0x136471a34f6ef19fE571EFFC1CA711fdb8E49f2b` | Ethereum |
| OUSG Token | `0x1B19C19393e2d034D8Ff31ff34c81252FcBbee92` | Ethereum |
| USDY Token | `0x96F6eF951840721AdBF46Ac996b59E0235CB985C` | Ethereum |
| mTBILL Token | `0xDD629E5241CbC5919847783e6C96B2De4754e438` | Ethereum |
| USTB Token | `0x43415eB6ff9DB7E26A15b704e7A3eDCe97d31C4e` | Ethereum |

---

## Data Source Quality Notes

### JSON APIs (best quality)
- **USDT** (`transparency.json`): Total assets/liabilities only. No asset-class breakdown (T-bills, cash, gold). Still useful for collateralization ratio.
- **OUSD** (`originprotocol.com`): Per-asset collateral breakdown. Best quality source found.
- **USYC** (`hashnote.com/api/price`): NAV price + timestamp. Clean and documented.
- **FRXUSD** (`api.frax.finance`): Protocol treasury data. May need frxUSD-specific filtering.

### On-Chain Oracles (reliable, decentralized)
- Chainlink PoR feeds (TUSD, EURS, PAXG): Standard AggregatorV3, well-tested.
- NAV oracles (OUSG, USDY, mTBILL, USTB): Provider-specific but Chainlink-compatible interfaces.
- USD1: Custom `latestBundle()` function, not standard AggregatorV3.

### HTML Scraping (fragile)
- Circle transparency page (USDC/EURC): Richest data but HTML structure can change.
- FDUSD, RLUSD, GUSD, EURCV: Similar fragility concerns.
- **Recommendation:** Investigate internal JSON endpoints powering these pages before committing to HTML parsing.

### Important Limitations
- **USDT has no live asset-class breakdown.** The JSON API only shows total assets vs liabilities. The quarterly PDF attestation is the only source for the T-bills/cash/gold split. A live adapter would provide collateralization proof but not composition.
- **Paxos coins (PYUSD, USDG, USDP) are PDF-only.** Paxos has APIs for mint/redeem but nothing for reserve data.
- **Most regional stablecoins have no machine-readable data.** BRZ, XSGD, GYEN, JPYC, IDRT, TRYB, EURI, etc. all rely on periodic PDF attestations.
- **Non-EVM chains are not supported** by the current adapter infrastructure. USDD (Tron), JUPUSD (Solana), BUCK (Sui), HOLLAR (Polkadot) would require new chain support.
