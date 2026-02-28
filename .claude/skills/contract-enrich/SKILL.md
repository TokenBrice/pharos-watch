---
name: contract-enrich
description: Discover missing chain deployments using DefiLlama supply data, then populate contract addresses via CoinGecko + block explorer verification. Run across all tracked stablecoins or a subset.
user_invocable: true
---

## Contract Enrichment via DefiLlama Discovery

Two-phase workflow:
1. **Gap Discovery** — fetch DefiLlama stablecoins list, compare chain coverage against our contracts, apply supply thresholds, produce gap report
2. **Population** — for each gap, fetch CoinGecko address, verify on block explorer, write to stablecoins.ts

### Input

The user provides either:
- No arguments → process all tracked stablecoins
- A stablecoin **name**, **symbol**, or **ID** → process just that coin
- "top N" → process the top N coins by circulating supply

### Supply Thresholds

Only report gaps where DL supply meets these minimums:
- **USDT** (llamaId: 1) and **USDC** (llamaId: 2): **≥$10M** per chain
- **All other coins**: **≥$1M** per chain

### DL Chain Name → Internal Chain ID

Use this mapping to translate DefiLlama chain display names (from `chainCirculating` keys) to our internal chain IDs. Unmapped DL chains should be logged in the gap report.

```
DL Chain Name            → Our Chain ID
──────────────────────────────────────────
Ethereum                 → ethereum
Arbitrum                 → arbitrum
Base                     → base
OP Mainnet               → optimism
Polygon                  → polygon
Avalanche                → avalanche
BSC                      → bsc
Gnosis                   → gnosis
Fantom                   → fantom
Celo                     → celo
ZKsync Era               → zksync
Sonic                    → sonic
Sei                      → sei
World Chain              → worldchain
Unichain                 → unichain
Ink                      → ink
Moonriver                → moonriver
Kaia                     → klaytn
Plume Mainnet            → plume
Hyperliquid L1           → hyperevm
Monad                    → monad
XDC                      → xdc
Mantle                   → mantle
Linea                    → linea
Scroll                   → scroll
Blast                    → blast
Mode                     → mode
Manta                    → manta
Berachain                → berachain
Bob                      → bob
Fraxtal                  → fraxtal
Taiko                    → taiko
Polygon zkEVM            → polygon-zkevm
Aurora                   → aurora
Moonbeam                 → moonbeam
Boba                     → boba
Soneium                  → soneium
Zircuit                  → zircuit
Metis                    → metis
Astar                    → astar
Plasma                   → plasma
Morph                    → morph-l2
Swellchain               → swellchain
X Layer                  → xlayer
Apechain                 → apechain
Bittorrent               → bittorrent
Viction                  → viction
Flare                    → flare
Songbird                 → songbird
Bitlayer                 → bitlayer
Tron                     → tron
Aptos                    → aptos
Sui                      → sui
Solana                   → solana
TON                      → ton
Near                     → near
Algorand                 → algorand
Stellar                  → stellar
StarkNet                 → starknet
Hedera                   → hedera
Polkadot                 → polkadot
XRPL                     → xrpl
Kava                     → kava
Tezos                    → tezos
Cardano                  → cardano
ICP                      → icp
Noble                    → noble
Osmosis                  → osmosis
Mantra                   → mantra
Provenance               → provenance
Hydradx                  → hydration
Ronin                    → ronin
Corn                     → corn
Cronos                   → cronos
Lisk                     → lisk
Rootstock                → rootstock
EOS                      → eos
Stacks                   → stacks
Flow                     → flow
IoTeX                    → iotex
MultiversX               → multiversx
Injective                → injective
Zilliqa                  → zilliqa
Conflux                  → conflux
PulseChain               → pulsechain
Etherlink                → etherlink
MegaETH                  → megaeth
Immutable zkEVM          → immutable-zkevm
Heco                     → heco
OKExChain                → okxchain
Fogo                     → fogo
Movement                 → movement
Sophon                   → sophon
Story                    → story
VeChain                  → vechain
Abstract                 → abstract
EDU Chain                → educhain
Hemi                     → hemi
Mezo                     → mezo
```

### DL Chains to Skip (dead/deprecated)

These DL chain names should be silently skipped — do not report them as gaps:

```
Harmony                  (effectively dead — no DeFi activity)
Evmos                    (mostly dead)
Terra Classic            (dead)
EthereumPoW              (dead fork)
EthereumClassic          (negligible stablecoin activity)
DefiChain                (niche, not relevant)
Waves                    (effectively dead)
smartBCH                 (dead)
Everscale                (dead)
Dogechain                (dead)
Canto                    (mostly dead)
Karura                   (dead)
Q                        (obscure)
REINetwork               (obscure)
SXnetwork                (obscure)
Wanchain                 (dead)
```

