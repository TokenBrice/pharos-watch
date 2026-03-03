> **Status: IMPLEMENTED** — See implementation plan: `2026-03-02-sync-mint-burn-alchemy-migration-plan.md`

# Mint/Burn Log Fetching: Etherscan → Alchemy Migration

> Research & design handover document — 2026-03-02

## Problem

`sync-mint-burn.ts` uses Etherscan V2 REST API for `eth_getLogs` and `eth_blockNumber`. This blocks multi-chain expansion:

- **Etherscan free tier** doesn't support Base, Avalanche, or Optimism for getLogs ($49/chain/mo to unlock)
- reUSD configs already exist for Base + Avalanche (`mint-burn-contracts.ts`) but silently fail

## Decision

Migrate `sync-mint-burn.ts` from Etherscan to **Alchemy JSON-RPC** (`eth_getLogs` + `eth_blockNumber`).

- **Scope**: `sync-mint-burn.ts` only — `sync-blacklist.ts` stays on Etherscan (working fine)
- **Alchemy plan**: Upgraded to PAYG ($5/month minimum, $0.40–0.45/M CUs)
- **All chains enabled** in the Alchemy dashboard (Ethereum, Arbitrum, Base, Optimism, Polygon, Avalanche)

## Verified: Alchemy Test Results

Tested `eth_blockNumber` and `eth_getLogs` with USDC mint detection (Transfer from zero-address) on all 6 chains.

| Chain | eth_blockNumber | eth_getLogs (PAYG, 500-block range) |
|---|---|---|
| Ethereum | OK (block ~24.5M) | ✓ (pending PAYG propagation at time of test) |
| Arbitrum | OK (block ~437M) | ✓ (pending PAYG propagation at time of test) |
| Base | OK (block ~42.8M) | ✓ 32 mint events |
| Optimism | OK (block ~148M) | ✓ 13 mint events |
| Polygon | OK (block ~83.6M) | ✓ (pending PAYG propagation at time of test) |
| Avalanche | OK (block ~79.4M) | ✓ 2 mint events |

Note: Ethereum/Arbitrum/Polygon showed the free-tier 10-block limit error during testing; the user upgraded to PAYG and those chains may need a few minutes to propagate. Base, Optimism, and Avalanche confirmed working with large ranges.

### PAYG Block Range Limits

| Chain | PAYG Limit |
|---|---|
| Ethereum, Arbitrum, Base, Optimism | **Unlimited** |
| Avalanche (falls under "all other chains") | 10,000 blocks |
| Polygon | 2,000 blocks |

