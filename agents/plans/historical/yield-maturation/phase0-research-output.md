# Phase 0 Research Output

**Date:** 2026-03-09
**DL Pools API snapshot:** 19,179 total pools (3,725 stablecoin pools)

---

## Part A: Pool Map Audit

**Summary:** 40 yield-bearing coins identified. 25 have YIELD_POOL_MAP entries, 3 are explicitly noted as having no DL pool (BUIDL, YLDS, USDB). 12 are missing and need pool assignments. Zero stale UUIDs -- all 25 existing entries resolve to valid DL pools.

### Existing Entries (all valid)

All 25 current YIELD_POOL_MAP entries were verified against the live DL pools response. No stale UUIDs found.

| Coin ID | Symbol | Project | Chain | TVL | APY |
|---------|--------|---------|-------|-----|-----|
| usde-ethena | SUSDE | ethena-usde | Ethereum | $3,534M | 3.47% |
| usds-sky | SUSDS | sky-lending | Ethereum | $6,063M | 4.00% |
| syrupusdc-maple | USDC | maple | Ethereum | $3,011M | 4.53% |
| syrupusdt-maple | USDT | maple | Ethereum | $1,390M | 4.21% |
| usyc-hashnote | USDYC | ondo-yield-assets | Ethereum | $388M | 3.55% |
| gho-aave | SGHO | aave-v3 | Ethereum | $276M | 5.13% |
| usdy-ondo-finance | USDY | ondo-yield-assets | Ethereum | $199M | 3.55% |
| iusd-infinifi | SIUSD | infinifi | Ethereum | $122M | 5.12% |
| reusd-re-protocol | STUSR | resolv | Ethereum | $103M | 2.82% |
| dai-makerdao | SDAI | sdai | Gnosis | $87M | 4.71% |
| usdf-falcon | SUSDF | falcon-finance | Ethereum | $87M | 5.73% |
| usdu-unitas | SUSDU | unitas | Solana | $50M | 12.96% |
| crvusd-curve | SCRVUSD | crvusd | Ethereum | $40M | 7.04% |
| yusd-aegis | YUSD | aegis | Ethereum | $36M | 5.52% |
| fxusd-f-x-protocol | FXUSDSTABILITYPOOLV2.0 | fx-protocol | Ethereum | $31M | 3.86% |
| frxusd-frax | SFRXUSD | frax | Ethereum | $26M | 4.25% |
| tbill-openeden | TBILL | openeden-tbill | Ethereum | $26M | 3.11% |
| aid-gaib | SAID | gaib | Ethereum | $16M | 10.92% |
| zchf-frankencoin | ZCHF | frankencoin | Ethereum | $11M | 3.75% |
| usp-pikudao | USP | merkl | Ethereum | $11M | 26.17% |
| aznd-mu-digital | LOAZND | mu-digital | Monad | $7M | 5.53% |
| ousd-origin-protocol | OUSD | origin-dollar | Ethereum | $7M | 4.46% |
| dola-inverse-finance | SDOLA | inverse-finance-firm | Ethereum | $6M | 6.98% |
| bold-liquity | YBOLD | yearn-finance | Ethereum | $5M | 8.19% |
| yousd-yield-optimizer | YOUSD | pendle | Base | $1M | 8.44% |

### Stale UUIDs (pool no longer in DL response)

None. All 25 existing UUIDs are valid.

### Missing Coins (yield-bearing, no pool map entry)

