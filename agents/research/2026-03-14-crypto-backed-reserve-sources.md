# Live Reserve Data Sources for Crypto-Backed Stablecoins

**Date:** 2026-03-14
**Purpose:** Research data sources for live reserve/collateral composition adapters for crypto-backed stablecoins tracked by Pharos.

**Current state:** Of the 20 coins researched, only HONEY (Berachain) already has a `liveReservesConfig` adapter (`collateral-positions-api`). All others need new adapters.

---

## TIER 1 — Top Crypto-Backed by Market Cap

### DAI (MakerDAO) / USDS (Sky)

**Pharos IDs:** `dai-makerdao`, `usds-sky`
**Classification:** crypto-backed, centralized-dependent

| Source | Details |
|--------|---------|
| **Block Analitica Maker API** | Open-source API at [github.com/blockanalitica/maker-api](https://github.com/blockanalitica/maker-api). Powers the dashboard at `maker.blockanalitica.com`. Python/Django backend — endpoints not publicly documented but discoverable from code. Likely exposes `/collaterals/` with vault-level breakdowns. |
| **info.sky.money / info.skyeco.com** | Sky's official collateral dashboard at `https://info.skyeco.com/collateral`. Powered by Block Analitica data pipeline (`atlas.blockanalitica.com`). Network requests would reveal JSON API endpoints. |
| **Sky Fusion Dashboard** | `https://fusion.skyeco.com/` — additional analytics surface. |
| **On-chain: Vat contract** | Core accounting contract. Each collateral type (ilk) stores debt and collateral data. `Vat.ilks(bytes32)` returns `(Art, rate, spot, line, dust)`. Address: `0x35D1b3F3D7966A1DFe207aa4514C12a259A0492B` |
| **On-chain: LitePSM** | USDC PSM contract — `gem()` balance gives USDC backing. |
| **Dai.js / Pymaker SDKs** | MakerDAO's official JS/Python libraries for reading vault state. |
| **DefiLlama** | `GET https://stablecoins.llama.fi/stablecoin/5` (DAI), `GET https://stablecoins.llama.fi/stablecoin/209` (USDS). Supply/chain data only, no collateral breakdown. |
| **daistats.com** | Reads directly from on-chain; no documented API. |
| **makerburn.com** | Dashboard for DAI mint/MKR burn; no documented API. |

**Reserve breakdown available:** Yes — vault-level from on-chain data (ilk Art/ink), aggregated via Block Analitica.
**Update frequency:** On-chain = real-time; Block Analitica dashboard = minutes.
**Authentication:** None for on-chain reads. Block Analitica API unknown (may be open).
**Best approach for adapter:** Fetch from Block Analitica API endpoints (inspect network traffic on `info.skyeco.com/collateral`), or build on-chain multicall reading Vat.ilks for top ilks.
**Feasibility: MEDIUM** — No single documented JSON API; requires either reverse-engineering Block Analitica endpoints or building an on-chain multicall adapter. Significant value due to DAI+USDS combined market cap.

---

### GHO (Aave)

**Pharos ID:** `gho-aave`
**Classification:** crypto-backed, centralized-dependent

| Source | Details |
|--------|---------|
| **UiGhoDataProvider contract** | `0x379c1EDD1A41218bdbFf960a9d5AD2818Bf61aE8` on Ethereum. Returns `GhoReserveData` including `aaveFacilitatorBucketLevel` and `aaveFacilitatorBucketMaxCapacity`. |
| **GHO Token contract** | `0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f`. `getFacilitatorBucket(address)` returns `(bucketCapacity, bucketLevel)` per facilitator. `getFacilitatorsList()` returns all facilitators. |
| **UiPoolDataProvider** | Standard Aave V3 contract for querying all market and user data including reserves/collateral for the Aave V3 Ethereum facilitator. |
| **GSM contracts** | GSMUSDC: `0xFeeb6FE430B7523fEF2a38327241eE7153779535`, GSMUSDT: `0x535b2f7C20B9C83d70e519cf9991578eF9816B7B`. These hold stablecoin reserves for the GHO Stability Module. |
| **Aave V3 Subgraph** | GHO-specific subgraph on The Graph's decentralized network (migrated from hosted service). Slug: `gho-mainnet`. Requires API key. |
| **CCIP Subgraph** | `https://thegraph.com/explorer/subgraphs/E11p8T4Ff1DHZbwSUC527hkUb5innVMdTuP6A2s1xtm1` |

**Reserve breakdown available:** Yes — per-facilitator bucket levels (how much GHO each facilitator has minted), plus GSM stablecoin balances. Full Aave V3 collateral breakdown requires reading all user positions.
**Update frequency:** Real-time on-chain.
**Authentication:** None for on-chain reads. Subgraph requires The Graph API key.
**Best approach for adapter:** `onchain-evm` adapter calling `getFacilitatorsList()` + `getFacilitatorBucket()` on GHO token to get per-facilitator minting breakdown, plus GSM contract balances. This gives a high-level collateral composition (Aave V3 facilitator %, GSM USDC %, GSM USDT %, CCIP %, FlashMint %).
**Feasibility: HIGH** — Well-documented on-chain contracts with clean read functions. GHO's facilitator model is ideal for a simple adapter.

---

### USDD (Tron DAO Reserve)

**Pharos ID:** `usdd-tron-dao-reserve`
**Classification:** crypto-backed, centralized-dependent

| Source | Details |
|--------|---------|
| **usdd.io dashboard** | Displays real-time collateral ratio and reserve assets. No documented REST API found. JavaScript-rendered — needs browser inspection for network requests. |
| **On-chain: TRON vaults** | TRX-A, TRX-B, TRX-C, sTRX-A, SA001-A vaults on TRON. Contract addresses viewable on usdd.io. |
| **On-chain: Ethereum PSM** | PSM-USDT-A and SA001-A on Ethereum. PSM holds USDT and USDC reserves. |
| **On-chain: BNB Chain PSM** | PSM-USDT-A on BNB Chain. |
| **docs.usdd.io** | Technical documentation — vault types and mechanics documented but no API reference. |
| **DefiLlama** | Supply/chain data only. |

**Reserve breakdown available:** Yes — vault-level on-chain data across TRON, Ethereum, and BNB Chain.
**Update frequency:** Real-time on-chain.
**Authentication:** None.
**Best approach for adapter:** Multi-chain challenge. Would need: (1) inspect usdd.io network traffic to find their aggregation API, or (2) read vault contract balances on TRON (requires Tron RPC, which is non-EVM) + Ethereum + BNB Chain. The TRON component makes this significantly harder than EVM-only coins.
**Feasibility: LOW** — TRON is non-EVM (no existing adapter support), and the usdd.io dashboard doesn't expose a documented API. Would require building Tron RPC support or finding a hidden aggregation endpoint.

---

### USD0 (Usual)

**Pharos ID:** `usd0-usual`
**Classification:** rwa-backed (note: classified as RWA in Pharos, not crypto-backed)

| Source | Details |
|--------|---------|
| **DaoCollateral contract** | `0xde6e1F680C4816446C8D515989E2358636A38b04` — manages minting/redemption of USD0 against RWA collateral. |
| **Collateral Treasury** | `0xdd82875f0840AAD58a455A70B88eEd9F59ceC7c7` — holds collateral assets. Can query ERC-20 balances of USYC, USDtb, M, etc. |
| **RegistryContract** | `0x0594cb5ca47eFE1Ff25C7B8B43E221683B4Db34c` — registry of all approved collateral. |
| **TokenMapping** | `0x43882C864a406D55411b8C166bCA604709fDF624` — maps collateral tokens. |
| **Known collateral tokens** | USYC (Hashnote): `0x136471a34f6ef19fE571EFFC1CA711fdb8E49f2b`, UsualM (wrapped M0): `0x4Cbc25559DbBD1272EC5B64c7b5F48a2405e6470`, UsualUSDtb: `0x58073531a2809744D1bF311D30FD76B27D662abB` |
| **Chainlink Proof of Reserve** | On-chain verification via Chainlink PoR integration. |
| **Chainlink Oracle contracts** | USD0 Oracle: `0x7e891DEbD8FA0A4Cf6BE58Ddff5a8ca174FebDCB` |
| **Full deployment list** | `https://tech.usual.money/smart-contracts/contract-deployments` |

**Reserve breakdown available:** Yes — query ERC-20 balances of known collateral tokens held by the Treasury contract.
**Update frequency:** Real-time on-chain.
**Authentication:** None.
**Best approach for adapter:** `onchain-evm` adapter reading ERC-20 balances of USYC, UsualM, and UsualUSDtb held at the Treasury address (`0xdd82...`). Price via DefiLlama. Simple and reliable.
**Feasibility: HIGH** — Clean on-chain architecture. Treasury address + known collateral token addresses = straightforward ERC-20 balance reads.

---

### USR (Resolv)

**Pharos ID:** `usr-resolv`
**Classification:** crypto-backed, centralized-dependent

| Source | Details |
|--------|---------|
| **Apostro Proof of Reserves dashboard** | `https://info.apostro.xyz/resolv-reserves` — tracks long/short positions, margin, net exposure. Data is server-rendered (Next.js SSR with embedded JSON), not fetched via client-side API. |
| **On-chain contracts** | USR: `0x66a1e37c9b0eaddca17d3662d6c05f4decf3e110`, RLP: `0x4956b52aE2fF65D74CA2d61207523288e4528f96`, stUSR: `0x6c8984bc7DBBeDAf4F6b2FD766f16eBB7d10AAb4`, wstUSR: `0x1202F5C7b4B9E47a1A484E8B270be34dbbC75055` |
| **Request managers** | USR Requests Manager: `0xAC85eF29192487E0a109b7f9E40C267a9ea95f2e`, RLP Requests Manager: `0x10f4d4EAd6Bcd4de7849898403d88528e3Dfc872` |
| **GitHub** | `https://github.com/resolv-im/resolv-contracts-public` — deployed contract addresses |
| **DefiLlama** | `https://defillama.com/protocol/resolv` — TVL tracking |

**Reserve breakdown available:** Partial — Apostro dashboard shows position-level data (ETH long, futures short, margin, etc.) but is SSR-rendered. On-chain contracts show token supply/state but not CEX collateral positions.
**Update frequency:** Apostro dashboard appears to update hourly. On-chain is real-time.
**Authentication:** None for public dashboard. CEX position data is off-chain.
**Best approach for adapter:** Scrape the Apostro dashboard's SSR JSON (embedded in page HTML as `__NEXT_DATA__`), or inspect for undocumented Apostro API endpoints. The delta-neutral nature (ETH collateral + short futures on CEX) means full reserve data requires both on-chain and off-chain sources.
**Feasibility: LOW-MEDIUM** — Delta-neutral strategies inherently have off-chain components (CEX futures positions) that cannot be verified purely on-chain. Apostro dashboard is the best available source but has no documented API.

---

## TIER 2

### DOLA (Inverse Finance)

**Pharos ID:** `dola-inverse-finance`
**Classification:** crypto-backed, centralized-dependent

| Source | Details |
|--------|---------|
| **Transparency portal** | `https://www.inverse.finance/transparency/dola` — real-time DOLA backing sources. Updates every few minutes from on-chain. |
| **Feds & Income page** | `https://www.inverse.finance/transparency/feds` — tracks supply expansion/contraction across FiRM Fed, PSM Fed, DEX Feds. |
| **inverse-api (archived)** | [github.com/InverseFinance/inverse-api](https://github.com/InverseFinance/inverse-api) — AWS Lambda endpoints including `tvl` (TVL with product breakdown), `markets` (Anchor APY, liquidity, assets). **Archived Aug 2021** — likely superseded by newer internal API. |
| **DOLA token** | `0x865377367054516e17014CcDed1e7d814EDC9ce4` on Ethereum |
| **FiRM contracts** | Per-market collateral escrows. Each FiRM market has its own contract with collateral data readable on-chain. |
| **DefiLlama** | `https://defillama.com/protocol/inverse-finance-firm` — TVL data |

**Reserve breakdown available:** Yes — FiRM market-level breakdown (sUSDe, sUSDS, WETH, WBTC, INV, etc.) visible on transparency portal.
**Update frequency:** Minutes (transparency portal), real-time (on-chain).
**Authentication:** None.
**Best approach for adapter:** Inspect transparency portal network requests to find the JSON API backing it. Given it updates every few minutes with on-chain data, there must be a backend API. If no API found, read FiRM market contract balances on-chain.
**Feasibility: MEDIUM** — Good transparency infrastructure but no documented public API. Would need to reverse-engineer the transparency portal's backend or build FiRM on-chain reads.

---

### sUSD (Synthetix)

**Pharos ID:** `susd-synthetix`
**Classification:** crypto-backed, centralized-dependent

| Source | Details |
|--------|---------|
| **Synthetix subgraph** | [github.com/Synthetixio/synthetix-subgraph](https://github.com/Synthetixio/synthetix-subgraph). Available on mainnet and Optimism via The Graph. |
| **synthetix-data npm** | `@synthetixio/queries` — TypeScript library querying The Graph. Methods: `snx.debtSnapshot`, `snx.aggregateActiveStakers`. |
| **Staking dApp** | `https://staking.synthetix.io/debt` — debt pool composition view. |
| **STP-13 V3 API** | Proposed canonical Synthetix V3 API — may or may not be deployed yet. |
| **On-chain: V3 Core** | Vault/pool/market architecture. Users deposit collateral into vaults → pools → markets. |
| **IAddressResolver** | `ReadProxyAddressResolver` resolves system contracts (Synthetix, SynthetixState, etc.). |

**Reserve breakdown available:** Partial — debt pool composition and staker data via subgraph. V3 vault collateral readable on-chain.
**Update frequency:** Real-time on-chain; subgraph indexed continuously.
**Authentication:** Subgraph may require The Graph API key.
**Best approach for adapter:** Synthetix V3 collateral (SNX, ETH, USDC/stataUSDC) is on-chain. Read V3 core contracts for vault collateral totals.
**Feasibility: MEDIUM** — V3 architecture is complex (vaults → pools → markets), and sUSD is in a transitional state (V2→V3 migration, prolonged depeg). Data sources exist but require understanding the V3 contract topology.

---

### MIM (Abracadabra)

**Pharos ID:** `mim-abracadabra`
**Classification:** crypto-backed, centralized-dependent

| Source | Details |
|--------|---------|
| **Cauldron contracts** | Each cauldron is a separate contract per collateral type. On-chain reads: `totalCollateralShare()`, `totalBorrow()`, `collateral()`, `COLLATERIZATION_RATE()`. |
| **Dev docs** | `https://dev.abracadabra.money/core-contracts/cauldrons/cauldron-v4` — full ABI documentation. |
| **abracadabra-subgraph** | GitHub repo `Abracadabra-money/abracadabra-subgraph` — GraphQL queries for on-chain data. |
| **DefiLlama** | `https://defillama.com/protocol/abracadabra` — TVL with token breakdown. |
| **MIM Treasury** | `0xDF2C270f610Dc35d8fFDA5B453E74db5471E126B` on Ethereum. |
| **MIM token** | Ethereum: `0x99D8a9C45b2ecA8864373A26D1459e3Dff1e17F3`, Arbitrum: `0xFEa7a6a0B346362BF88A9e4A88416B77a57D6c2A` |

**Reserve breakdown available:** Yes — per-cauldron collateral breakdown. Multi-chain (Ethereum, Arbitrum, Fantom, Avalanche, BSC, etc.).
**Update frequency:** Real-time on-chain.
**Authentication:** None.
**Best approach for adapter:** Multi-cauldron on-chain reader. For each active cauldron: read `collateral()` (what token), `totalCollateralShare()` (how much). Requires knowing all active cauldron addresses per chain. DefiLlama TVL adapter likely already does this — check if their protocol TVL breakdown is accessible.
**Feasibility: MEDIUM** — Well-documented on-chain data, but multi-chain and many cauldrons. Could start with Ethereum+Arbitrum (majority of TVL) and use DefiLlama TVL breakdown as validation.

---

### HONEY (Berachain)

**Pharos ID:** `honey-berachain`
**Classification:** crypto-backed, centralized-dependent
**Current adapter:** `collateral-positions-api` (already configured)

| Source | Details |
|--------|---------|
| **HoneyFactory** | `0xA4aFef880F5cE1f63c9fb48F661E27F8B4216401` on Berachain mainnet |
| **HONEY Token** | `0xFCBD14DC51f0A4d49d5E53C2E0950e0bC26d0Dce` |
| **Collateral types** | USDT0, USDC, pyUSD, USDe. Per-vault architecture. |

**Feasibility: DONE** — Already has live adapter.

---

### lisUSD (Lista DAO)

**Pharos ID:** `lisusd-lista`
**Classification:** crypto-backed, centralized-dependent

| Source | Details |
|--------|---------|
| **On-chain: BNB Chain** | CDP contracts: Interaction (proxy), GemJoin (treasury), Vat (core accounting). MakerDAO-fork architecture. |
| **GitHub** | `https://github.com/lista-dao/lista-dao-contracts` — contract source and addresses. |
| **DefiLlama** | `https://defillama.com/protocol/lista-dao` — TVL tracking. |
| **Docs** | `https://docs.bsc.lista.org/for-developer/collateral-debt-position/mechanics` |

**Reserve breakdown available:** Yes — Vat ilk-level data on BNB Chain. Collateral types: slisBNB, WBETH, ezETH, PancakeSwap LP tokens.
**Update frequency:** Real-time on-chain.
**Authentication:** None.
**Best approach for adapter:** `onchain-evm` reading BNB Chain Vat contract's ilk data. Similar to how a MakerDAO adapter would work. Need contract addresses from their GitHub.
**Feasibility: MEDIUM** — MakerDAO-fork architecture is well-understood, but runs on BNB Chain (need BSC RPC). Collateral types are diverse.

---

### NECT (BeraBorrow)

**Pharos ID:** `nect-beraborrow`
**Classification:** crypto-backed, centralized-dependent

| Source | Details |
|--------|---------|
| **On-chain: Berachain** | Multi-collateral "Dens" (vaults). Supports iBGT, Berachain native tokens, LSDs, LP positions. |
| **DefiLlama** | `https://defillama.com/protocol/beraborrow` — TVL ~$390M. |
| **Docs** | `https://beraborrow.gitbook.io/docs` |

**Reserve breakdown available:** Yes — per-Den collateral on-chain.
**Update frequency:** Real-time on-chain.
**Authentication:** None.
**Best approach for adapter:** On-chain reads of Den contracts on Berachain. Berachain is EVM-compatible.
**Feasibility: MEDIUM** — EVM-compatible chain, but need to discover Den contract addresses and read functions. Berachain RPC support needed.

---

### GYD (Gyroscope)

**Pharos ID:** `gyd-gyroscope`
**Classification:** crypto-backed, centralized-dependent

| Source | Details |
|--------|---------|
| **On-chain** | Reserve vaults deploy assets into Gyroscope CLPs (Concentrated Liquidity Pools). `gyd-core` contracts on Ethereum. |
| **GitHub** | `https://github.com/gyrostable/gyd-core` — reserve manager and vault contracts. |
| **Docs** | `https://docs.gyro.finance/gyd/how-it-works/reserve.html` |

**Reserve breakdown available:** Yes — vault-level on-chain data.
**Update frequency:** Real-time on-chain.
**Authentication:** None.
**Best approach for adapter:** On-chain reads of Gyroscope reserve vault contracts. Need to identify deployed addresses from docs or GitHub.
**Feasibility: MEDIUM** — Small protocol, clean architecture, but needs contract address discovery.

---

### HYUSD (Hylo / Reserve Protocol)

**Pharos ID:** `hyusd-hylo`
**Classification:** crypto-backed, decentralized

| Source | Details |
|--------|---------|
| **Reserve Protocol FacadeRead contract** | `FacadeRead.primeBasket()` returns the current basket composition. `FacadeRead.backupConfig()` returns emergency collateral config. Standard across all RTokens. |
| **RToken contract** | `basketHandler()` and `backingManager()` provide basket and collateral data. |
| **Collateral plugins** | Each basket component has a collateral plugin with `status()` (SOUND/IFFY/DISABLED) and exchange rate views. |
| **Deployed addresses** | In `docs/plugin-addresses.md` of the [Reserve Protocol GitHub](https://github.com/reserve-protocol/protocol). |
| **Developer docs** | `https://reserve.org/protocol/smart_contracts/` |

**Reserve breakdown available:** Yes — basket composition from `primeBasket()`. Current backing includes Compound USDC, Aave USDC, Stargate positions (Base chain).
**Update frequency:** Real-time on-chain.
**Authentication:** None.
**Best approach for adapter:** `onchain-evm` calling `FacadeRead.primeBasket()` to get basket composition and weights. Works for any RToken on Reserve Protocol. Could be reusable for other Reserve Protocol RTokens.
**Feasibility: HIGH** — Reserve Protocol has excellent on-chain introspection. `FacadeRead` is specifically designed for external reads. Base chain (L2) is EVM-compatible.

---

### eUSD (Lybra Finance)

**Pharos ID:** `eusd-electronic-usd`
**Classification:** crypto-backed, centralized-dependent

| Source | Details |
|--------|---------|
| **eUSD token contract** | `0x97de57ec338ab5d51557da3434828c5dbfada371` on Ethereum. On-chain views: `totalDepositedEther`, `totalEUSDCirculation`, `depositedEther[provider]`, `borrowed[provider]`. |
| **Vault contracts** | LybraStETHVault (stETH → eUSD), LybraWstETHVault (WstETH → peUSD), LybraRETHVault (RETH → peUSD), LybraWbETHVault (WBETH → peUSD). |
| **Oracle** | Uses Liquity ETH:USD price feed via `_etherPrice()`. |

**Reserve breakdown available:** Yes — `totalDepositedEther` gives total ETH/LST collateral. Per-vault breakdown available.
**Update frequency:** Real-time on-chain.
**Authentication:** None.
**Best approach for adapter:** `onchain-evm` reading `totalDepositedEther` and `totalEUSDCirculation` from the eUSD contract. For per-vault breakdown, query each vault contract. Simple and effective.
**Feasibility: HIGH** — Clean on-chain data. Single chain (Ethereum). Simple contract reads.

---

### FRAX / FRXUSD

**Pharos IDs:** `frax-frax` (RWA-backed), `frxusd-frax` (RWA-backed)
**Note:** Both are classified as RWA-backed in Pharos, not crypto-backed. FRAX is fully collateralized by fiat/T-bills since FIP-188. FRXUSD is backed by tokenized T-bills/RWA through enshrined custodians.

| Source | Details |
|--------|---------|
| **Chaos Labs Proof of Reserves** | `https://oracles.chaoslabs.xyz/por-feeds/frxusd_por` — independent attestations of frxUSD backing. Behind Cloudflare challenge. |
| **Enshrined custodian contracts** | On-chain custodian addresses for BUIDL (Securitize), USTB (Superstate), USCC, JTRSY (Centrifuge), WTGXX (WisdomTree), AUSD (Agora), USDC (Circle). Each has a `frxUSDCustodian` contract. |
| **On-chain: Frax transparency** | `https://frax.com/transparency` |

**Reserve breakdown available:** Yes — per-custodian on-chain balances.
**Feasibility: MEDIUM** — RWA-backed rather than crypto-backed, but on-chain custodian contracts allow reserve verification. Lower priority since not crypto-backed.

---

### USDA (Avalon Labs)

**Pharos ID:** `usda-avalon`
**Classification:** crypto-backed, centralized-dependent

| Source | Details |
|--------|---------|
| **USDa token** | `0x8a60e489004ca22d775c5f2c657598278d17d9c2` on Ethereum (LayerZero OFT). |
| **Custodians** | Cobo, Ceffu, Coinbase Prime — institutional custody. |
| **DefiLlama** | `https://defillama.com/protocol/avalon-usda` — TVL data. |
| **Docs** | `https://docs.avalonfinance.xyz` |

**Reserve breakdown available:** Very limited — BTC collateral held by institutional custodians (off-chain). 200% overcollateralization ratio claimed but not verifiable on-chain.
**Feasibility: NONE** — CeDeFi/custodial model with off-chain BTC reserves. No on-chain or API-accessible reserve data.

---

### USDB (Blast)

**Pharos ID:** `usdb-blast`
**Classification:** crypto-backed, centralized-dependent

| Source | Details |
|--------|---------|
| **Backing** | USDB is 100% backed by sDAI (MakerDAO's savings DAI) on Ethereum L1. Auto-rebasing on Blast L2. |
| **On-chain: Blast bridge** | The bridge contract on Ethereum L1 holds sDAI. Balance readable on-chain. |
| **Non-rebasing wrapper** | nrUSDB wraps USDB for contracts that don't support rebasing. |

**Reserve breakdown available:** Yes, trivially — USDB is single-asset backed (100% sDAI). The L1 bridge contract holds the sDAI.
**Update frequency:** Real-time on-chain (Ethereum L1).
**Authentication:** None.
**Best approach for adapter:** `single-asset` or `erc4626-single-asset` adapter reading sDAI balance held by Blast's L1 bridge contract on Ethereum. Very simple.
**Feasibility: HIGH** — Single-asset backing (sDAI), single contract to read on Ethereum L1. Just need the bridge contract address.

---

### OUSD (Origin Protocol)

**Pharos ID:** `ousd-origin-protocol`
**Classification:** crypto-backed, centralized-dependent

| Source | Details |
|--------|---------|
| **Collateral API** | **`GET https://api.originprotocol.com/api/v2/ousd/collateral`** — Returns backing assets and balances. JSON response with asset names and totals. |
| **Strategies API** | **`GET https://api.originprotocol.com/api/v2/ousd/strategies?structured`** — Returns yield strategies with vault holdings, TVL, asset allocations. |
| **APY API** | `GET https://api.originprotocol.com/api/v2/ousd/apr/trailing/{days}` — Historical yield data. |
| **GitHub** | `https://github.com/OriginProtocol/origin-dollar` |
| **Full API docs** | `https://docs.originprotocol.com/registry/api` |

**Reserve breakdown available:** Yes — per-asset collateral breakdown via dedicated API endpoint.
**Update frequency:** Unknown (likely hourly or more frequent).
**Authentication:** None documented ("not intended for widespread use" but no auth mentioned).
**Best approach for adapter:** `http-json` adapter fetching `https://api.originprotocol.com/api/v2/ousd/collateral`. Possibly the cleanest data source in this entire research.
**Feasibility: HIGH** — Documented JSON API with collateral breakdown. No auth required. Perfect for an `http-json` adapter.

---

## Summary: Feasibility Rankings

### HIGH Feasibility (ready for adapter implementation)

| Coin | Adapter Type | Data Source | Notes |
|------|-------------|-------------|-------|
| **OUSD** | `http-json` | `api.originprotocol.com/api/v2/ousd/collateral` | Best source found — documented JSON API with collateral breakdown |
| **GHO** | `onchain-evm` | GHO Token `getFacilitatorsList()` + `getFacilitatorBucket()` + GSM balances | Clean on-chain facilitator model |
| **USD0** | `onchain-evm` | Treasury `0xdd82...` ERC-20 balances (USYC, UsualM, UsualUSDtb) | Simple treasury balance reads (note: RWA-backed in Pharos) |
| **eUSD** | `onchain-evm` | eUSD contract `totalDepositedEther`, per-vault reads | Clean single-chain on-chain data |
| **USDB** | `single-asset` | Blast L1 bridge sDAI balance | Trivial — single asset backing |
| **HYUSD** | `onchain-evm` | Reserve Protocol `FacadeRead.primeBasket()` | Excellent on-chain introspection; reusable pattern |

### MEDIUM Feasibility (viable but requires more work)

| Coin | Adapter Type | Challenge |
|------|-------------|-----------|
| **DAI/USDS** | `http-json` or `onchain-evm` | Need to reverse-engineer Block Analitica API or build multi-ilk on-chain reader |
| **DOLA** | `http-json` or `onchain-evm` | Need to discover transparency portal backend API or read FiRM market contracts |
| **MIM** | `onchain-evm` | Multi-chain, many cauldrons — need address registry |
| **sUSD** | `onchain-evm` | V3 architecture complexity, transitional state |
| **lisUSD** | `onchain-evm` | MakerDAO-fork on BNB Chain — need BSC RPC |
| **NECT** | `onchain-evm` | Berachain — need contract addresses and RPC |
| **GYD** | `onchain-evm` | Small protocol — need contract address discovery |
| **USR** | `http-html` or `http-json` | Delta-neutral = off-chain components; Apostro dashboard SSR |
| **FRXUSD** | `onchain-evm` | RWA-backed; Chaos Labs PoR behind Cloudflare |

### LOW / NONE Feasibility

| Coin | Reason |
|------|--------|
| **USDD** | TRON (non-EVM) primary chain; no documented API |
| **USDA (Avalon)** | CeDeFi — BTC held by custodians off-chain; no API |

### Already Implemented

| Coin | Adapter |
|------|---------|
| **HONEY** | `collateral-positions-api` |

---

## Recommended Implementation Order

1. **OUSD** — Lowest effort, highest data quality. Documented JSON API.
2. **GHO** — High value (top crypto-backed), clean on-chain model.
3. **USD0** — Simple treasury balance reads (though note: RWA-backed, not crypto-backed).
4. **eUSD** — Simple on-chain reads, single chain.
5. **USDB** — Trivial single-asset read.
6. **HYUSD** — Reserve Protocol FacadeRead — reusable pattern.
7. **DAI/USDS** — High value but needs API discovery or complex on-chain reads.
8. **DOLA** — Good transparency, needs API discovery.
9. **MIM** — Multi-chain complexity.
10. **GYD, NECT, lisUSD, sUSD** — Smaller coins, higher complexity.

---

## Key Contract Addresses Reference

| Coin | Key Contract | Address | Chain |
|------|-------------|---------|-------|
| GHO Token | GhoToken | `0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f` | Ethereum |
| GHO | UiGhoDataProvider | `0x379c1EDD1A41218bdbFf960a9d5AD2818Bf61aE8` | Ethereum |
| GHO | GSM USDC | `0xFeeb6FE430B7523fEF2a38327241eE7153779535` | Ethereum |
| GHO | GSM USDT | `0x535b2f7C20B9C83d70e519cf9991578eF9816B7B` | Ethereum |
| GHO | GSM Registry | `0x167527DB01325408696326e3580cd8e55D99Dc1A` | Ethereum |
| USD0 | USD0 Token | `0x73A15FeD60Bf67631dC6cd7Bc5B6e8da8190aCF5` | Ethereum |
| USD0 | DaoCollateral | `0xde6e1F680C4816446C8D515989E2358636A38b04` | Ethereum |
| USD0 | Collateral Treasury | `0xdd82875f0840AAD58a455A70B88eEd9F59ceC7c7` | Ethereum |
| USD0 | RegistryContract | `0x0594cb5ca47eFE1Ff25C7B8B43E221683B4Db34c` | Ethereum |
| USD0 | USYC (Hashnote) | `0x136471a34f6ef19fE571EFFC1CA711fdb8E49f2b` | Ethereum |
| USD0 | UsualM (wrapped M) | `0x4Cbc25559DbBD1272EC5B64c7b5F48a2405e6470` | Ethereum |
| USD0 | UsualUSDtb | `0x58073531a2809744D1bF311D30FD76B27D662abB` | Ethereum |
| eUSD | eUSD Token | `0x97de57ec338ab5d51557da3434828c5dbfada371` | Ethereum |
| USR | USR Token | `0x66a1e37c9b0eaddca17d3662d6c05f4decf3e110` | Ethereum |
| USR | RLP Token | `0x4956b52aE2fF65D74CA2d61207523288e4528f96` | Ethereum |
| USR | stUSR | `0x6c8984bc7DBBeDAf4F6b2FD766f16eBB7d10AAb4` | Ethereum |
| HONEY | HoneyFactory | `0xA4aFef880F5cE1f63c9fb48F661E27F8B4216401` | Berachain |
| HONEY | HONEY Token | `0xFCBD14DC51f0A4d49d5E53C2E0950e0bC26d0Dce` | Berachain |
| HYUSD | FacadeRead | Check Reserve Protocol `docs/plugin-addresses.md` | Base |
| MIM | MIM Treasury | `0xDF2C270f610Dc35d8fFDA5B453E74db5471E126B` | Ethereum |
| MIM | MIM Token | `0x99D8a9C45b2ecA8864373A26D1459e3Dff1e17F3` | Ethereum |
| DOLA | DOLA Token | `0x865377367054516e17014CcDed1e7d814EDC9ce4` | Ethereum |
| USDa | USDa Token | `0x8a60e489004ca22d775c5f2c657598278d17d9c2` | Ethereum |
| DAI | DAI Token | `0x6b175474e89094c44da98b954eedeac495271d0f` | Ethereum |
| DAI | Vat | `0x35D1b3F3D7966A1DFe207aa4514C12a259A0492B` | Ethereum |
| USDS | USDS Token | `0xdc035d45d973e3ec169d2276ddab16f1e407384f` | Ethereum |
