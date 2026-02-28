---
name: contract-populate
description: Populate smart contract addresses for a stablecoin using CoinGecko detail_platforms data. Expands CHAIN_META for new chains. Merges without overwriting existing curated data. Run per-coin or batch.
user_invocable: true
---

## Contract Address Population

Fetch and merge contract addresses from CoinGecko into `src/lib/stablecoins.ts`. Expands `src/lib/chains.ts` with new chains as discovered.

### Input

The user provides either:
- A stablecoin **name**, **symbol**, or **ID** (single coin)
- "top N" or "batch" (processes multiple coins by market cap order)

### CG Platform → Chain ID Mapping

Use this mapping to translate CoinGecko platform names to our chain IDs. This is the authoritative map — unmapped platforms should be logged and skipped.

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
```

### Process (Per Coin)

#### Step 1 — Read current state

1. Read `src/lib/stablecoins.ts` and locate the coin's entry
2. Note the coin's `geckoId` — if missing, skip this coin and flag it
3. Note all existing chains in the coin's `contracts` array (these are curated and will NOT be overwritten)

#### Step 2 — Fetch CoinGecko data

Fetch the CoinGecko coin detail API:

```
WebFetch https://api.coingecko.com/api/v3/coins/{geckoId}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false
```

Extract the `detail_platforms` field. This returns an object keyed by CG platform name, with values containing `contract_address` and `decimal_place`.

#### Step 3 — Map and merge

For each entry in `detail_platforms`:

1. **Look up chain ID** in the mapping table above
   - If not in the mapping → log as "unmapped: {cg_platform_name}" and skip
2. **Check if chain already exists** in the coin's contracts
   - If yes → skip (preserve curated data)
3. **Check if chain exists in `src/lib/chains.ts`** (`CHAIN_META`)
   - If no → add it (see "Adding New Chains" below)
4. **Add the contract** to the coin's contracts array:
   - `chain`: our chain ID
   - `address`: from CG, lowercase for EVM chains, original case for non-EVM (Tron, Solana, Aptos, Sui, Near, Stellar, etc.)
   - `decimals`: from CG's `decimal_place` field. If `null`, try to determine from the token standard (most ERC-20s are 6 or 18). If truly unknown, flag and skip

#### Step 4 — Adding new chains to `src/lib/chains.ts`

When a chain ID is not in `CHAIN_META`, add it with:

- `name`: Human-readable chain name (capitalize properly)
- `explorerUrl`: Look up the standard block explorer for this chain. Common ones:
  - ton: `https://tonviewer.com`
  - zksync: `https://explorer.zksync.io`
  - near: `https://nearblocks.io`
  - algorand: `https://explorer.perawallet.app`
  - stellar: `https://stellar.expert`
  - starknet: `https://starkscan.co`
  - hedera: `https://hashscan.io`
  - sonic: `https://sonicscan.org`
  - xdc: `https://xdcscan.io`
  - sei: `https://seitrace.com`
  - worldchain: `https://worldscan.org`
  - unichain: `https://uniscan.xyz`
  - polkadot: `https://polkadot.subscan.io`
  - xrpl: `https://xrpscan.com`
  - moonriver: `https://moonriver.moonscan.io`
  - klaytn: `https://klaytnscope.com`
  - plume: `https://explorer.plumenetwork.xyz`
  - hyperevm: `https://purrsec.com`
  - monad: `https://explorer.monad.xyz`
  - mantle: `https://mantlescan.xyz`
  - linea: `https://lineascan.build`
  - scroll: `https://scrollscan.com`
  - blast: `https://blastscan.io`
  - mode: `https://modescan.io`
  - manta: `https://pacific-explorer.manta.network`
  - ronin: `https://app.roninchain.com`
  - bob: `https://explorer.gobob.xyz`
  - corn: `https://cornscan.io`
  - berachain: `https://berascan.com`
- `evmChainId`: Filled if known EVM chain, `null` for non-EVM. Common EVM chain IDs:
  - zksync: 324, mantle: 5000, linea: 59144, scroll: 534352, blast: 81457, sonic: 146, mode: 34443, manta: 169, moonriver: 1285, klaytn: 8217, sei: 1329, worldchain: 480, unichain: 130, bob: 60808, berachain: 80094, corn: 21000000, plume: 98866, hyperevm: 999
- `type`: `"evm"` for EVM chains, `"other"` for non-EVM (ton, near, algorand, stellar, starknet, polkadot, xrpl, solana, sui, aptos)
- `logoPath`: `/chains/{chainId}.png` — the logo file won't exist yet, that's OK

**Important**: Add chains to `chains.ts` in a logical position (group by type: EVM L1s, EVM L2s, non-EVM). Maintain the existing code style (2-space alignment, trailing comma pattern).

#### Step 5 — Write changes

1. Edit the coin's `contracts` array in `src/lib/stablecoins.ts` using the Edit tool
2. Append new chains after the existing entries
3. Maintain code style: `{ chain: "...", address: "...", decimals: N }`
4. For EVM addresses: lowercase hex (CoinGecko usually returns lowercase, verify)
5. For non-EVM: preserve original case from CoinGecko

#### Step 6 — Present summary

After each coin, report:

```
## {Symbol} — {Name}
- Existing chains kept: {list}
- New chains added: {list with addresses}
- Unmapped CG platforms skipped: {list}
- Null decimals flagged: {list}
- New CHAIN_META entries added: {list}
```

### Batch Mode

When processing multiple coins:
- Process sequentially (CoinGecko rate limit: ~30 req/min on free tier)
- After ALL coins are processed, present a single consolidated summary
- After the batch, run `npm run build` to verify everything compiles

### Quality Standards

- **Never overwrite existing contracts** — curated data is trusted
- **Lowercase EVM addresses** — verify CG returns lowercase, force it if not
- **Skip null decimals** — unless the token standard makes it obvious (most ERC-20s are 6 or 18)
- **Non-standard address formats are fine** — Stellar, XRP, Polkadot, etc. have their own formats. Store as-is from CoinGecko
- **Log unmapped platforms** — these are opportunities to expand the mapping table

### What NOT to do

- Don't overwrite any existing contract entry
- Don't add the same chain twice for a coin
- Don't guess decimals — if CG returns null and it's unclear, skip
- Don't modify any fields other than `contracts` in stablecoins.ts
- Don't modify any fields other than `CHAIN_META` in chains.ts
