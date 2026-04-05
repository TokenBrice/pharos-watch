# Reserve Sync Expansion Research

**Date:** 2026-04-04  
**Scope:** 57 active stablecoins without live reserve sync on Pharos  
**Method:** Checked each coin's website and docs for `llms.txt`, public APIs, and transparency endpoints

---

## Tier 1 — Public REST/GraphQL APIs (no auth, ready to integrate)

These have fully working, unauthenticated APIs returning structured reserve/collateral data:

| Coin | API Endpoint | Data Available | Notes |
|------|-------------|----------------|-------|
| **USD.AI (USDai)** | `https://api.usd.ai` | TVL breakdown, APY, GPU deal book, utilization, integrations | OpenAPI spec at `usd.ai/api/openapi.json`. Verified working. |
| **Origin Dollar (OUSD)** | `https://api.originprotocol.com/api/v2/ousd/*` | Collateral balances, yield strategies, totalSupply, APR, marketCap | `/collateral`, `/strategies`, `/stats/{stat}`. Verified working. |
| **Startale USDSC** | `https://protocol-api.m0.org/graphql` | Collateral (cash, treasuries, token collateral), supply | **Reuse existing `m0` adapter** — USDSC is an M0 extension like M, USDN, CTUSD, MUSD. |
| **River satUSD** | `https://api-v2.satoshiprotocol.org/protocol-info` | TVL, per-chain circulating supply, user count | Verified: ~$288M TVL, per-chain breakdown (BSC, Base, Bob, Arbitrum, etc.) |
| **Moneta USDM** | `https://portal.charli3.io/dev/feeds/usdm-reserves?network=Mainnet` | Reserve verification via Charli3 oracle on Cardano | Also queryable by policy ID via Blockfrost/Koios |

### Priority: USDSC via M0 adapter

The existing `m0` adapter already queries `protocol-api.m0.org/graphql` for 4 coins (M, USDN, CTUSD, MUSD) with source-invariant caching. Adding USDSC requires only a `liveReservesConfig` entry — zero new adapter code.

---

## Tier 2 — On-chain / Subgraph data (queryable, needs adapter work)

| Coin | Data Source | What's Available | Complexity |
|------|------------|------------------|------------|
| **RAI (Reflexer)** | The Graph subgraph | System state, redemption rate/price, total SAFEs, ETH collateral | Subgraph at `thegraph.com/explorer/subgraph/reflexer-labs/rai-mainnet` |
| **eUSD (Reserve Protocol)** | `api.reserve.org` (undocumented) + on-chain | Collateral basket (cUSDCv3, aUSDCv3, cUSDTv3) queryable on-chain | Reserve SDK exists; API is running but undocumented |
| **PikuDAO USP** | Chainlink-compatible oracle + backing wallets | Oracle `0xb52eb...ef3` with `latestRoundData()`, wallets verifiable via DeBank | 24 DeFi yield products across protocols |
| **USSD (Sonic Labs)** | FraxNet balance sheet | Collateral from BlackRock BUIDL, Superstate USTB, WisdomTree WTGXX | `https://net.frax.com/embed/balance-sheet/0x000...fEf` |
| **Honey (Berachain)** | HoneyFactory contract | Collateral: USDC, BYUSD, USDT0, USDe; contract `0xA4aF...6401` | On-chain reads, known contract |
| **Alchemix ALUSD** | Stats dashboard + contracts | `alchemix-stats.com` has live data; contracts documented in GitBook | Client-side rendered dashboard |
| **sUSD (Synthetix)** | `api.synthetix.io` (Swagger) + contracts | Exchange API with Swagger UI; SNX collateral queryable on-chain | API is exchange-focused, not reserve-focused |

---

## Tier 3 — Transparency pages / PDF attestations only

| Coin | Transparency Source | Format |
|------|-------------------|--------|
| **USDH** | `usdh.com/transparency` | Monthly attestation PDFs by BPM LLP |
| **MXNB** | `mxnb.mx/transparency` | Attestation report PDFs + Juno/Bitso API (authenticated) |
| **USDGO** | `usdgo.com/transparency` (SPA-rendered) | Client-rendered page, not fetchable |
| **Kinesis Gold KAU** | `kinesis.money/audits/` | Biannual vault audit PDFs |
| **BRLA Digital** | Notion page | Monthly collateral reporting |
| **Hermetica USDh** | Blog + custodian BTC addresses | Monthly attestations; Ceffu/Copper addresses on mempool.space |