| Coin ID | Symbol | Recommended Pool UUID | Protocol | Chain | TVL | APY | Notes |
|---------|--------|-----------------------|----------|-------|-----|-----|-------|
| usdai-usd-ai | sUSDai | `712ce948-bd9e-4f4a-8916-b72c447f7578` | usd-ai | Arbitrum | $217M | 7.69% | Native savings pool; highest TVL; already in YIELD_VARIANT_MAP |
| wsrusd-reservoir | wsrUSD | `d646f32f-d5af-4e34-a29f-8ebeea6a8520` | reservoir-protocol | Ethereum | $159M | 4.75% | Native protocol pool; no variant needed (wsrUSD IS the yield token) |
| ousg-ondo-finance | OUSG | `7436db9b-2872-46c8-81a2-da6baff902b7` | ondo-yield-assets | Ethereum | $519M | 3.06% | Native Ondo pool; OUSG is its own NAV token (no wrapper) |
| avusd-avant | savUSD | `2fe112ff-95a5-4ba0-8ee3-a741e6a8f7c9` | merkl | Avalanche | $72M | 0.00% | HOLD pool; APY=0 (merkl doesn't report vault rate). Already in YIELD_VARIANT_MAP |
| nusd-neutrl | sNUSD | `0f38d9a4-8e34-4abc-b9ba-25f326ef7828` | pendle | Ethereum | $41M | 7.54% | No native Neutrl pool exists; Pendle PT-buying pool best proxy. Already in YIELD_VARIANT_MAP |
| msusd-main-street | msUSD | `8a28570f-2316-488a-94a7-67c87e76c1f1` | mainstreet | Ethereum | $29M | 12.00% | Native protocol pool. Already in YIELD_VARIANT_MAP (msY wrapper) |
| yzusd-yuzu | syzUSD | `6174b1d6-8212-4964-95bf-ca9c539864ba` | yuzu-money | Plasma | $28M | 7.31% | Native protocol pool; highest-TVL chain. Already in YIELD_VARIANT_MAP |
| usn-noon | sUSN | `a18a761b-49cd-416d-8342-839cac722094` | morpho-v1 | Ethereum | $10M | 0.00% | No native Noon pool; morpho-v1 has highest TVL but 0% APY (collateral). Already in YIELD_VARIANT_MAP |

#### No DL Pool Available (confirmed)

| Coin ID | Symbol | Reason |
|---------|--------|--------|
| buidl-blackrock | BUIDL | BlackRock/Securitize fund; not tracked by DL Yields. Already has PRICE_DERIVED_FALLBACK. |
| ylds-figure | YLDS | Figure Markets; not tracked by DL Yields. Should add to PRICE_DERIVED_FALLBACK. |
| usdb-blast | USDB | Blast native yield; not tracked by DL Yields. Should add to PRICE_DERIVED_FALLBACK. |
| mtbill-midas | mTBILL | Midas not tracked by DL Yields at all (zero pools). Should add to PRICE_DERIVED_FALLBACK. |
| usd-dinari | USD+ | Dinari not tracked by DL Yields (zero pools). Symbol collision with Overnight Finance USD+. Should add to PRICE_DERIVED_FALLBACK. |
| ustb-superstate | USTB | Superstate only tracks USCC in DL, not USTB. One tiny Aave collateral listing ($394K, 0% APY). Should add to PRICE_DERIVED_FALLBACK. |
| usda-avalon | USDa/sUSDa | No Avalon protocol in DL. sUSDa Pendle pools have only $55K TVL. Should add to PRICE_DERIVED_FALLBACK. |

### Better Matches (higher TVL or more relevant pool available)

No better matches identified. All current mappings point to the appropriate native/protocol pool with the highest TVL on the primary chain.

**Note on DAI:** The current mapping to `sdai` project on Gnosis ($87M) is the only native sDAI pool on DL. Ethereum sDAI pools are only available as collateral on Aave/Spark ($470K/$45K) with 0% APY. The Gnosis pool is correct.

### Quality Concerns

| Coin ID | Current UUID | Concern | Action |
|---------|-------------|---------|--------|
| avusd-avant | (new) | merkl HOLD pool reports 0% APY -- vault rate not reflected | Map it; yield cron will need on-chain rate fallback (Phase 2) |
| usn-noon | (new) | morpho-v1 pool reports 0% APY -- collateral listing | Map it; yield cron will need on-chain rate fallback (Phase 2) |
| nusd-neutrl | (new) | Pendle pool APY includes Pendle rewards, not just sNUSD base rate | Acceptable; Pendle PT-buying APY approximates native yield |

---

## Part B: Lending Protocol Candidates

### Current Allowlist (17 protocols)

**Tier 1:** aave-v3, compound-v3, sparklend, spark-savings, maple, yearn-finance
**Tier 2:** fluid-lending, euler-v2, venus-core-pool, kamino-lend, morpho-v1, pendle
**Tier 3:** justlend, openeden-usdo, multipli.fi, jupiter-lend, stables-labs-usdx

### Tier 1 Additions (battle-tested, $100M+ total TVL)

| Protocol Slug | All-Pools TVL | Stablecoin Pool TVL (tracked chains) | Top Stablecoin Pools | Chains |
|---------------|---------------|--------------------------------------|----------------------|--------|
| dolomite | $284M | $83M | USD1@ETH($64M), USDC@ETH($15M), USDC@ARB($2.4M) | Ethereum, Arbitrum |
| benqi-lending | $133M | $8M | USDC@AVAX($6.6M), USDT@AVAX($1.2M) | Avalanche |
| compound-v2 | $112M | $29M | USDT@ETH($20M), DAI@ETH($5.8M), USDC@ETH($3.1M) | Ethereum |

### Tier 2 Additions (established, $10M-100M total TVL)

| Protocol Slug | All-Pools TVL | Stablecoin Pool TVL (tracked chains) | Top Stablecoin Pools | Chains |
|---------------|---------------|--------------------------------------|----------------------|--------|
| curve-llamalend | $59M | $54M | crvUSD@ETH($32.5M), crvUSD@ETH($7.8M) | Ethereum |
| exactly | $32M | $19M | USDC@OP($1.7M x6 pools) | Optimism |
| silo-v2 | $46M | $18M | siUSD@ETH($8.1M), savUSD@AVAX($4.4M), USDC@ETH($2.8M) | Ethereum, Arbitrum, Avalanche |
| moonwell-lending | $46M | $7M | USDC@Base($7.4M) | Base |
| gains-network | $21M | $14M | USDC@ARB($12.2M), USDC@Base($1.9M) | Arbitrum, Base |
| flux-finance | $43M | $3M | USDT@ETH($1.7M), USDC@ETH($1.4M) | Ethereum |
| lazy-summer-protocol | $45M | $23M | USDC@ETH($14.8M), USDC@ETH($4.6M), USDC@Base($3.6M) | Ethereum, Base |

### Tier 3 Additions (smaller but legitimate, $1M-10M TVL)

None recommended. The Tier 3 candidates found (bracket-vaults, sprinter, parallel-protocol-v3, etc.) are too small or niche to add coverage value beyond what the existing allowlist provides.

### Rejected Candidates

| Protocol | Reason |
|----------|--------|
| merkl | Aggregator/distribution platform, not a lending protocol. Reports HOLD pools for native vault TVL. Not appropriate for lending allowlist. |
| sky-lending | Already effectively covered (sUSDS is in YIELD_POOL_MAP as native yield). |
| ethena-usde | Already covered (sUSDe in YIELD_POOL_MAP). |
| ondo-yield-assets | Already covered (USYC, USDY, OUSG in YIELD_POOL_MAP). |
| wildcat-protocol | Private/permissioned credit markets (Hyperliquid); not public lending. |
| strata-markets | Institutional credit market; not public lending. |
| superstate-uscc | Tokenized fund (USCC), not a lending protocol. |
| usd-ai | Native yield protocol (sUSDai); not a lending protocol. |
| reservoir-protocol | Native yield protocol (wsrUSD); not a lending protocol. |
| infinifi | Native yield protocol (siUSD); not a lending protocol. |
| cap | Single proprietary stablecoin (stcUSD); not a lending protocol. |
| zerobase-cedefi | CeDeFi hybrid; centralization concerns. |
| goldfinch | Real-world lending; undercollateralized. Previous exploit history. |
| autofinance | Yield optimizer, not direct lending; adds abstraction risk. |
| resupply | Meta-lending on Curve; adds abstraction layer. |
| upshift | Institutional yield product; not public lending. |
| convex-finance | Yield optimizer for Curve; not direct lending. |
| avantis | Perpetuals protocol (USDC vault); not traditional lending. |
| yo-protocol | Relatively new; unaudited. |
| 3jane-lending | New protocol; limited track record. |
| beefy | Yield aggregator, not direct lending. |
| vesper | Yield aggregator, not direct lending. |
| lista-lending | BSC-only; limited to Lista ecosystem stablecoins. |
| harvest-finance | Previous exploit history (2020). |
| across | Bridge protocol with liquidity pools; not lending. |
| native-credit-pool | Credit pool mechanism; limited track record. |
| gauntlet | Vault curator, not a lending protocol. |

---

## TICKET-001 Amendment: YIELD_POOL_MAP + YIELD_VARIANT_MAP Updates

### Code for TICKET-001

```typescript
// === YIELD_POOL_MAP additions ===

// OUSG - ondo-yield-assets native, Ethereum, $519M TVL, ~3.1% APY
"ousg-ondo-finance": "7436db9b-2872-46c8-81a2-da6baff902b7",

// USD.AI -> sUSDai - usd-ai native savings, Arbitrum, $217M TVL, ~7.7% APY
"usdai-usd-ai": "712ce948-bd9e-4f4a-8916-b72c447f7578",

// wsrUSD - reservoir-protocol native, Ethereum, $159M TVL, ~4.8% APY
"wsrusd-reservoir": "d646f32f-d5af-4e34-a29f-8ebeea6a8520",

// avUSD -> savUSD - merkl HOLD pool, Avalanche, $72M TVL, APY via on-chain rate
"avusd-avant": "2fe112ff-95a5-4ba0-8ee3-a741e6a8f7c9",

// Neutrl USD -> sNUSD - pendle PT-buying pool, Ethereum, $41M TVL, ~7.5% APY
"nusd-neutrl": "0f38d9a4-8e34-4abc-b9ba-25f326ef7828",

// Main Street USD - mainstreet native pool, Ethereum, $29M TVL, ~12.0% APY
"msusd-main-street": "8a28570f-2316-488a-94a7-67c87e76c1f1",

// Yuzu USD -> syzUSD - yuzu-money native savings, Plasma, $28M TVL, ~7.3% APY
"yzusd-yuzu": "6174b1d6-8212-4964-95bf-ca9c539864ba",

// Noon USN -> sUSN - morpho-v1 collateral, Ethereum, $10M TVL, APY via on-chain rate
"usn-noon": "a18a761b-49cd-416d-8342-839cac722094",

// === PRICE_DERIVED_FALLBACK_IDS additions ===
// Add to the existing Set:
"ylds-figure",     // YLDS - Figure Markets (not tracked in DL Yields)
"usdb-blast",      // USDB - Blast native yield (not tracked in DL Yields)
"mtbill-midas",    // mTBILL - Midas (not tracked in DL Yields)
"usd-dinari",      // USD+ - Dinari (not tracked in DL Yields; symbol collision with Overnight Finance)
"ustb-superstate", // USTB - Superstate (only USCC tracked in DL, not USTB)
"usda-avalon",     // USDa - Avalon (no DL protocol pool; sUSDa Pendle pool too small at $55K)
```

**Note:** No YIELD_VARIANT_MAP changes needed -- all missing coins that use wrappers (usdai-usd-ai, avusd-avant, nusd-neutrl, msusd-main-street, yzusd-yuzu, usn-noon) already have entries in YIELD_VARIANT_MAP.

**Gate update:** After these additions, YIELD_POOL_MAP will have 33/40 yield-bearing coins mapped (threshold: >=15). 7 coins use PRICE_DERIVED_FALLBACK (BUIDL + 6 new). Coverage: 33 pool-mapped + 7 price-derived = 40/40 (100%).

---

## TICKET-002 Amendment: Lending Protocol Allowlist Expansions

### Code for TICKET-002

```typescript
export const LENDING_PROTOCOL_ALLOWLIST = new Set([
  // Tier 1
  "aave-v3",
  "compound-v2",       // NEW: $112M TVL, ETH stablecoin markets
  "compound-v3",
  "dolomite",          // NEW: $284M TVL, ETH+ARB stablecoin markets
  "sparklend",
  "spark-savings",
  "maple",
  "yearn-finance",
  // Tier 2
  "curve-llamalend",   // NEW: $59M TVL, crvUSD lending on ETH
  "exactly",           // NEW: $32M TVL, USDC lending on Optimism
  "euler-v2",
  "fluid-lending",
  "flux-finance",      // NEW: $43M TVL, USDT/USDC on ETH (Ondo ecosystem)
  "gains-network",     // NEW: $21M TVL, USDC vaults on ARB+Base
  "kamino-lend",
  "lazy-summer-protocol", // NEW: $45M TVL, USDC vaults on ETH+Base
  "moonwell-lending",  // NEW: $46M TVL, USDC on Base
  "morpho-v1",
  "pendle",
  "silo-v2",           // NEW: $46M TVL, multi-chain isolated lending
  "venus-core-pool",
  // Tier 3
  "benqi-lending",     // NEW: $133M TVL but only $8M stablecoin; Avalanche-only
  "jupiter-lend",
  "justlend",
  "multipli.fi",
  "openeden-usdo",
  "stables-labs-usdx",
]);
```

**Changes:** +10 protocols (compound-v2, dolomite, curve-llamalend, exactly, flux-finance, gains-network, lazy-summer-protocol, moonwell-lending, silo-v2, benqi-lending). Total: 27 protocols (was 17).

**Note on benqi-lending:** Placed in Tier 3 despite $133M total TVL because only $8M is in stablecoin pools on tracked chains (Avalanche). Its stablecoin coverage value is modest but it fills the Avalanche lending gap.
