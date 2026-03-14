# Live Reserve Data Source Survey — Remaining Stablecoins

**Date:** 2026-03-14
**Scope:** Identify public API, transparency dashboard, or on-chain data sources for stablecoins without live reserve adapters.
**Existing adapters:** 16 registered adapters covering 29 coins (see `worker/src/cron/reserve-adapters/index.ts`).

---

## Feasibility Legend

| Rating | Meaning |
|--------|---------|
| **HIGH** | Structured API or on-chain feed exists; adapter can be built with reasonable effort |
| **MEDIUM** | Data exists but requires scraping, reverse-engineering, or has reliability concerns |
| **LOW** | Data is published but only as PDFs, periodic reports, or non-machine-readable formats |
| **NONE** | No public data source found; only periodic audit PDFs or no transparency at all |

---

## Regional / Non-USD Stablecoins

### EURC (Circle)

| Field | Detail |
|-------|--------|
| **Data source** | Circle transparency page (`circle.com/transparency`); BlackRock daily fund data for USDXX (Circle Reserve Fund) |
| **Format** | The transparency page renders reserve composition via JavaScript (Chart.js) with underlying data attributes. No documented public JSON API endpoint. Monthly attestation PDFs by Deloitte & Touche. |
| **Frequency** | Weekly disclosure (USDC); monthly attestation (EURC) |
| **Breakdown** | EURC: cash deposits + bank deposits at SIIs (systemically important institutions). Shown in EUR millions. |
| **Auth** | None for the web page; no documented API key required |
| **Feasibility** | **MEDIUM** -- The transparency page likely fetches JSON from an internal API (inspect network tab). Could reverse-engineer that endpoint or scrape the rendered data. EURC reserve composition is simple (cash + bank deposits) so even a `single-asset` adapter pointing to "100% EUR cash/bank deposits" would be accurate. |
| **Notes** | Circle has a supply API for USDC per-chain data but nothing documented for EURC reserves specifically. Contact `[email protected]` for API access. |

### EURI (Banking Circle)

| Field | Detail |
|-------|--------|
| **Data source** | No public transparency API or dashboard found |
| **Format** | Independent attestations by top-tier audit firm; PeckShield smart contract audit |
| **Frequency** | Periodic attestations (frequency not specified) |
| **Breakdown** | 1:1 EUR cash in fiduciary reserve at Banking Circle S.A. (CSSF-regulated) |
| **Auth** | N/A |
| **Feasibility** | **NONE** -- Single-asset (100% EUR cash) but no machine-readable data. Could use `single-asset` template with static metadata. |

### AEUR (Anchored Coins)

| Field | Detail |
|-------|--------|
| **Data source** | No public API; Prescient Assurance audits |
| **Format** | Audit reports only |
| **Frequency** | Periodic |
| **Breakdown** | 1:1 EUR in Swissquote Bank SA |
| **Auth** | N/A |
| **Feasibility** | **NONE** -- Winding down under MiCAR (Swiss company cannot issue EUR EMTs in EU). Not worth building an adapter. |

### EURE (Monerium)

| Field | Detail |
|-------|--------|
| **Data source** | Monerium API at `monerium.dev/docs/tokens`; SDK at `@monerium/sdk` |
| **Format** | API exists for minting/payments, not for reserves. No reserve-specific endpoint found. |
| **Frequency** | Annual audit + MiCA-required attestations |
| **Breakdown** | 102% backing in high-quality liquid assets + bank deposits |
| **Auth** | SDK requires auth for transactional operations |
| **Feasibility** | **NONE** -- API is for payments/minting, not reserve transparency. Single-asset template viable. |

### EURCV (SG Forge / Societe Generale)

| Field | Detail |
|-------|--------|
| **Data source** | SG Forge website (`sgforge.com/product/coinvertible/`) shows daily circulating supply |
| **Format** | HTML page with daily-updated figures: EURCV circ supply = 85,450,062.55 (as of 2026-03-14), backed 100% by SocGen. USDCV = 23,331,450.00, backed 100% by BNY. Monthly PwC audit. |
| **Frequency** | Daily (business days) |
| **Breakdown** | 100% cash/bank deposits at Societe Generale (EURCV) or BNY (USDCV). Collateral composition with eligibility criteria (min rating, liquidity). |
| **Auth** | None (public page) |
| **Feasibility** | **MEDIUM** -- Daily data exists on the HTML page. Could build an `http-html` adapter similar to the `mento` adapter to scrape the circulating supply figures. Reserve is 100% cash so composition is trivial. Worth pursuing for a bank-grade stablecoin. |

