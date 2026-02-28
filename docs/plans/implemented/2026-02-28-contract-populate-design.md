# Contract Address Population — Design

Populate smart contract addresses for all tracked stablecoins across all discoverable chains, not just the 14 currently in `CHAIN_META`.

## Data Source

CoinGecko `/coins/{geckoId}` → `detail_platforms` field. Returns chain → address + decimals for 50+ platforms. Structured, reliable, includes decimals.

**Limitation:** CG doesn't always list every bridged deployment (USDT returned only 11 chains). Acceptable for v1 — can layer DL/official docs later for gaps.

## Skill: `contract-populate`

Reusable skill invoked per-coin or batched. Lives at `.claude/skills/contract-populate/`.

### Workflow Per Coin

```
1. Read coin from stablecoins.ts → get geckoId, existing contracts
2. No geckoId → skip, flag for manual fill
3. Fetch CoinGecko /coins/{geckoId} → extract detail_platforms
4. For each CG platform:
   a. Map CG platform name → our chain ID (via CG_PLATFORM_MAP)
   b. Chain ID not in CHAIN_META → add to chains.ts
   c. Chain already in coin's contracts → skip (preserve curated data)
   d. New chain → add { chain, address, decimals }
5. Write updated contracts to stablecoins.ts
6. Report: added N chains, skipped M existing, K unmapped platforms
```

### Merge Strategy

**Keep existing, add new chains only.** Curated data is trusted over CG. If a coin already has an entry for `ethereum`, we never overwrite it — even if CG has a different address or decimals.

### Rate Limiting

CoinGecko free tier: ~30 req/min. For batch runs, 2-second delay between coins.

## CG Platform → Chain ID Mapping

Stored as `CG_PLATFORM_MAP` inside the skill (not in `src/lib/` — only needed during population).

```
CG Platform Name        → Our Chain ID
─────────────────────────────────────────
ethereum                → ethereum
arbitrum-one            → arbitrum
base                    → base
optimism                → optimism
polygon-pos             → polygon
avalanche               → avalanche
binance-smart-chain     → bsc
gnosis                  → gnosis
fantom                  → fantom
celo                    → celo
tron                    → tron
aptos                   → aptos
sui                     → sui
solana                  → solana
the-open-network        → ton
zksync                  → zksync
near-protocol           → near
algorand                → algorand
stellar                 → stellar
starknet                → starknet
hedera-hashgraph        → hedera
sonic                   → sonic
xdc-network             → xdc
sei-v2                  → sei
world-chain             → worldchain
unichain                → unichain
ink                     → ink
polkadot                → polkadot
xrp-ledger              → xrpl
moonriver               → moonriver
klay-token              → klaytn
plume-network           → plume
hyperevm                → hyperevm
monad                   → monad
```

Unmapped platforms are logged and skipped. Reviewed after each batch to decide whether to add them.

## CHAIN_META Expansion

For each new chain ID not in `chains.ts`, add:

| Field | Value |
|-------|-------|
| `name` | Capitalized chain name |
| `explorerUrl` | From well-known explorers (skill looks these up) |
| `evmChainId` | Filled if known EVM chain, `null` otherwise |
| `type` | `"evm"` or `"other"` |
| `logoPath` | `/chains/{chainId}.png` (placeholder — logo added separately) |

## Test Plan — Top 20 by Market Cap

Run the skill on the ~20 largest stablecoins to validate before scaling.

**Verify:**
1. No data loss — existing contracts preserved exactly
2. New chains added correctly — addresses and decimals match CG
3. CHAIN_META grows — new entries have valid explorer URLs
4. Edge cases — no geckoId → skipped, null decimals → flagged, non-standard addresses (Stellar, XRP, Polkadot) stored as-is
5. Build passes — `npm run build` succeeds after all changes

**Execution:**
- Run sequentially on each top-20 coin
- Review diff after each coin
- Full build + type-check after all 20
- Summary: total chains added, new CHAIN_META entries, unmapped platforms

**Success criteria:** Top 20 each gain new chain deployments, build passes, contract-addresses component renders new chains.