Source: [Alchemy docs](https://www.alchemy.com/docs/chains/ethereum/ethereum-api-endpoints/eth-get-logs)

### CU Cost Budget

- `eth_getLogs` = 60 CUs, `eth_blockNumber` = 10 CUs, `eth_getBlockByNumber(false)` = 16 CUs
- Current steady-state: ~35 getLogs + 4 blockNumbers per run → ~2,140 CUs/run
- 72 runs/day × 30 days → **~4.6M CUs/month** (15% of 30M free-tier CU cap)
- Timestamp resolution adds ~20–50 `eth_getBlockByNumber` calls/run → +320–800 CUs (negligible)

## Key Architectural Challenge: Timestamps

**Etherscan** includes `timeStamp` (hex) in every log entry. **Alchemy's `eth_getLogs`** does not — the standard EVM log response contains only `blockNumber`, not `timestamp`.

The mint/burn tracker needs timestamps to:
1. Compute `hour_ts` for hourly aggregation buckets
2. Store `timestamp` in `mint_burn_events` rows

### Recommended Solution: Batch Block Header Fetches

After fetching logs from Alchemy, collect unique block numbers and batch-fetch their timestamps via `eth_getBlockByNumber(blockNum, false)` (header only, 16 CUs each).

Alchemy supports **JSON-RPC batch requests** (multiple calls in one HTTP request), so fetching 20–50 unique block timestamps costs 1 HTTP request.

For a typical 20-minute cron scan on Ethereum (~100 blocks), only blocks containing actual mint/burn events need timestamps — typically 20–50 unique blocks. Fast chains like Arbitrum have more blocks but the same principle applies.

## Current Architecture (What Changes)

### Files in scope

| File | Role | Change needed |
|---|---|---|
| `worker/src/cron/sync-mint-burn.ts` | Cron entry point | Switch from Etherscan params to Alchemy URL; add timestamp resolution step |
| `worker/src/lib/evm-logs.ts` | Low-level log fetching | Add Alchemy JSON-RPC backend alongside existing Etherscan functions |
| `worker/src/lib/chain-rpcs.ts` | Alchemy URL builder | Already has `ALCHEMY_CHAINS` slugs — reuse |
| `worker/src/index.ts` | Cron trigger wiring | Pass `ALCHEMY_API_KEY` to `syncMintBurn` instead of (or alongside) Etherscan key |
| `worker/src/cron/__tests__/sync-mint-burn.test.ts` | Tests | Update mocks for new function signatures |
| `docs/mint-burn-flows.md` | Documentation | Update provider info |
| `docs/worker-and-api-limits.md` | Limits reference | Add Alchemy PAYG CU costs |

### Files NOT in scope (unchanged)

- `sync-blacklist.ts` — stays on Etherscan
- `blacklist-contracts.ts` / `ChainConfig` — shared type, no changes needed
- `mint-burn-contracts.ts` — configs are already correct (all chains defined)

### Current Call Chain

```
index.ts (cron trigger `3,23,43 * * * *`)
  → syncMintBurn(db, etherscanApiKey, etherscanRL, signal)
    → getEvmBlockNumber(evmChainId, apiKey, rateLimit, budget)        // Etherscan REST
    → fetchEvmLogsForTopics(evmChainId, contract, topics, apiKey, ...) // Etherscan REST
      → recursive split if result.length >= 1000
    → parseMintBurnLogs(config, eventDef, logs, prices)
      → log.timeStamp (hex) parsed directly from Etherscan response
```

### Target Call Chain

```
index.ts (cron trigger `3,23,43 * * * *`)
  → syncMintBurn(db, alchemyApiKey, signal)
    → getAlchemyBlockNumber(alchemyUrl)                              // Alchemy JSON-RPC
    → fetchAlchemyLogs(alchemyUrl, contract, topics, fromBlock, toBlock) // Alchemy JSON-RPC
      → pagination if needed (no 1000-row cap, but response size limit)
    → resolveBlockTimestamps(alchemyUrl, uniqueBlockNumbers)         // Batch JSON-RPC
    → parseMintBurnLogs(config, eventDef, logs, blockTimestamps, prices)
      → timestamp looked up from blockTimestamps map
```

## Alchemy JSON-RPC Formats (Reference)

### eth_blockNumber

```json
// Request
{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}

// Response
{"jsonrpc":"2.0","id":1,"result":"0x176f12d"}
```

### eth_getLogs

```json
// Request
{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{
  "address":"0xa0b8...",
  "fromBlock":"0x176f000",
  "toBlock":"0x176f100",
  "topics":["0xddf252ad...","0x000000..."]
}]}

// Response — note: NO timeStamp field
{"jsonrpc":"2.0","id":1,"result":[
  {
    "address":"0xa0b8...",
    "topics":["0xddf252ad...","0x0000...","0xabcd..."],
    "data":"0x0000...002540be400",
    "blockNumber":"0x176f050",
    "transactionHash":"0xabc123...",
    "transactionIndex":"0x0",
    "blockHash":"0xdef456...",
    "logIndex":"0x0",
    "removed":false
  }
]}
```

### eth_getBlockByNumber (for timestamps)

```json
// Request — false = no transaction details (header only, 16 CUs)
{"jsonrpc":"2.0","id":1,"method":"eth_getBlockByNumber","params":["0x176f050",false]}

// Response (truncated)
{"jsonrpc":"2.0","id":1,"result":{"timestamp":"0x6651a2c0",...}}
```

### Batch request (multiple calls in one HTTP request)

```json
// Request — array of JSON-RPC calls
[
  {"jsonrpc":"2.0","id":1,"method":"eth_getBlockByNumber","params":["0x176f050",false]},
  {"jsonrpc":"2.0","id":2,"method":"eth_getBlockByNumber","params":["0x176f051",false]}
]

// Response — array of results, same order
[
  {"jsonrpc":"2.0","id":1,"result":{"timestamp":"0x6651a2c0",...}},
  {"jsonrpc":"2.0","id":2,"result":{"timestamp":"0x6651a2cc",...}}
]
```

## Design Decisions Still Needed

1. **Shared vs separate rate limiter**: The Etherscan rate limiter is currently shared between `sync-blacklist` and `sync-mint-burn` (both on the `3,23,43` cron slot). Once mint/burn moves to Alchemy, it has its own throughput budget (10,000 CU/s PAYG). Should we still use a rate limiter for Alchemy calls? Probably yes — both to respect Alchemy's 10K CU/s throughput and to control the 6-concurrent-fetch CF Workers limit.

2. **Per-chain MAX_SCAN_RANGE**: Currently a flat 50,000 blocks. With Alchemy PAYG limits, Avalanche needs ≤10,000 and Polygon ≤2,000. Should this be per-chain config on `ChainConfig`, or a lookup map in `sync-mint-burn.ts`?

3. **Pagination strategy**: Etherscan returns max 1,000 logs and the code recursively splits the block range (up to depth 8). Alchemy doesn't have a 1,000-row cap — instead it has a 150MB response size limit. For production safety, we should still cap and paginate. Should we keep the recursive-split pattern or switch to a simpler sequential windowing approach?

4. **Fallback**: If Alchemy is down, should mint/burn fall back to Etherscan (Ethereum-only), or just skip the run and retry on the next cron cycle? Given the existing circuit breaker pattern, skipping seems simpler and safer.

5. **Alchemy URL construction**: `chain-rpcs.ts` already has `ALCHEMY_CHAINS` mapping chain names to slugs. The mint-burn code currently receives `ChainConfig.evmChainId` (numeric). We need a mapping from `evmChainId` → Alchemy URL, or pass the URL through the config. Simplest: build from `ChainConfig.chainId` + `ALCHEMY_CHAINS` lookup.

## Existing Infrastructure to Reuse

- **`ALCHEMY_CHAINS`** in `chain-rpcs.ts` — slug mapping for all 7 chains
- **`ChainConfig`** in `blacklist-contracts.ts` — already has `chainId` field we can use for Alchemy URL lookup
- **`SubrequestBudget`** in `evm-logs.ts` — budget tracking, reusable for Alchemy
- **`createRateLimiter`** in `evm-logs.ts` — reusable (adjust rate for Alchemy throughput)
- **`ALCHEMY_API_KEY`** in `env` — already plumbed through `index.ts`

## Connection Budget Impact

The `3,23,43` cron slot currently runs both `sync-blacklist` and `sync-mint-burn` concurrently via `ctx.waitUntil()`. Both share the 6-concurrent-fetch CF Workers limit.

After migration, mint/burn hits Alchemy while blacklist hits Etherscan — **two different hosts**, so they don't interfere with each other. This is actually an improvement: the shared Etherscan rate limiter was artificially constraining both jobs.

However, they still share the 6-connection pool. Mint/burn's Alchemy calls and blacklist's Etherscan calls count against the same 6 concurrent fetch limit. Sequential calls within each job (using rate limiters) already prevent this from being an issue.