### BRZ (Transfero)

| Field | Detail |
|-------|--------|
| **Data source** | No public API found |
| **Format** | Periodic independent audit reports |
| **Frequency** | Periodic (unspecified) |
| **Breakdown** | 1:1 BRL in Central Bank of Brazil-authorized institution |
| **Auth** | N/A |
| **Feasibility** | **NONE** -- No machine-readable data. Single-asset template only. |

### EURS (Stasis)

| Field | Detail |
|-------|--------|
| **Data source** | Chainlink Proof of Reserve oracle on Ethereum mainnet; Stasis transparency page (`eurs.stasis.net/transparency`); internal API at `api-site.stasis.net` |
| **Format** | On-chain: Chainlink PoR feed "EURR Reserves" (proxy `0x652A...Ac2d`, ENS `eurr-reserves.data.eth`). Off-chain: daily statements, quarterly BDO Malta verifications, annual audits. The transparency page embeds JSON with statement metadata. |
| **Frequency** | On-chain: every 10 minutes (1% deviation threshold). Off-chain: daily statements. |
| **Breakdown** | 100% liquid EUR balances at partner institutions |
| **Auth** | On-chain read: none. `api-site.stasis.net`: unknown (likely requires investigation) |
| **Feasibility** | **HIGH** -- Chainlink PoR feed is readable on-chain via standard AggregatorV3 interface. Can read `latestRoundData()` to get total EUR reserves and compare with on-chain EURS supply. Build an `onchain-evm` adapter that reads the PoR contract. The `api-site.stasis.net` endpoint is also worth investigating. |
| **Adapter approach** | New `chainlink-por` adapter type, or extend `single-asset` with a PoR read. Feed address needs ENS resolution or direct lookup on Etherscan. |

### XSGD (StraitsX)

| Field | Detail |
|-------|--------|
| **Data source** | Monthly attestation reports (ISCA-listed auditor); bi-monthly proof-of-reserve snapshots |
| **Format** | PDF attestation reports published on straitsx.com |
| **Frequency** | Twice monthly (attestation snapshots) |
| **Breakdown** | 100% SGD cash at DBS and Standard Chartered |
| **Auth** | N/A |
| **Feasibility** | **NONE** -- PDF-only. StraitsX has developer APIs but for integration, not reserves. |

### IDRT (Rupiah Token)

| Field | Detail |
|-------|--------|
| **Data source** | No public reserve API. IDRT Fiat Gateway API (by Pintu) is for fiat-to-IDRT conversion. |
| **Format** | CertiK smart contract audit; independent reserve audits (periodic) |
| **Frequency** | Periodic |
| **Breakdown** | 1:1 IDR in Indonesian bank |
| **Auth** | N/A |
| **Feasibility** | **NONE** |

### TRYB (BiLira)

| Field | Detail |
|-------|--------|
| **Data source** | No public API. Dune Analytics dashboards for on-chain data. |
| **Format** | Independent audit reports; Dune on-chain analytics |
| **Frequency** | Periodic audits |
| **Breakdown** | 100% TRY in Turkish bank accounts |
| **Auth** | N/A |
| **Feasibility** | **NONE** |

### GYEN (GMO Trust)

| Field | Detail |
|-------|--------|
| **Data source** | Monthly attestation reports on `stablecoin.z.com` (under `/attestation/` path) |
| **Format** | PDF attestation reports by independent accounting firm |
| **Frequency** | Monthly |
| **Breakdown** | 1:1 JPY reserves |
| **Auth** | N/A |
| **Feasibility** | **NONE** -- PDF reports only. NYDFS-regulated. |

### JPYC

| Field | Detail |
|-------|--------|
| **Data source** | No proof-of-reserves API or on-chain PoR. Regulated under Japan's FSA Payment Services Act. |
| **Format** | Regulatory compliance attestations |
| **Frequency** | Per regulatory requirements |
| **Breakdown** | 100% JPY reserves under FSA rules |
| **Auth** | N/A |
| **Feasibility** | **NONE** |

---

## Gold / Commodity Tokens