### CG Platform → Chain ID Mapping

Reuse the mapping from the `/contract-populate` skill. This is the authoritative map for translating CoinGecko platform names to our chain IDs:

```
CG Platform Name         → Our Chain ID
──────────────────────────────────────────
ethereum                 → ethereum
arbitrum-one             → arbitrum
base                     → base
optimistic-ethereum      → optimism
polygon-pos              → polygon
avalanche                → avalanche
binance-smart-chain      → bsc
gnosis                   → gnosis
fantom                   → fantom
celo                     → celo
tron                     → tron
aptos                    → aptos
sui                      → sui
solana                   → solana
the-open-network         → ton
zksync                   → zksync
near-protocol            → near
algorand                 → algorand
stellar                  → stellar
starknet                 → starknet
hedera-hashgraph         → hedera
sonic                    → sonic
xdc-network              → xdc
sei-v2                   → sei
world-chain              → worldchain
unichain                 → unichain
ink                      → ink
polkadot                 → polkadot
xrp                      → xrpl
moonriver                → moonriver
klay-token               → klaytn
plume-network            → plume
hyperevm                 → hyperevm
monad                    → monad
mantle                   → mantle
linea                    → linea
scroll                   → scroll
blast                    → blast
mode-network             → mode
manta-pacific            → manta
ronin                    → ronin
bob-network              → bob
corn-network             → corn
berachain                → berachain
kava                     → kava
fraxtal                  → fraxtal
taiko                    → taiko
polygon-zkevm            → polygon-zkevm
aurora                   → aurora
moonbeam                 → moonbeam
boba                     → boba
soneium                  → soneium
zircuit                  → zircuit
metis-andromeda          → metis
astar                    → astar
plasma                   → plasma
morph-l2                 → morph-l2
swellchain               → swellchain
x-layer                  → xlayer
apechain                 → apechain
bittorrent               → bittorrent
tomochain                → viction
flare-network            → flare
songbird                 → songbird
bitlayer                 → bitlayer
tezos                    → tezos
cardano                  → cardano
internet-computer        → icp
noble                    → noble
osmosis                  → osmosis
mantra                   → mantra
provenance               → provenance
hydration                → hydration
xdai                     → gnosis
cronos                   → cronos
lisk                     → lisk
rootstock                → rootstock
eos                      → eos
flow                     → flow
iotex                    → iotex
multiversx               → multiversx
injective                → injective
zilliqa                  → zilliqa
conflux                  → conflux
pulsechain               → pulsechain
```

### CG Platforms to Skip (dead/deprecated/legacy)

```
harmony-shard-0          (Harmony — effectively dead)
evmos                    (Evmos — mostly dead)
terra                    (Terra Classic — dead)
terra-2                  (Terra 2 — dead)
q-mainnet                (Q — obscure)
binancecoin              (BNB Beacon Chain / BEP2 — legacy)
```

---

## Phase 1: Gap Discovery

### Step 1 — Load our stablecoin data

1. Read `src/lib/stablecoins.ts`
2. For each stablecoin, extract: `id`, `symbol`, `name`, `llamaId`, `geckoId`, `contracts[]` (list of chain IDs already populated)

### Step 2 — Fetch DefiLlama data

Fetch the stablecoins list:

```
WebFetch https://stablecoins.llama.fi/stablecoins?includePrices=true
```