---

## Tier 4 — Authenticated / gated APIs

| Coin | API | Access Model |
|------|-----|-------------|
| **Solstice USX** | `api.solstice.finance/v1/` | API key required; operational (mint/redeem), not data |
| **IDRX** | `docs.idrx.co/api/` | Business account required |
| **MXNB** | `docs.bitso.com/juno/reference` | Authenticated Juno API |
| **Flying Tulip ftUSD** | `api.flyingtulip.com` (referenced) | Not yet live (404 at root) |

---

## Tier 5 — No API or transparency endpoint found

These 30 coins have no discoverable public API, transparency page, or on-chain querying path beyond basic contract reads:

Cap cUSD, Resolv USR, YLDS, Avalon USDa, Astherus USDF, StandX DUSD, CASH, Lista LISUSD, Resupply reUSD, Hylo HYUSD, MIM, Gyroscope GYD, Nectar NECT, Bucket BUCK, Metronome MSUSD, Quill USDQ, Orki USDK, Ebisu ebUSD, JupUSD, MegaUSD, Bima USBD, USDU Finance, dTRINITY dUSD, Alto DUSD, Parallel USDp, USDKG, Frax FPI, ISC, CJPY, Comtech Gold CGO

---

## llms.txt Landscape

### Hand-written / proper llms.txt (on website domain)

| Coin | URL | Quality |
|------|-----|---------|
| **USD.AI** | `usd.ai/llms.txt` | Excellent — full protocol description, API reference, key facts |
| **Kinesis Gold KAU** | `kinesis.money/llms.txt` | Excellent — AI guidance with permitted/disallowed representations |
| **Moneta USDM** | `moneta.global/llms.txt` | Good — protocol description, policy ID, API guidance |
| **PikuDAO USP** | `piku.co/llms.txt` | Good — inline protocol docs with contract addresses |
| **Shade Protocol SILK** | `shadeprotocol.io/llms.txt` | Basic — robots.txt-style URL list for AI crawlers |
| **Ondo OUSG** | `ondo.finance/llms.txt` | Good — all products described with links |
| **yoUSD** | `yo.xyz/llms.txt` | Good — protocol overview, links to SDK llms-full docs |
| **Flying Tulip ftUSD** | `flyingtulip.com/llms.txt` | Rich — all products, API endpoint, links to llms-full.txt |
| **Reserve Protocol eUSD** | `reserve.org/llms.txt` | Good — core concepts, SDK links, protocol repo |

### Auto-generated llms.txt (GitBook/Mintlify docs only)

28 coins have auto-generated llms.txt on their docs subdomain (GitBook or Mintlify table-of-contents format). These are useful for doc discovery but don't contain structured reserve data.

---

## Recommended Implementation Priority

### Quick wins (minimal code, high value)

1. **USDSC (Startale)** — Add `liveReservesConfig` pointing to existing `m0` adapter. Zero new code.
2. **OUSD (Origin Dollar)** — New adapter for `api.originprotocol.com`. Clean REST JSON, collateral + strategies.
3. **River satUSD** — New adapter for Satoshi Protocol API. Single endpoint, clean JSON.
4. **USD.AI (USDai)** — New adapter for `api.usd.ai`. Full OpenAPI spec, TVL + composition.

### Medium effort

5. **RAI (Reflexer)** — Graph Protocol subgraph query for ETH collateral and system state.
6. **Moneta USDM** — Charli3 oracle feed on Cardano (new chain integration path).
7. **eUSD (Reserve Protocol)** — On-chain basket query; undocumented API may also work.
8. **USSD (Sonic Labs)** — Parse FraxNet balance sheet page for RWA collateral breakdown.

### Exploratory

9. **Honey (Berachain)** — On-chain HoneyFactory reads for multi-collateral basket.
10. **Alchemix ALUSD** — Reverse-engineer alchemix-stats.com data sources.
11. **sUSD (Synthetix)** — Investigate `api.synthetix.io` Swagger spec for useful endpoints.
12. **PikuDAO USP** — Chainlink oracle + DeBank wallet verification.