### XAUT (Tether Gold)

| Field | Detail |
|-------|--------|
| **Data source** | Tether transparency page (`tether.to/transparency`); gold bar lookup at `gold.tether.to/reports`; Chainlink PoR integration announced for 2026 |
| **Format** | Quarterly BDO Italia attestations (ISAE 3000). Chainlink PoR feed reportedly live in 2026 but no confirmed contract address found yet. Web lookup tool for holders. |
| **Frequency** | Quarterly attestations; Chainlink PoR would be near real-time |
| **Breakdown** | 1 XAUt = 1 troy oz gold in Swiss vaults (Brinks/Loomis). ~246,524 oz as of Q4 2025. |
| **Auth** | None for public data |
| **Feasibility** | **MEDIUM** -- If the Chainlink PoR feed is live, it becomes HIGH (same `onchain-evm` approach as EURS). The Tether transparency page may have scrapeable data. Need to confirm the PoR contract address. The `gold.tether.to/reports` page may expose structured data. |
| **Notes** | Monitor Chainlink data feed directory for XAUT PoR feed deployment. |

### PAXG (Paxos Gold)

| Field | Detail |
|-------|--------|
| **Data source** | Monthly KPMG attestation reports at `paxos.com/paxg-transparency`; Chainlink PoR feed on Ethereum (confirmed active); PAXG gold bar lookup tool |
| **Format** | Chainlink PoR feed for PAXG on Ethereum mainnet (address needs lookup from `docs.chain.link/data-feeds/proof-of-reserve/addresses`). Monthly PDF attestations. Web-based gold bar lookup by Ethereum address. |
| **Frequency** | Chainlink PoR: at least daily updates (self-reported by Paxos). Monthly attestations. |
| **Breakdown** | 1 PAXG = 1 troy oz London Good Delivery gold in LBMA vaults |
| **Auth** | None for on-chain read |
| **Feasibility** | **HIGH** -- Chainlink PoR feed is confirmed active. Standard AggregatorV3 read for total gold reserves. PAXG token contract at `0x45804880De22913dAFE09f4980848ECE6EcbAf78`. |
| **Adapter approach** | Read Chainlink PoR aggregator `latestRoundData()` for total gold oz, multiply by gold price (from DL or Chainlink XAU/USD feed), compare with totalSupply. Single-slice "Physical Gold (LBMA)" output. |

### KAU / KAG (Kinesis)

| Field | Detail |
|-------|--------|
| **Data source** | Kinesis blockchain explorer (Stellar fork); bi-annual Inspectorate International (Bureau Veritas) physical audits; audit reports at `kinesis.money/audits/` |
| **Format** | Published audit reports (PDF). Kinesis blockchain explorer for circulation data. No standard API. |
| **Frequency** | Bi-annual physical audits |
| **Breakdown** | KAU: 1 token = 1g gold. KAG: 1 token = 1 oz silver. Gold/silver in vaults across 13+ global locations. |
| **Auth** | N/A |
| **Feasibility** | **NONE** -- Custom Stellar-fork blockchain with limited explorer tooling. No API. Significant transparency concerns raised by independent analysts (35%+ of gold uninspected). |

---

## Mid/Small-Cap Stablecoins

### USX (Solstice)

| Field | Detail |
|-------|--------|
| **Data source** | Chainlink Proof of Reserve (planned/in progress); on-chain collateral (USDC/USDT on Solana) |
| **Format** | On-chain verification; Chainlink Data Streams integration |
| **Frequency** | Near real-time if Chainlink PoR is deployed |
| **Breakdown** | 100% collateralized by USDC/USDT initially, expanding to SOL/ETH/BTC |
| **Auth** | None for on-chain |
| **Feasibility** | **MEDIUM** -- Solana-based, which limits EVM adapter reuse. If Chainlink PoR is deployed on an EVM chain, it becomes HIGH. Currently early stage. |

### USDF (Astherus/Aster)

| Field | Detail |
|-------|--------|
| **Data source** | No public reserves API. Token on BSC at `0x5a110fc00474038f6c02e89c707d638602ea44b5`. |
| **Format** | Delta-neutral strategy backing (crypto + short futures). Ceffu custody. |
| **Frequency** | N/A |
| **Breakdown** | USDT-backed with delta-neutral hedging |
| **Auth** | N/A |
| **Feasibility** | **NONE** -- Opaque delta-neutral strategy. No reserve breakdown available. |