This returns `{ peggedAssets: [...] }`. Each asset has:
- `id`: string (DL's numeric ID, matches our `llamaId`)
- `name`, `symbol`
- `chainCirculating`: `{ "Ethereum": { current: { peggedUSD: 65000000000 } }, ... }`

### Step 3 — Match and diff

For each of our tracked stablecoins:

1. Find the matching DL entry by `llamaId` (our `llamaId` == DL's `id`)
2. If no match, log and skip
3. Extract DL's chain names from `chainCirculating` keys
4. For each DL chain:
   a. Get supply: `chainCirculating[chainName].current.peggedUSD` (or `peggedEUR`, `peggedGBP`, etc. depending on `pegType`)
   b. Apply supply threshold: skip if below $10M (USDT/USDC) or $1M (others)
   c. Map DL chain name → internal chain ID using `DL_CHAIN_MAP`
   d. If chain already in our `contracts[]` → skip (no gap)
   e. Otherwise → record as a gap

### Step 4 — Print gap report

Print a structured report:

```
=== Contract Enrichment Gap Report ===
{N}/{total} tracked coins matched to DefiLlama entries

{SYMBOL} (llamaId: {id}, geckoId: {geckoId}): {N} missing chains
  - {DL chain name} → {internal chain ID} (${supply} supply)
  - {DL chain name} → [UNMAPPED] (${supply} supply)
  - {DL chain name} → {internal chain ID} [NEW CHAIN] (${supply} supply)

...

Summary:
  Total gaps: {N} across {M} coins
  On known chains (in CHAIN_META): {N}
  On new chains (need CHAIN_META entry): {N}
  On unmapped DL chains (need DL_CHAIN_MAP update): {N}
  On skipped dead chains: {N}
```

### Step 5 — Pause for review

After printing the gap report, STOP and ask the user:
- "Gap report above. Proceed with populating all {N} gaps? Or select specific coins?"
- Wait for user confirmation before moving to Phase 2

---

## Phase 2: Population

Process each gap coin by coin (alphabetically by symbol). For each coin:

### Step 1 — Fetch CoinGecko data

If the coin has a `geckoId`, fetch:

```
WebFetch https://api.coingecko.com/api/v3/coins/{geckoId}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false
```

Extract the `detail_platforms` field.

### Step 2 — Map CG platforms to gap chains

For each gap chain on this coin:
1. Find the CG platform that maps to this internal chain ID (reverse lookup in CG_PLATFORM_MAP)
2. If CG has the platform → extract `contract_address` and `decimal_place`
3. If CG doesn't have the platform → log "CG missing: {chainId} for {symbol}" and skip

### Step 3 — Verify on block explorer

For each address found:

1. Look up `CHAIN_META[chainId].explorerUrl`
2. For EVM chains: visit `{explorerUrl}/token/{address}` using `agent-browser`
   - Verify: page loads, shows a token, name/symbol is reasonable match
3. For non-EVM chains: use chain-specific explorer patterns:
   - Tron: `tronscan.org/#/token20/{address}`
   - Solana: `solscan.io/token/{address}`
   - Aptos: `explorer.aptoslabs.com/account/{address}`
   - Sui: `suiscan.xyz/mainnet/coin/{address}`
   - TON: `tonviewer.com/{address}`
   - Near: `nearblocks.io/token/{address}`
   - Algorand: `explorer.perawallet.app/asset/{address}`
   - Stellar: check `stellar.expert/explorer/public/asset/{code}-{issuer}`
   - Starknet: `starkscan.co/token/{address}`
   - Hedera: `hashscan.io/mainnet/token/{address}`
4. If verification fails (404, wrong token) → log and skip

### Step 4 — Check for new chains

If the gap chain is not in `CHAIN_META`:
1. Add it to `src/lib/chains.ts` following the pattern from contract-populate skill
2. Research the chain's:
   - Human-readable name
   - Block explorer URL
   - EVM chain ID (if EVM), null otherwise
   - Type: "evm" or "other" (use "tron" only for Tron)
   - Logo path: `/chains/{chainId}.png`

### Step 5 — Write to stablecoins.ts

1. Edit the coin's `contracts` array using the Edit tool
2. Append new entries after existing ones
3. Format: `{ chain: "{chainId}", address: "{address}", decimals: {N} }`
4. EVM addresses: lowercase hex
5. Non-EVM: preserve original case from CoinGecko
6. Sort the full contracts array by chain name after adding

### Step 6 — Report per coin

```
## {Symbol} — {Name}
- Gaps found: {N} chains
- Populated: {list with chain → address}
- CG missing (skipped): {list}
- Verification failed (skipped): {list}
- New CHAIN_META entries added: {list}
- Null decimals flagged (skipped): {list}
```

### Step 7 — After all coins

1. Run `npm run build` to verify everything compiles
2. Print consolidated summary:

```
=== Enrichment Complete ===
Coins processed: {N}
New contracts added: {N} across {M} chains
New CHAIN_META entries: {N}
Skipped (CG missing): {N}
Skipped (verification failed): {N}
Skipped (null decimals): {N}
Build: PASS/FAIL
```

---

## Quality Standards

- **Never overwrite existing contracts** — curated data is always trusted
- **Lowercase EVM addresses** — verify CG returns lowercase, force it if not
- **Skip null decimals** — unless the token standard makes it obvious (most ERC-20s are 6 or 18)
- **Non-standard address formats are fine** — Stellar, XRP, Polkadot, etc. have their own formats
- **Log everything** — unmapped platforms, missing CG data, verification failures
- **Sequential CG requests** — respect ~30 req/min free tier rate limit
- **Pause between phases** — always show gap report and get user approval before populating

## What NOT to Do

- Don't overwrite any existing contract entry
- Don't add the same chain twice for a coin
- Don't guess decimals — if CG returns null and it's unclear, skip
- Don't modify any fields other than `contracts` in stablecoins.ts
- Don't modify any fields other than `CHAIN_META` in chains.ts
- Don't skip block explorer verification — every address must be confirmed
- Don't process coins without a `geckoId` — no CG lookup possible
- Don't include chains below supply threshold even if CG has an address
