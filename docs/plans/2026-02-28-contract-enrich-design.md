# Contract Enrichment via DefiLlama Discovery

**Date:** 2026-02-28
**Status:** Approved

## Problem

We track ~145 stablecoins with 499 contract deployments across 68 chains. DefiLlama tracks chain-level supply data for these same stablecoins across 180+ chains. Many of our coins are missing contract entries for chains where they have significant supply.

## Solution

A new `/contract-enrich` skill that:
1. **Discovers gaps** using DefiLlama's chain supply data (1 API call)
2. **Populates addresses** via CoinGecko's `detail_platforms` (existing pattern)
3. **Verifies** each address on block explorers before writing

## Design

### Phase 1: Gap Discovery

**Data source:** `https://stablecoins.llama.fi/stablecoins?includePrices=true`

**Flow:**
1. Fetch DL stablecoins list (single API call)
2. Match each `peggedAsset` to our tracked stablecoins by `llamaId`
3. Extract `chainCirculating` → list of chains with USD supply per chain
4. Apply supply thresholds:
   - USDT, USDC: ≥$10M per chain
   - All other coins: ≥$1M per chain
5. Map DL chain names → internal chain IDs via `DL_CHAIN_MAP`
6. Diff against existing `contracts[]` → produce gap list
7. Print gap report to console

**Gap report format:**
```
=== Contract Enrichment Gap Report ===
142/145 tracked coins matched to DefiLlama entries

USDT (llamaId: 1): 3 missing chains
  - OP Mainnet → optimism ($1.2B supply)
  - Manta → manta ($15M supply)
  - Cronos → [NEW CHAIN] ($50M supply)

USDC (llamaId: 2): 1 missing chain
  - Blast → blast ($180M supply)

...
Total: 47 gaps across 28 coins
  - 41 on known chains (in CHAIN_META)
  - 6 on new chains (need CHAIN_META entry)
  - 3 on unmapped DL chains (need DL_CHAIN_MAP update)
```

The skill pauses here for review before proceeding.

### Phase 2: Population

For each gap (processed coin by coin, alphabetically):

1. **CoinGecko address lookup:** Fetch `/coins/{geckoId}` → extract `detail_platforms[cgPlatform]` → `{contract_address, decimal_place}`
   - Map CG platform → internal chain ID via `CG_PLATFORM_MAP` (reused from contract-populate skill)
   - Skip if CG doesn't have the platform (log it)
   - Skip if decimals are null (flag it)

2. **Block explorer verification:** For EVM chains:
   - Construct URL: `{explorerUrl}/token/{address}`
   - Fetch via `agent-browser` and confirm: page loads, token name/symbol matches
   - For non-EVM chains, verify using chain-specific explorer patterns

3. **Write to stablecoins.ts:**
   - Append new `ContractDeployment` to the coin's `contracts` array
   - Never overwrite existing entries
   - Sort contracts by chain name

4. **New chains:** If chain not in `CHAIN_META`:
   - Auto-add to `src/lib/chains.ts` with explorer URL, EVM chain ID, type, logo placeholder
   - Same pattern as contract-populate skill

**Rate limiting:** Sequential CG requests (~30/min free tier). Explorer verification also sequential.

### DL_CHAIN_MAP

Embedded in the skill. Maps DefiLlama display names to our internal chain IDs.

**Known mappings (82 chains in CHAIN_META):**

| DL Name | Internal ID | Notes |
|---------|-------------|-------|
| Ethereum | ethereum | |
| Arbitrum | arbitrum | |
| Base | base | |
| OP Mainnet | optimism | DL uses "OP Mainnet" |
| Polygon | polygon | |
| Avalanche | avalanche | |
| BSC | bsc | |
| Gnosis | gnosis | |
| Fantom | fantom | |
| Celo | celo | |
| ZKsync Era | zksync | DL uses "ZKsync Era" |
| Sonic | sonic | |
| Sei | sei | |
| World Chain | worldchain | DL uses "World Chain" |
| Unichain | unichain | |
| Ink | ink | |
| Moonriver | moonriver | |
| Kaia | klaytn | Klaytn rebranded to Kaia |
| Plume Mainnet | plume | DL uses "Plume Mainnet" |
| Hyperliquid L1 | hyperevm | DL uses "Hyperliquid L1" |
| Monad | monad | |
| XDC | xdc | |
| Mantle | mantle | |
| Linea | linea | |
| Scroll | scroll | |
| Blast | blast | |
| Mode | mode | |
| Manta | manta | |
| Berachain | berachain | |
| Bob | bob | |
| Fraxtal | fraxtal | |
| Taiko | taiko | |
| Polygon zkEVM | polygon-zkevm | |
| Aurora | aurora | |
| Moonbeam | moonbeam | |
| Boba | boba | |
| Soneium | soneium | |
| Zircuit | zircuit | |
| Metis | metis | |
| Astar | astar | |
| Plasma | plasma | |
| Morph | morph-l2 | DL uses "Morph" |
| Swellchain | swellchain | |
| X Layer | xlayer | DL uses "X Layer" |
| Apechain | apechain | |
| Bittorrent | bittorrent | |
| Viction | viction | |
| Flare | flare | |
| Songbird | songbird | |
| Bitlayer | bitlayer | |
| Tron | tron | |
| Aptos | aptos | |
| Sui | sui | |
| Solana | solana | |
| TON | ton | DL uses "TON" |
| Near | near | |
| Algorand | algorand | |
| Stellar | stellar | |
| StarkNet | starknet | DL capitalizes differently |
| Hedera | hedera | |
| Polkadot | polkadot | |
| XRPL | xrpl | DL uses "XRPL" |
| Kava | kava | |
| Tezos | tezos | |
| Cardano | cardano | |
| ICP | icp | DL uses "ICP" |
| Noble | noble | |
| Osmosis | osmosis | |
| Mantra | mantra | |
| Provenance | provenance | |
| Hydradx | hydration | DL uses "Hydradx", we use "hydration" |

**DL chains NOT in our CHAIN_META** (auto-add when supply threshold met):

Cronos, EOS, Flow, Injective, IoTeX, MultiversX, Rootstock, Stacks, VeChain, Zilliqa, Heco, OKExChain, PulseChain, Conflux, Lisk, Ronin, Corn, Etherlink, Fogo, Immutable zkEVM, MegaETH, Movement, Sophon, Story, and ~40 more niche chains.

**DL chains to skip** (dead/deprecated):
- Harmony, Evmos, Terra Classic, EthereumPoW, EthereumClassic, DefiChain, Waves, smartBCH, Everscale

### Artifacts

| File | Purpose |
|------|---------|
| `.claude/skills/contract-enrich/SKILL.md` | Skill definition with DL_CHAIN_MAP, CG_PLATFORM_MAP, and full instructions |

No application code changes — the skill edits `stablecoins.ts` and `chains.ts` directly.

### Sanity Rules

1. Source from DefiLlama for discovery, CoinGecko for addresses
2. Verify every address on block explorer before writing
3. Never overwrite existing curated contract data
4. Skip if CG returns null decimals
5. Flag unknown DL chains not in `DL_CHAIN_MAP`
6. USDT/USDC: ≥$10M per chain; others: ≥$1M per chain
7. Skip known dead chains (Harmony, Evmos, Terra, etc.)