### DUSD (StandX)

| Field | Detail |
|-------|--------|
| **Data source** | No public API. On-chain collateral tracking planned. |
| **Format** | Delta-neutral strategy (spot + short perps). Custodian solution. Reserve fund for negative funding. |
| **Frequency** | N/A |
| **Breakdown** | Market-neutral hedged assets |
| **Auth** | N/A |
| **Feasibility** | **NONE** |

### satUSD (River Protocol)

| Field | Detail |
|-------|--------|
| **Data source** | On-chain CDP contracts across multiple chains (Hemi, BSC, Ethereum, Base, BOB) via LayerZero |
| **Format** | Over-collateralized CDP model. Collateral: BTC, ETH, BNB, LSTs. |
| **Frequency** | Real-time on-chain |
| **Breakdown** | Multi-collateral CDP positions |
| **Auth** | None |
| **Feasibility** | **LOW** -- Cross-chain CDP across 5+ chains via LayerZero makes aggregation complex. No single API. |

### rwUSDi (Multipli)

| Field | Detail |
|-------|--------|
| **Data source** | Multipli platform claims "full transparency through APIs" but no public endpoint documented |
| **Format** | KYB-gated institutional variant of rwaUSD. Lloyd's insurance for de-peg risk. |
| **Frequency** | Unknown |
| **Breakdown** | Aggregated Treasury-backed stablecoins + tokenized gold |
| **Auth** | Likely KYB-gated |
| **Feasibility** | **NONE** -- Institutional/KYB-gated. No public reserve API found. |

### PUSD (Pleasing Golden)

| Field | Detail |
|-------|--------|
| **Data source** | No public API found |
| **Format** | Hybrid USDT collateral + tokenized metal exposure |
| **Frequency** | N/A |
| **Breakdown** | USDT + precious metals |
| **Auth** | N/A |
| **Feasibility** | **NONE** |

### reUSD (Re Protocol)

| Field | Detail |
|-------|--------|
| **Data source** | Chainlink oracle for price feed and trust balances; The Network Firm daily attestation pushed via Chainlink; Fireblocks vault |
| **Format** | On-chain Chainlink oracle publishes: price feeds, trust balances, surplus-note schedules, redemption queues. Daily attestation by The Network Firm. |
| **Frequency** | Daily (trust balances via Chainlink); reUSD price updates daily at 00:00 UTC |
| **Breakdown** | Principal-protected yield token backed by delta-neutral ETH strategy or T-bills + protocol spread. Reinsurance treaty exposure. |
| **Auth** | None for on-chain reads |
| **Feasibility** | **MEDIUM** -- Chainlink oracle data is on-chain and readable, but the reserve composition (reinsurance treaties) is complex and may not map cleanly to reserve slices. The Network Firm attestation via Chainlink is the same provider used for several Accountable-platform coins. |
| **Contracts** | Ethereum: `0x5086bf358635b81d8c47c66d1c8b9e567db70c72`, Base: `0x7d214438d0f27afccc23b3d1e1a53906ace5cfea` |

### pmUSD (RAAC / Precious Metals)

| Field | Detail |
|-------|--------|
| **Data source** | Dashboard at `pmusd.raac.io` with TVL, collateral breakdown, collateral health ratio; Instruxi Proof of Reserve Dashboard |
| **Format** | Web dashboard (JavaScript-rendered). ION.au collateral framework. |
| **Frequency** | Appears real-time on dashboard |
| **Breakdown** | Gold-backed via ION.au tokenized precious metals |
| **Auth** | None for public dashboard |
| **Feasibility** | **MEDIUM** -- Dashboard exists but is JS-rendered. Need to investigate if there's an underlying API. Very small cap (~$9M). |

### cgUSD (Cygnus Finance)

| Field | Detail |
|-------|--------|
| **Data source** | Chainlink Price Feeds (USDC/USD, USDT/USD) on Base; RWA.xyz analytics; custom SDKs |
| **Format** | Rebasing ERC-20 backed by US Treasury bills. Total issuance aligns with net asset value every NY banking day. |
| **Frequency** | Daily (NY banking day) |
| **Breakdown** | On-chain stablecoins + US Treasury Bills + accrued interest |
| **Auth** | None for on-chain |
| **Feasibility** | **MEDIUM** -- Cross-chain deposit via SolverNet SDK on Base. Chainlink price feeds verify NAV. Potential to read total supply vs. underlying assets on-chain. |

### USDQ (Quantoz)

| Field | Detail |
|-------|--------|
| **Data source** | No public API. DNB-regulated quarterly audits. |
| **Format** | 102% overcollateralized in bankruptcy-remote entity (Stichting Quantoz). Cash + short-term Treasuries. |
| **Frequency** | Quarterly audits |
| **Breakdown** | 100% fiat + 2% own-balance-sheet overcollateral |
| **Auth** | N/A |
| **Feasibility** | **NONE** |

### REUSD (Resupply)

| Field | Detail |
|-------|--------|
| **Data source** | On-chain ERC-20 at `0x57aB1E0003F623289CD798B1824Be09a793e4Bec`; Resupply dApp at `resupply.fi` |
| **Format** | CDP-backed by Curve Lend / Fraxlend vault tokens (crvUSD, frxUSD). Insurance Pool for liquidations. |
| **Frequency** | Real-time on-chain |
| **Breakdown** | Curve Lend + Fraxlend lending pool tokens as collateral |
| **Auth** | None |
| **Feasibility** | **MEDIUM** -- On-chain CDP model. Could read collateral positions from contracts. Built jointly by Convex + Yearn. ~$38M supply. |

### USDU (Unitas)

| Field | Detail |
|-------|--------|
| **Data source** | On-chain proof-of-reserves (stated in docs); minting/redemption API (KYC-gated) |
| **Format** | Delta-neutral (JLP + short perps). Segregated MPC vaults at institutional custodians. Hourly re-hedging. |
| **Frequency** | Real-time PoR stated |
| **Breakdown** | JLP tokens + cash/T-bills. 80% yield to sUSDu, 10% insurance, 10% treasury. |
| **Auth** | KYC-gated for minting API; PoR may be public |
| **Feasibility** | **LOW** -- Claims on-chain PoR but specifics unclear. Multi-chain (Solana + BNB). Strategy complexity makes slice mapping hard. |

### USDH (Native Markets / Hyperliquid)

| Field | Detail |
|-------|--------|
| **Data source** | Oracle feeds for real-time reserve monitoring; monthly third-party attestations (starting Nov 2025); issued by Bridge (Stripe company) |
| **Format** | Hybrid model: off-chain (BlackRock/JPMorgan) + on-chain (Superstate/Fireblocks). Oracle-published reserve data. |
| **Frequency** | Real-time via oracle; monthly attestations |
| **Breakdown** | 100% US Treasuries + cash + cash equivalents |
| **Auth** | Unknown for oracle data |
| **Feasibility** | **MEDIUM** -- High-profile stablecoin with institutional backing. Oracle data may be accessible. Need to identify specific oracle contract/feed. Hyperliquid is a custom L1. |

### ebUSD (Ebisu)

| Field | Detail |
|-------|--------|
| **Data source** | On-chain CDP on Ethereum at `0x09fd37d9aa613789c517e76df1c53aece2b60df4` |
| **Format** | Liquity-inspired CDP model. Collateral: BTC, ETH, USD-pegged assets (LRTs). |
| **Frequency** | Real-time on-chain |
| **Breakdown** | Over-collateralized against liquid restaking tokens |
| **Auth** | None |
| **Feasibility** | **LOW** -- Small cap (~$600K raised). Liquity-style CDP readable on-chain but requires contract ABI investigation. Low priority. |

### MSUSD (Metronome Synth)

| Field | Detail |
|-------|--------|
| **Data source** | On-chain Alchemist.sol-style contracts; Gauntlet analytics; DefiLlama |
| **Format** | Synthetic stablecoin minted against USDC, FRAX, DAI, vaUSDC, vaFRAX, ETH, BTC, LSTs. 80-85% collateral factor. |
| **Frequency** | Real-time on-chain |
| **Breakdown** | Multi-collateral synthetic with deposit caps per asset |
| **Auth** | None |
| **Feasibility** | **LOW** -- Complex multi-collateral synth. Contract reads possible but mapping to clean slices is non-trivial. |

### HOLLAR (Hydration / Polkadot)

| Field | Detail |
|-------|--------|
| **Data source** | On-chain on Hydration appchain (Polkadot/Substrate); Hydration API docs |
| **Format** | Aave GHO-fork CDP model. Collateral: DOT, ETH, vDOT, USDT, USDC, tBTC, WBTC. |
| **Frequency** | Real-time on-chain |
| **Breakdown** | Over-collateralized multi-asset + Stability Module (HSM) |
| **Auth** | None |
| **Feasibility** | **LOW** -- Polkadot/Substrate chain, not EVM. Would need custom Substrate RPC adapter. Low priority. |

### UTY (XSY)

| Field | Detail |
|-------|--------|
| **Data source** | Accountable Data Verification Network + RedStone oracle; live dashboard at `accountable.xsy.fi/` |
| **Format** | Real-time cryptographically verified PoR via zero-knowledge proofs. RedStone pushes verified data on-chain. |
| **Frequency** | Continuous/real-time |
| **Breakdown** | Delta-neutral (funding via perps + spot hedging). Ceffu and Copper Clearloop custody. |
| **Auth** | None for public dashboard |
| **Feasibility** | **HIGH** -- Uses the Accountable platform, which is the same provider powering the existing `accountable` adapter (already serving 5 coins). Likely compatible with the existing adapter with minimal configuration. |
| **Adapter approach** | Extend existing `accountable` adapter config. Need to verify the Accountable API endpoint format for UTY matches the existing adapter's expectations. |

### BUCK (Bucket Protocol)

| Field | Detail |
|-------|--------|
| **Data source** | On-chain CDP on Sui blockchain; Bucket Protocol GitHub has SDK |
| **Format** | CDP model with PSM. Collateral: SUI, BTC, ETH. OtterSec + MoveBit audits. |
| **Frequency** | Real-time on-chain |
| **Breakdown** | Over-collateralized multi-asset on Sui |
| **Auth** | None |
| **Feasibility** | **LOW** -- Sui Move-based, not EVM. Would need Sui RPC adapter. |

### ALUSD (Alchemix)

| Field | Detail |
|-------|--------|
| **Data source** | On-chain Alchemist.sol contract on Ethereum; Chainlink price feeds; DefiLlama TVL data |
| **Format** | Self-repaying CDP. Collateral deposited into Yearn vaults for yield. Transmuter for 1:1 redemption. |
| **Frequency** | Real-time on-chain |
| **Breakdown** | DAI/USDC/USDT deposited into yield strategies (Yearn, Aave, etc.) |
| **Auth** | None |
| **Feasibility** | **MEDIUM** -- Well-documented Ethereum contracts. Could read Alchemist.sol for total deposited collateral per asset. The Transmuter holds reserve DAI. Contract ABI is public. DefiLlama API also provides TVL breakdown. |

### pUSD (Plume)

| Field | Detail |
|-------|--------|
| **Data source** | On-chain BoringVault on Plume Chain; Nucleus Vault system |
| **Format** | Simple USDC wrapper. Primary minter at `0x6104fe10ca937a086ba7AdbD0910A4733d380cB6` on Ethereum. Also accepts USD1 and AUSD as reserve assets. |
| **Frequency** | Real-time on-chain |
| **Breakdown** | 1:1 backed by USDC + USD1 + AUSD |
| **Auth** | Off-chain compliance API for minting (OFAC check) |
| **Feasibility** | **MEDIUM** -- Could read underlying vault balances on Ethereum. Simple reserve structure (USDC wrapper). May fit the `erc4626-single-asset` or `single-asset` adapter pattern. |

### dUSD (dTrinity)

| Field | Detail |
|-------|--------|
| **Data source** | On-chain reserve on Fraxtal L2; API3 oracles for asset valuation |
| **Format** | Full-reserve model backed by frxUSD, sfrxUSD, and other stablecoins/yieldcoins. 90%+ in yieldcoins. |
| **Frequency** | Real-time on-chain |
| **Breakdown** | Segregated per-chain reserves. Fraxtal primary deployment. |
| **Auth** | None |
| **Feasibility** | **LOW** -- Fraxtal L2 deployment. Would need Fraxtal RPC. Small protocol. Non-standard reserve (non-redeemable by users, only protocol can redeem). |

---

## Priority Recommendations

### Tier 1: Build Now (HIGH feasibility, significant coverage value)

| Coin | Adapter Approach | Effort |
|------|-----------------|--------|
| **EURS** | New `chainlink-por` adapter reading EURR Reserves feed on Ethereum. Resolve ENS `eurr-reserves.data.eth` or find proxy address on Etherscan. Single slice: "EUR Cash Reserves". | Small -- one new adapter type reusable for PAXG/XAUT |
| **PAXG** | Same `chainlink-por` adapter reading PAXG PoR feed on Ethereum. Single slice: "Physical Gold (LBMA)". Multiply oz by XAU/USD price. | Small -- second consumer of same adapter |
| **UTY** | Extend existing `accountable` adapter configuration. Verify Accountable API format at `accountable.xsy.fi`. | Minimal -- existing adapter, new config entry |

### Tier 2: Worth Investigating (MEDIUM feasibility, good coverage value)

| Coin | Adapter Approach | Effort |
|------|-----------------|--------|
| **EURC** | Reverse-engineer Circle transparency page JSON endpoint, or use `single-asset` with "EUR bank deposits" static composition. | Medium |
| **EURCV** | `http-html` scraper for `sgforge.com/product/coinvertible/` daily figures. Simple 100% cash composition. | Medium |
| **XAUT** | Confirm Chainlink PoR feed deployment in 2026, then use `chainlink-por`. Fallback: scrape `gold.tether.to/reports`. | Medium (pending PoR confirmation) |
| **ALUSD** | `onchain-evm` adapter reading Alchemist.sol deposited collateral per vault. | Medium |
| **REUSD** | On-chain CDP reads from Resupply contracts. | Medium |
| **USDH** | Investigate oracle contract on Hyperliquid L1. | Medium |
| **pUSD** | Read BoringVault balances on Ethereum. Simple USDC wrapper. | Medium |

### Tier 3: Not Actionable / Low Priority

All remaining coins fall here due to: no public data sources (EURI, BRZ, XSGD, IDRT, TRYB, GYEN, JPYC, USDF, DUSD, PUSD, rwUSDi, USDQ), non-EVM chains (BUCK on Sui, HOLLAR on Polkadot, USX on Solana), complex multi-chain CDPs (satUSD), winding down (AEUR), or very small cap with limited tooling (ebUSD, pmUSD, cgUSD, dUSD, MSUSD).

---

## New Adapter Type: `chainlink-por`

A reusable `chainlink-por` adapter would unlock multiple coins. Design:

- **Input kind**: `onchain-evm` (reads Chainlink AggregatorV3Interface)
- **Params**: `{ porFeedAddress, tokenAddress, assetLabel, assetUnit, priceSource? }`
- **Logic**: Read `latestRoundData()` from PoR feed for total reserves. Read `totalSupply()` from token. If `priceSource` specified (e.g., Chainlink XAU/USD for gold), convert to USD.
- **Output**: Single `ReserveSlice` with label from `assetLabel`, percentage = 100%.
- **Applicable to**: EURS (EUR cash), PAXG (gold), XAUT (gold, pending), potentially more as Chainlink PoR adoption grows.

---

## Key External References

- Circle transparency: https://www.circle.com/transparency
- STASIS transparency: https://eurs.stasis.net/transparency
- STASIS API: https://api-site.stasis.net
- SG Forge CoinVertible: https://www.sgforge.com/product/coinvertible/
- Chainlink PoR feeds: https://docs.chain.link/data-feeds/proof-of-reserve/addresses
- Chainlink EURR Reserves feed: https://data.chain.link/feeds/ethereum/mainnet/eurr-reserves
- Paxos PAXG transparency: https://www.paxos.com/paxg-transparency
- PAXG token contract: 0x45804880De22913dAFE09f4980848ECE6EcbAf78
- Tether Gold reports: https://gold.tether.to/reports
- Tether transparency: https://tether.to/transparency
- Accountable (UTY): https://accountable.xsy.fi/
- Kinesis audits: https://kinesis.money/audits/
- RAAC pmUSD: https://pmusd.raac.io/
- GMO Trust attestations: https://stablecoin.z.com/gyen/
- Monerium API docs: https://monerium.dev/docs/tokens
- StraitsX: https://www.straitsx.com/xsgd
- Re Protocol docs: https://docs.re.xyz
- Resupply: https://resupply.fi/
- Alchemix docs: https://docs.alchemix.fi
