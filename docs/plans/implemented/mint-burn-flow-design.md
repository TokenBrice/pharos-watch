# Mint/Burn Flow Intelligence ("Bank Run Gauge")

Design document for tracking real-time minting and redemption flows for top stablecoins. Monitors on-chain Transfer events to/from the zero address (and known treasury/minter contracts) to build a leading indicator of stablecoin stress.

**Status:** Draft
**Date:** 2026-03-01

---

## Table of Contents

1. [Overview & Motivation](#1-overview--motivation)
2. [Scope & Prioritization](#2-scope--prioritization)
3. [On-Chain Event Detection](#3-on-chain-event-detection)
4. [Data Pipeline](#4-data-pipeline)
5. [Database Schema](#5-database-schema)
6. [Aggregation & Scoring](#6-aggregation--scoring)
7. [API Design](#7-api-design)
8. [UI Design](#8-ui-design)
9. [Integration with Other Features](#9-integration-with-other-features)
10. [Edge Cases & Limitations](#10-edge-cases--limitations)
11. [Future Enhancements](#11-future-enhancements)

---

## 1. Overview & Motivation

Supply data in Pharos today is a daily snapshot (`supply_history` table, captured at 08:00 UTC by `snapshot-supply`). The DefiLlama stablecoins API gives circulating supply per chain, updated every 15 minutes, but these are net figures -- they reveal the result of minting and redemption but not the individual flows.

Mint/burn flows are the best leading indicator for stablecoin stress because they reflect institutional confidence before it appears in price. Institutional redemptions are the first visible signal of a bank run: the issuer's reserves are being drawn down, and market participants who can redeem 1:1 (authorized participants, large OTC desks) are doing so while retail is still holding.

### Historical precedent: March 2023 USDC bank run

On March 10, 2023, Silicon Valley Bank collapsed. Circle disclosed $3.3B of USDC reserves were held at SVB. Over the next 48 hours:

- **$3B+ in USDC redemptions** were processed through Circle before any price movement on secondary markets.
- USDC depegged to $0.87 on some DEXes as holders rushed to exit.
- DAI and FRAX (both partially collateralized by USDC) saw collateral depeg.
- The redemption flow preceded the price depeg by hours. Anyone watching the mint/burn ledger would have seen the run developing before the price chart showed it.

The same pattern appeared with BUSD in February 2023 (Paxos stopped minting after SEC action -- $5B in burns over 30 days), TUSD in late 2023 (sustained redemption outflows signaling loss of confidence), and UST in May 2022 (the death spiral was visible in mint/burn data before the peg broke catastrophically).

### What this feature provides

1. **Early warning**: Unusual redemption velocity flags potential stress before depeg events fire.
2. **Flight-to-quality detection**: Simultaneous outflows from risky coins and inflows to safe havens (USDC, USDT) reveal market sentiment shifts.
3. **Supply velocity**: Transforms the daily supply snapshot into a real-time velocity measure -- not just "supply is $60B" but "supply is falling at $200M/hour."
4. **Bank Run Gauge**: An aggregate market visualization showing whether the stablecoin ecosystem is in net expansion (confidence) or contraction (fear).

---

## 2. Scope & Prioritization

### Phase 1: Core infrastructure + 10 issuers (Ethereum only)

| Coin | ID | Decimals | Contract (Ethereum) | Backing | Governance | FtQ bucket |
|------|----|----------|---------------------|---------|------------|------------|
| USDT | `1` | 6 | `0xdac17f958d2ee523a2206206994597c13d831ec7` | rwa-backed | centralized | Safe haven |
| USDC | `2` | 6 | `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48` | rwa-backed | centralized | Safe haven |
| DAI | `5` | 18 | `0x6b175474e89094c44da98b954eedeac495271d0f` | crypto-backed | centralized-dependent | Risky |
| GHO | `118` | 18 | `0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f` | crypto-backed | centralized-dependent | Risky |
| FDUSD | `119` | 18 | `0xc5f0f7b66764f6ec8c8dff7ba683102295e16409` | rwa-backed | centralized | Safe haven |
| PYUSD | `120` | 6 | `0x6c3ea9036406852006290770bedfcaba0e23a0e8` | rwa-backed | centralized | Safe haven |
| USDe | `146` | 18 | `0x4c9edd5852cd905f086c759e8383e09bff1e68b3` | crypto-backed | centralized-dependent | Risky |
| USDS | `209` | 18 | `0xdc035d45d973e3ec169d2276ddab16f1e407384f` | crypto-backed | centralized-dependent | Risky |
| frxUSD | `235` | 18 | `0xcacd6fd266af91b8aed52accc382b4e165586e29` | rwa-backed | centralized-dependent | Risky |
| BOLD | `269` | 18 | `0x6440f144b7e50d6a8439336510312d2f54beb01d` | crypto-backed | decentralized | Risky |

Phase 1 covers 10 coins on 1 chain, all using standard Transfer event monitoring. The mix of 4 safe-haven and 6 risky coins enables flight-to-quality detection from day one.

**Flight-to-quality classification**: Safe havens require `governance = "centralized"` AND `backing = "rwa-backed"`. frxUSD is rwa-backed but DAO-governed, so it falls into the risky bucket despite strong reserves. BOLD uses immutable-code governance with pure crypto collateral (wstETH/WETH/rETH).

### Phase 2: Multi-chain expansion

Add secondary chain deployments for coins with significant non-Ethereum supply:

| Coin | Chain | Contract | Notes |
|------|-------|----------|-------|
| USDT | Tron | `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` | ~50% of USDT supply. Uses `Issue`/`Redeem` events (not Transfer). |
| USDT | Arbitrum | `0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9` | USDT0 bridged supply. |
| USDT | BSC | `0x55d398326f99059ff775485246999027b3197955` | Large BSC-native supply. |
| USDC | Arbitrum | `0xaf88d065e77c8cc2239327c5edb3a432268e5831` | Native USDC. |
| USDC | Base | `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` | Native USDC. |
| USDC | Polygon | `0x3c499c542cef5e3811e1192ce70d8cc03d5c3359` | Native USDC. |
| PYUSD | Solana | (Solana token program) | Significant Solana supply. Requires Solana event parsing. |
| FDUSD | BSC | (BSC contract) | Multi-chain issuer. |

### Phase 3: Additional issuers + complex mint patterns

| Coin | ID | Chain | Notes |
|------|----|-------|-------|
| crvUSD | `110` | Ethereum | Curve Finance, complex PegKeeper mechanics |
| TUSD | `7` | Ethereum | Historical redemption patterns, opaque reserves |
| FRAX | `6` | Ethereum | Legacy algorithmic component (predecessor to frxUSD) |
| USD0 | `195` | Ethereum | Usual, RWA-backed |
| reUSD | (TBD) | Ethereum | Resupply, depends on crvUSD/frxUSD lending vaults |

### Selection criteria

- **Flight-to-quality mix**: Phase 1 requires a balanced split of safe-haven (centralized + RWA-backed) and risky (crypto-backed, DAO-governed, or exotic) coins for the detection formula to be meaningful. The 4/6 safe/risky split achieves this.
- **Simple mint/burn patterns**: All Phase 1 coins use standard Transfer from/to zero address as their primary minting mechanism on Ethereum. Coins with complex multi-step processes or non-standard event structures are deferred to Phase 3.
- **Ethereum only first**: Single chain avoids bridge transfer false positives and keeps the subrequest budget low. Multi-chain expansion in Phase 2.
- **Supply concentration**: Phase 2 prioritizes chains where >10% of a coin's supply resides.
- **Etherscan V2 API support**: Chains accessible via the existing Etherscan V2 API are cheaper to add.

---

## 3. On-Chain Event Detection

### ERC-20 Transfer event signature

All ERC-20 mints and burns emit the standard Transfer event:

```
Transfer(address indexed from, address indexed to, uint256 value)
```

**Topic hash:** `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef`

- **Mint**: `from = 0x0000000000000000000000000000000000000000`
- **Burn**: `to = 0x0000000000000000000000000000000000000000`

### Per-token minter configuration

Some tokens use dedicated minter/treasury contracts instead of (or in addition to) the zero address. The config must specify which addresses to watch.

#### USDT (Ethereum)

- **Mint signal**: Transfer from `address(0)` to any recipient.
- **Treasury**: `0x5754284f345afc66a98fbB0a0Afe71e0f007b949` (Tether Treasury). Large mints go to Treasury first, then Treasury distributes. We track the zero-address mint, not the Treasury redistribution.
- **Burn signal**: Transfer from any sender to `address(0)`. Also watch for `Redeem(uint256 amount)` event (topic `0x702d5967f45f6513a38ffc42d6ba9bf230bd40e8f53b16363c7eb4fd2deb9a44`).
- **Additional events**:
  - `Issue(uint256 amount)` (topic `0xcb8241adb0c3fdb35b70c24ce35c5eb0c17af7431c99f827d44a445ca624176a`) -- emitted alongside Transfer on mint.

#### USDC (Ethereum)

- **Mint signal**: Transfer from `address(0)`. USDC's FiatTokenV2 uses a MasterMinter pattern but the actual `mint()` function emits a standard Transfer from zero.
- **Burn signal**: Transfer to `address(0)`. The `burn()` function emits Transfer to zero.
- **No additional events needed** -- the Transfer event is sufficient.

#### DAI (Ethereum)

- **Mint signal**: Transfer from `address(0)`. DAI's `mint()` in the Dai contract emits Transfer from zero.
- **Burn signal**: Transfer to `address(0)`. DAI's `burn()` emits Transfer to zero.
- **Complexity note**: DAI minting happens through the Vat/DaiJoin system. The Transfer from zero fires when `DaiJoin.exit()` is called. Individual vault operations (opening, adding collateral) do not directly mint DAI until the user exits. This is fine -- we track the net DAI creation, not the vault mechanics.

#### GHO (Ethereum)

- **Mint signal**: Transfer from `address(0)`. GHO is minted through Aave V3 facilitators -- when a facilitator calls `mint()`, a standard Transfer from zero fires. The CDP/facilitator mechanics are invisible at the event level.
- **Burn signal**: Transfer to `address(0)`. The `burn()` function emits Transfer to zero.
- **No additional events needed** -- the Transfer event is sufficient despite the multi-facilitator architecture.

#### FDUSD (Ethereum)

- **Mint signal**: Transfer from `address(0)`. Standard ERC-20 mint by FD121 Limited.
- **Burn signal**: Transfer to `address(0)`.
- **No additional events needed**.

#### PYUSD (Ethereum)

- **Mint signal**: Transfer from `address(0)`. Paxos-issued, same mint pattern as BUSD/USDP.
- **Burn signal**: Transfer to `address(0)`.
- **No additional events needed**.

#### USDe (Ethereum)

- **Mint signal**: Transfer from `address(0)`. Ethena's minting contract emits standard Transfer.
- **Burn signal**: Transfer to `address(0)`.
- **Note**: USDe has high mint/burn frequency due to delta-neutral rebalancing. The dust threshold ($10K) should be sufficient to filter routine small operations while capturing institutional flows.

#### USDS (Ethereum)

- **Mint signal**: Transfer from `address(0)`. Sky/Maker successor to DAI with similar DaiJoin-style minting.
- **Burn signal**: Transfer to `address(0)`.
- **Note**: USDS has a 1:1 PSM with DAI and USDC. PSM swaps do NOT mint/burn USDS (they transfer from a pre-minted pool), so they won't pollute the flow data.

#### frxUSD (Ethereum)

- **Mint signal**: Transfer from `address(0)`. Enshrined custodians (BlackRock BUIDL, Superstate USTB, etc.) mint frxUSD 1:1 against on-chain reserves.
- **Burn signal**: Transfer to `address(0)`.
- **No additional events needed**.

#### BOLD (Ethereum)

- **Mint signal**: Transfer from `address(0)`. Liquity V2 CDPs mint BOLD when users borrow against wstETH/WETH/rETH collateral.
- **Burn signal**: Transfer to `address(0)`. Burned on repayment and Stability Pool liquidations.
- **Note**: Immutable contracts -- no proxy upgrade risk.

#### USDT (Tron) — Phase 2

- **Mint signal**: `Issue(uint256 amount)` event. On Tron, USDT uses `issue()` rather than standard Transfer from zero.
- **Burn signal**: `Redeem(uint256 amount)` event.
- **TronGrid API**: Use the existing TronGrid event query pattern from `sync-blacklist.ts`, filtering by event name.

### MintBurnContractConfig type

```typescript
// worker/src/lib/mint-burn-contracts.ts

import type { ChainConfig } from "./blacklist-contracts";

export type MintBurnDirection = "mint" | "burn";

export interface MintBurnEventDef {
  /** Human-readable event signature */
  signature: string;
  /** Keccak256 topic hash */
  topicHash: string;
  /** Whether this event represents a mint or burn */
  direction: MintBurnDirection;
  /**
   * How to extract the amount from the event.
   * - "transfer-value": Standard Transfer event -- amount is in data field
   *   (32 bytes if from/to are indexed, 96 bytes with from+to+value in data)
   * - "first-data-uint256": Amount is the first (and only) uint256 in data
   *   (e.g., Issue(uint256), Redeem(uint256))
   */
  amountEncoding: "transfer-value" | "first-data-uint256";
  /**
   * For Transfer events: which topic position holds the filter address
   * (from=topics[1] for mints, to=topics[2] for burns).
   * For non-Transfer events: null (no address filtering needed).
   */
  filterTopic?: {
    index: number;
    /** Padded 32-byte hex of the address to match (e.g., zero address) */
    value: string;
  };
}

export interface MintBurnContractConfig {
  chain: ChainConfig;
  /** Pharos stablecoin ID */
  stablecoinId: string;
  /** Token symbol (for logging and display) */
  symbol: string;
  /** Token contract address */
  contractAddress: string;
  /** Token decimals */
  decimals: number;
  /** Minimum event amount in token units to record (noise filter) */
  dustThreshold: number;
  /** Events to monitor */
  events: MintBurnEventDef[];
}
```

### Phase 1 contract configs

```typescript
const ZERO_ADDRESS_PADDED =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// USDT on Ethereum
const USDT_ISSUE_TOPIC =
  "0xcb8241adb0c3fdb35b70c24ce35c5eb0c17af7431c99f827d44a445ca624176a";
const USDT_REDEEM_TOPIC =
  "0x702d5967f45f6513a38ffc42d6ba9bf230bd40e8f53b16363c7eb4fd2deb9a44";

// Helper: standard ERC-20 mint+burn events via Transfer from/to zero address
function transferMintBurn(): MintBurnEventDef[] {
  return [
    {
      signature: "Transfer(address,address,uint256)",
      topicHash: TRANSFER_TOPIC,
      direction: "mint",
      amountEncoding: "transfer-value",
      filterTopic: { index: 1, value: ZERO_ADDRESS_PADDED }, // from = zero
    },
    {
      signature: "Transfer(address,address,uint256)",
      topicHash: TRANSFER_TOPIC,
      direction: "burn",
      amountEncoding: "transfer-value",
      filterTopic: { index: 2, value: ZERO_ADDRESS_PADDED }, // to = zero
    },
  ];
}

export const MINT_BURN_CONFIGS: MintBurnContractConfig[] = [
  // --- Safe havens ---
  {
    chain: ETHEREUM, stablecoinId: "1", symbol: "USDT",
    contractAddress: "0xdac17f958d2ee523a2206206994597c13d831ec7",
    decimals: 6, dustThreshold: 10_000, events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "2", symbol: "USDC",
    contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    decimals: 6, dustThreshold: 10_000, events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "119", symbol: "FDUSD",
    contractAddress: "0xc5f0f7b66764f6ec8c8dff7ba683102295e16409",
    decimals: 18, dustThreshold: 10_000, events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "120", symbol: "PYUSD",
    contractAddress: "0x6c3ea9036406852006290770bedfcaba0e23a0e8",
    decimals: 6, dustThreshold: 10_000, events: transferMintBurn(),
  },

  // --- Risky / crypto-backed ---
  {
    chain: ETHEREUM, stablecoinId: "5", symbol: "DAI",
    contractAddress: "0x6b175474e89094c44da98b954eedeac495271d0f",
    decimals: 18, dustThreshold: 10_000, events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "118", symbol: "GHO",
    contractAddress: "0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f",
    decimals: 18, dustThreshold: 10_000, events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "146", symbol: "USDe",
    contractAddress: "0x4c9edd5852cd905f086c759e8383e09bff1e68b3",
    decimals: 18, dustThreshold: 10_000, events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "209", symbol: "USDS",
    contractAddress: "0xdc035d45d973e3ec169d2276ddab16f1e407384f",
    decimals: 18, dustThreshold: 10_000, events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "235", symbol: "FRXUSD",
    contractAddress: "0xcacd6fd266af91b8aed52accc382b4e165586e29",
    decimals: 18, dustThreshold: 10_000, events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "269", symbol: "BOLD",
    contractAddress: "0x6440f144b7e50d6a8439336510312d2f54beb01d",
    decimals: 18, dustThreshold: 10_000, events: transferMintBurn(),
  },
];
```

### Event parsing

For Transfer events where both `from` and `to` are indexed (standard ERC-20):
- `topics[0]` = Transfer event signature
- `topics[1]` = `from` address (padded to 32 bytes)
- `topics[2]` = `to` address (padded to 32 bytes)
- `data` = `uint256 value` (32 bytes)

To detect mints: filter where `topics[1]` = zero address padded.
To detect burns: filter where `topics[2]` = zero address padded.

For `Issue(uint256)` / `Redeem(uint256)` events (USDT Tron, Phase 2):
- `topics[0]` = event signature
- `data` = `uint256 amount`

Parsing reuses `decodeUint256()` from `worker/src/lib/evm-logs.ts`.

---

## 4. Data Pipeline

### Cron design

The mint/burn sync must piggyback on an existing cron trigger since all 4 slots are used.

**Chosen slot: `3,23,43 * * * *`** (Trigger 2, alongside `sync-blacklist`)

Rationale:
- The blacklist cron runs every 20 minutes with a 900-subrequest budget. Mint/burn scanning is structurally identical (incremental block scanning via Etherscan V2) and can share the same rate limiter.
- The `*/15` slot is already the heaviest (4 concurrent jobs + PSI chain). Adding another would risk Worker timeout.
- The `10,40` slot has a 15-minute GT crawl budget that fills its 30-minute window.

**Implementation**: The `scheduled()` handler in `index.ts` adds `syncMintBurn()` to the `3,23,43` case:

```typescript
case "3,23,43 * * * *": {
  // CRITICAL: share a single Etherscan rate limiter between both jobs.
  // Both run in parallel via ctx.waitUntil(), so independent limiters
  // would combine to 8 req/sec — exceeding Etherscan's free-tier 5 req/sec cap.
  // A shared limiter keeps the combined rate at 4 req/sec.
  const etherscanRL = createRateLimiter(4); // 4 req/sec shared
  const etherscanKey = env.ETHERSCAN_API_KEY ?? null;

  ctx.waitUntil(
    logCronRun(db, "sync-blacklist", () =>
      syncBlacklist(db, etherscanKey, env.TRONGRID_API_KEY ?? null, env.DRPC_API_KEY ?? null, etherscanRL)
    )
  );
  ctx.waitUntil(
    logCronRun(db, "sync-mint-burn", () =>
      syncMintBurn(db, etherscanKey, etherscanRL)
    )
  );
  break;
}
```

Both jobs run in parallel via separate `ctx.waitUntil()` calls. They share:
- **One Etherscan rate limiter** (4 req/sec combined) to stay within the free-tier 5 req/sec cap. At 4 req/sec, the combined ~70-120 calls complete in ~18-30 seconds — well within the 20-minute cron window.
- **Separate subrequest budgets** (900 for blacklist, 200 for mint-burn) to independently track and cap their API call counts.
- The Tron rate limiter remains internal to `syncBlacklist` (mint-burn Phase 1 doesn't query Tron).

**Signature change for `syncBlacklist`**: Accept an optional `etherscanRL` parameter. When provided, use it instead of creating an internal one. This is a backward-compatible change — existing callers (admin backfill, etc.) continue to work without passing it.

### Frequency and block ranges

- **Scan frequency**: Every 20 minutes (3 times per hour).
- **Block range per scan**: From `last_block + 1` to `latest`. For Ethereum at 12s/block, 20 minutes is ~100 blocks. For L2s (Phase 2), block counts are higher but event density is lower.
- **Incremental sync**: Identical to `sync-blacklist` pattern. `mint_burn_sync_state` tracks `last_block` per config key (format: `{chain}-{contractAddress}`). EVM chains store block numbers; Tron stores millisecond timestamps.

### Subrequest budget

Phase 1 (10 contracts on Ethereum):
- 10 contracts x 2 event directions = 20 Etherscan getLogs calls per scan.
- Plus 1 `eth_blockNumber` call for chain head (cached across contracts).
- Total: ~21 subrequests per run.
- Budget: 200 subrequests (headroom for block range splitting if events exceed 1000-result limit).

Phase 2+ will need a higher budget. If the combined blacklist + mint-burn load exceeds Worker limits, mint-burn can be moved to a minute-check piggyback on the `*/15` slot:

```typescript
// Only run at :03, :23, :43 within the */15 trigger
const minute = new Date(event.scheduledTime).getMinutes();
if ([3, 23, 43].includes(minute)) { /* run mint-burn */ }
```

### Batching strategy (Workers 6-connection limit)

Phase 1 makes at most 21 sequential API calls through the shared rate limiter. Since the limiter serializes requests across both jobs, the effective throughput for mint-burn depends on blacklist's concurrent demand. In practice:
- Blacklist processes 16 EVM configs (~50-100 calls)
- Mint-burn processes 10 configs (~21 calls)
- Both interleave through the shared 4 req/sec queue
- Combined completion time: ~18-30 seconds (vs ~5 seconds if mint-burn ran alone)

The 6-connection limit is not a concern — the shared rate limiter serializes all requests, so at most 1-2 concurrent fetches are in-flight at any time. Phase 2 with multiple chains will batch like blacklist does: process one chain's contracts sequentially, then the next.

### Noise filtering

Events are filtered at two levels:

**Level 1 -- At ingestion (in cron):**

- **Dust threshold**: Each config specifies a `dustThreshold` in token units. Events below this are silently dropped. Default: 10,000 units ($10K for USD-pegged). This eliminates noise from small retail mints/burns, testing transactions, and rounding artifacts.
- **Known bridge addresses**: Maintain a deny-list of bridge contract addresses whose mints/burns represent cross-chain movement, not new issuance or redemption. Initially empty -- populated as patterns are identified.

**Level 2 -- At aggregation (in API/scoring):**

- **Minimum event significance**: When computing flow rates, events below $100K are excluded from the "institutional flow" calculation but included in "total flow."
- **Bridge address tagging**: Events to/from addresses tagged as bridges are categorized separately rather than excluded, enabling "cross-chain flow" analysis in Phase 3+.

### Hourly aggregation update

After inserting new events, the cron recalculates only the affected hourly buckets. The set of affected hours is determined by the timestamps of newly inserted events:

```sql
-- Collect distinct hour boundaries from the batch of new events
-- (computed in code from the inserted events' timestamps)

-- For each affected hour:
INSERT OR REPLACE INTO mint_burn_hourly
  (stablecoin_id, chain_id, hour_ts, mint_count, burn_count,
   mint_volume_usd, burn_volume_usd, net_flow_usd)
SELECT
  stablecoin_id,
  chain_id,
  (timestamp / 3600) * 3600 AS hour_ts,
  SUM(CASE WHEN direction = 'mint' THEN 1 ELSE 0 END),
  SUM(CASE WHEN direction = 'burn' THEN 1 ELSE 0 END),
  COALESCE(SUM(CASE WHEN direction = 'mint' THEN amount_usd ELSE 0 END), 0),
  COALESCE(SUM(CASE WHEN direction = 'burn' THEN amount_usd ELSE 0 END), 0),
  COALESCE(SUM(CASE WHEN direction = 'mint' THEN amount_usd ELSE -amount_usd END), 0)
FROM mint_burn_events
WHERE stablecoin_id = ? AND chain_id = ?
  AND timestamp >= ? AND timestamp < ?  -- hour boundary to hour boundary + 3600
GROUP BY stablecoin_id, chain_id, hour_ts
```

The `INSERT OR REPLACE` on the composite primary key `(stablecoin_id, chain_id, hour_ts)` makes this idempotent -- re-running the cron over the same block range produces identical results.

### USD denomination

Event amounts are stored in native token units. USD values are computed at query time using the 15-minute price cache (`price_cache` table). For Phase 1 coins (USDT, USDC, DAI), the USD conversion is trivial (approximately 1:1), but the architecture supports accurate conversion for non-USD-pegged coins in future phases.

The `amount_usd` column stores a snapshot USD value at ingestion time (using the current price from `price_cache`) for historical accuracy. This is the single source of truth for USD values — both raw event queries and hourly aggregation use this column. If the price cache is empty for a coin, `amount_usd` is set to `NULL` and backfilled on the next run.

### Safety margin

Identical to blacklist sync: when no events are found and the scan succeeds, advance `last_block` to `chain_head - safety_margin_blocks` (15 minutes of blocks) to avoid permanently skipping events that Etherscan hasn't indexed yet.

---

## 5. Database Schema

### Migration: `0031_mint_burn_v2.sql`

(Note: migrations 0019/0020 created and dropped a previous mint_burn_events table. This design uses a new migration number.)

```sql
-- Individual mint/burn events
CREATE TABLE mint_burn_events (
  id TEXT PRIMARY KEY,                 -- "{chainId}-{txHash}-{logIndex}"
  stablecoin_id TEXT NOT NULL,         -- Pharos stablecoin ID ("1", "2", "5", "118", etc.)
  symbol TEXT NOT NULL,                -- "USDT", "USDC", "DAI", "GHO", etc.
  chain_id TEXT NOT NULL,              -- "ethereum", "tron", etc.
  direction TEXT NOT NULL,             -- "mint" or "burn"
  amount REAL NOT NULL,                -- Token-native amount (e.g., 1000000.5 USDC)
  amount_usd REAL,                     -- USD value at time of event (NULL if price unavailable)
  counterparty TEXT,                   -- Address that received minted tokens or sent burned tokens
  tx_hash TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,          -- Unix seconds
  explorer_tx_url TEXT NOT NULL
);

CREATE INDEX idx_mbe2_ts ON mint_burn_events(timestamp DESC);
CREATE INDEX idx_mbe2_coin ON mint_burn_events(stablecoin_id, timestamp DESC);
CREATE INDEX idx_mbe2_chain ON mint_burn_events(chain_id, timestamp DESC);

-- Pre-aggregated hourly flow buckets (written by cron after each scan)
CREATE TABLE mint_burn_hourly (
  stablecoin_id TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  hour_ts INTEGER NOT NULL,            -- Unix seconds, truncated to hour boundary
  mint_count INTEGER NOT NULL DEFAULT 0,
  burn_count INTEGER NOT NULL DEFAULT 0,
  mint_volume_usd REAL NOT NULL DEFAULT 0,
  burn_volume_usd REAL NOT NULL DEFAULT 0,
  net_flow_usd REAL NOT NULL DEFAULT 0, -- mint_volume - burn_volume (positive = net mint)
  PRIMARY KEY (stablecoin_id, chain_id, hour_ts)
);

CREATE INDEX idx_mbh_ts ON mint_burn_hourly(hour_ts DESC);
CREATE INDEX idx_mbh_coin ON mint_burn_hourly(stablecoin_id, hour_ts DESC);

-- Incremental block tracking (same pattern as blacklist_sync_state)
CREATE TABLE mint_burn_sync_state (
  config_key TEXT PRIMARY KEY,         -- "{chainId}-{contractAddress}"
  last_block INTEGER NOT NULL DEFAULT 0
);
```

### Schema rationale

**`mint_burn_events`**: Raw event storage. Keeps every significant event (above dust threshold) for querying and historical analysis. The `counterparty` field stores the non-zero address in the Transfer event (the recipient for mints, the sender for burns) -- useful for whale identification (Phase 3+). The `explorer_tx_url` is constructed from `ChainConfig.explorerUrl + "/tx/" + txHash` (same pattern as blacklist events).

**`mint_burn_hourly`**: Pre-aggregated hourly buckets. Computing flow rates from raw events on every API call would be expensive for hot endpoints. The cron updates these incrementally: after inserting new events, it recalculates the affected hourly buckets. This denormalization trades O(n) query time for O(1) lookup.

The hourly table uses a composite primary key `(stablecoin_id, chain_id, hour_ts)` rather than an auto-increment ID. This enables `INSERT OR REPLACE` semantics for idempotent recalculation.

**`mint_burn_sync_state`**: Identical pattern to `blacklist_sync_state`. EVM chains store block numbers; Tron (Phase 2) stores millisecond timestamps.

### Data retention

- **Raw events**: Keep all events indefinitely. With Phase 1 (10 contracts), estimated volume is ~200-800 events/day (USDT and USDe have the most mint/burn activity). At ~200 bytes/row, a year of data is under 60MB.
- **Hourly aggregates**: Keep indefinitely. 10 coins x 1 chain x 24 hours x 365 days = 88K rows/year, negligible.
- **Future consideration**: If Phase 3+ grows the raw event table significantly, add a prune cron (e.g., keep raw events for 90 days, rely on hourly aggregates for older data).

---

## 6. Aggregation & Scoring

### Flow rate computation

Flow rates are derived from the `mint_burn_hourly` table at query time:

```
hourly_net_flow(coin, hour) = mint_volume_usd - burn_volume_usd
daily_net_flow(coin, day) = SUM(hourly_net_flow) over 24 hours
weekly_net_flow(coin, week) = SUM(hourly_net_flow) over 168 hours
```

The API computes these windows dynamically from the hourly table, which is fast (at most 168 rows per coin per week).

### Per-coin Flow Intensity Score (FIS)

A normalized score (0-100) measuring how unusual current flow activity is relative to that coin's historical baseline.

```
current_daily_net = sum of net_flow_usd over last 24 hours
baseline_daily_net = 30-day moving average of daily net flow
baseline_daily_abs = 30-day moving average of daily absolute flow (|mint| + |burn|)

// Direction-weighted intensity
if current_daily_net < 0:  // net redemptions
  z_score = (current_daily_net - baseline_daily_net) / max(baseline_daily_abs * 0.3, 1_000_000)
  intensity = clamp(0, 100, 50 - z_score * 25)
  // 50 = baseline, 0 = extreme redemptions, 100 = extreme minting
else:  // net minting
  z_score = (current_daily_net - baseline_daily_net) / max(baseline_daily_abs * 0.3, 1_000_000)
  intensity = clamp(0, 100, 50 + z_score * 25)
```

**Interpretation:**
- **0-20**: Heavy net redemptions (danger zone)
- **20-40**: Moderate net redemptions
- **40-60**: Normal activity
- **60-80**: Moderate net minting (confidence)
- **80-100**: Heavy net minting (rapid expansion)

### Bank Run Gauge (aggregate)

The Bank Run Gauge is a market-cap-weighted composite of per-coin flow intensity:

```
gauge_score = SUM(intensity_i * mcap_share_i) for all tracked coins

where:
  intensity_i = per-coin FIS (0-100)
  mcap_share_i = coin_mcap / sum_of_tracked_mcaps
```

**Gauge bands:**

| Score range | Label | Color | Meaning |
|-------------|-------|-------|---------|
| 0-15 | CRISIS | Red | Extreme net redemptions across market |
| 15-30 | FEAR | Orange | Significant net redemptions |
| 30-45 | CAUTIOUS | Amber | Moderate net outflows |
| 45-55 | NEUTRAL | Gray | Normal flow activity |
| 55-70 | CONFIDENT | Light green | Moderate net minting |
| 70-85 | EXPANSION | Green | Significant net minting |
| 85-100 | SURGE | Bright green | Extreme net minting (rapid market growth) |

### Flight-to-quality detection

When money simultaneously flows OUT of risky coins and INTO safe havens, this is a strong signal of market stress. Detection logic:

```
safe_havens = coins where governance = "centralized" AND backing = "rwa-backed"
               (Phase 1: USDT, USDC, FDUSD, PYUSD)
risky_coins = all other tracked coins
               (Phase 1: DAI, GHO, USDe, USDS, frxUSD, BOLD)

safe_net_24h = SUM(daily_net_flow) for safe_havens
risky_net_24h = SUM(daily_net_flow) for risky_coins

flight_to_quality = risky_net_24h < -$100M AND safe_net_24h > $100M
flight_intensity = min(100, abs(risky_net_24h) / $1B * 100)
```

The 4/6 safe/risky split in Phase 1 makes this detection meaningful from day one. Note: frxUSD is rwa-backed but DAO-governed (`centralized-dependent`), so it falls into the risky bucket despite strong reserves — this is by design, as DAO governance introduces a distinct risk profile.

This signal is surfaced in the API response and can trigger digest mentions.

### Historical baselines

The 30-day moving average baseline is computed from `mint_burn_hourly`. During the first 30 days after deployment, the baseline uses available data (minimum 7 days before the FIS is reported, to avoid unstable scores).

Coins with fewer than 7 days of flow data report `flowIntensity: null` in the API. Raw flow numbers (net 24h, mint/burn volumes) are always returned regardless of baseline availability — only the normalized FIS score requires the baseline. The Bank Run Gauge also reports `null` until all tracked coins have at least 7 days of data.

No hardcoded baselines or bootstrapping from `supply_history` — supply deltas show net daily change, not bidirectional flow volume (a day with $500M minted and $500M burned shows $0 delta). The system starts from zero and self-calibrates.

---

## 7. API Design

### `GET /api/mint-burn-flows`

Aggregate flow data across all tracked coins. Primary endpoint for the Bank Run Gauge.

**Cache:** standard (`s-maxage=300, max-age=60`)

**Query parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `stablecoin` | `string` | -- | Filter to a single coin (Pharos stablecoin ID) |
| `hours` | `integer` | `24` | Lookback window in hours (1-720, i.e., up to 30 days) |

**Response (aggregate mode, no `stablecoin` param):**

```json
{
  "gauge": {
    "score": 42.3,
    "band": "CAUTIOUS",
    "flightToQuality": false,
    "flightIntensity": 0,
    "trackedCoins": 10,
    "trackedMcapUsd": 225000000000
  },
  "coins": [
    {
      "stablecoinId": "1",
      "symbol": "USDT",
      "flowIntensity": 38.5,
      "netFlow24hUsd": -245000000,
      "mintVolume24hUsd": 180000000,
      "burnVolume24hUsd": 425000000,
      "mintCount24h": 12,
      "burnCount24h": 28,
      "netFlow7dUsd": -1200000000,
      "largestEvent24h": {
        "direction": "burn",
        "amountUsd": 150000000,
        "txHash": "0xabc...",
        "timestamp": 1709312400
      }
    }
  ],
  "hourly": [
    {
      "hourTs": 1709308800,
      "netFlowUsd": -85000000,
      "mintVolumeUsd": 20000000,
      "burnVolumeUsd": 105000000
    }
  ],
  "updatedAt": 1709312400
}
```

**Response (per-coin mode, with `stablecoin` param):**

```json
{
  "stablecoinId": "2",
  "symbol": "USDC",
  "flowIntensity": 62.1,
  "netFlow24hUsd": 320000000,
  "mintVolume24hUsd": 480000000,
  "burnVolume24hUsd": 160000000,
  "mintCount24h": 45,
  "burnCount24h": 18,
  "netFlow7dUsd": 1500000000,
  "baseline30dNetUsd": 50000000,
  "hourly": [
    {
      "hourTs": 1709308800,
      "netFlowUsd": 25000000,
      "mintVolumeUsd": 35000000,
      "burnVolumeUsd": 10000000,
      "chainBreakdown": {
        "ethereum": { "mintUsd": 35000000, "burnUsd": 10000000 }
      }
    }
  ],
  "updatedAt": 1709312400
}
```

### `GET /api/mint-burn-events`

Raw event feed for a specific coin. Paginated.

**Cache:** realtime (`s-maxage=60, max-age=10`)

**Query parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `stablecoin` | `string` | *required* | Pharos stablecoin ID |
| `direction` | `string` | -- | Filter: `"mint"` or `"burn"` |
| `chain` | `string` | -- | Filter by chain ID |
| `minAmount` | `number` | -- | Minimum USD amount |
| `limit` | `integer` | `50` | Max results (1-500) |
| `offset` | `integer` | `0` | Pagination offset |

**Response:**

```json
{
  "events": [
    {
      "id": "ethereum-0xabc...-42",
      "stablecoinId": "1",
      "symbol": "USDT",
      "chainId": "ethereum",
      "direction": "burn",
      "amount": 150000000,
      "amountUsd": 150000000,
      "counterparty": "0x1234...",
      "txHash": "0xabc...",
      "blockNumber": 19500000,
      "timestamp": 1709312400,
      "explorerTxUrl": "https://etherscan.io/tx/0xabc..."
    }
  ],
  "total": 1234
}
```

### Caching strategy

| Endpoint | Profile | Rationale |
|----------|---------|-----------|
| `/api/mint-burn-flows` (aggregate) | standard (5min edge, 1min client) | Aggregate scores change slowly. The gauge updates every 20 minutes with new cron data. |
| `/api/mint-burn-flows?stablecoin=X` | standard | Same reasoning as aggregate. |
| `/api/mint-burn-events` | realtime (1min edge, 10s client) | Raw events are granular; users expect near-real-time feed. |

### Error responses

| Status | When |
|--------|------|
| 400 | Missing required `stablecoin` param on events endpoint |
| 400 | Invalid stablecoin ID format |
| 503 | Cron has not yet populated any flow data |

---

## 8. UI Design

### New page: `/flows/`

A dedicated "Flows" page accessible from the sidebar navigation. Layout:

#### Section 1: Bank Run Gauge (hero)

A large semicircular gauge visualization (similar to a speedometer) showing the aggregate flow score.

- Needle position indicates current score (0-100).
- Color gradient from red (left, 0) through amber to green (right, 100).
- Current band label displayed below the gauge (e.g., "CAUTIOUS").
- Subtitle: "Net stablecoin minting vs redemption activity across tracked issuers."
- Flight-to-quality badge: if active, a warning badge appears below the gauge: "Flight to quality detected: $X flowing from risky coins to safe havens."

#### Section 2: Per-coin flow table

Sortable table with one row per tracked coin:

| Column | Description |
|--------|-------------|
| Coin | Logo + symbol |
| Flow Intensity | FIS (0-100) with color-coded bar |
| Net 24h | Net USD flow (green if positive/mint, red if negative/burn) |
| Minted 24h | Total mint volume USD |
| Burned 24h | Total burn volume USD |
| Net 7d | Net USD flow over 7 days |
| Largest Event | Direction + amount of the single largest event in 24h |

Default sort: by absolute Net 24h descending (most active first).

#### Section 3: Aggregate flow chart

A stacked area chart (Recharts `AreaChart`) showing hourly aggregate flows over a configurable time range (24h / 7d / 30d toggle via `TimeRangeButtons`):

- Mint volume above the x-axis (green area).
- Burn volume below the x-axis (red area).
- Net flow line overlay.
- Tooltip shows exact values on hover.

#### Section 4: Historical overlay (deferred to Phase 2)

An optional overlay showing flow patterns preceding known depeg events. E.g., "USDC flows in the 72 hours before the March 2023 depeg" as a reference watermark behind the live chart.

### Detail page integration (`/stablecoin/[id]/`)

On each coin's detail page, add a "Mint/Burn Flows" section (gated on whether the coin has flow data):

- **Flow chart**: Hourly area chart (same format as aggregate but single-coin), time range toggleable (24h / 7d / 30d).
- **Flow summary stats**: Net 24h, Net 7d, Flow Intensity score.
- **Recent events table**: Last 10 mint/burn events with tx hash links.

### Homepage integration

Add a compact flow indicator to the KPI bar or market highlights section:

- **Gauge mini**: A small (48x24px) inline gauge icon with the current score and band color.
- **Flow trend**: "Net 24h: +$1.2B minted" or "Net 24h: -$500M redeemed" with directional arrow and color.

### Component inventory

| Component file | Description |
|---------------|-------------|
| `flow-gauge.tsx` | Semicircular gauge SVG visualization |
| `flow-gauge-mini.tsx` | Compact inline gauge for homepage |
| `flow-chart.tsx` | Stacked area chart (mint above / burn below axis) |
| `flow-table.tsx` | Per-coin flow summary sortable table |
| `flow-event-feed.tsx` | Raw event feed with pagination |
| `flow-summary-card.tsx` | Summary card for detail pages |

### Hook

```typescript
// src/hooks/use-mint-burn-flows.ts
import { useApiQuery, CRON_20MIN } from "./use-api-query";

// Flows data updates every 20 min (sync-mint-burn cron on trigger 2).
// useApiQuery convention: staleTime = cronInterval, refetchInterval = 2× cronInterval.

export function useMintBurnFlows(stablecoinId?: string, hours = 24) {
  const params = new URLSearchParams();
  if (stablecoinId) params.set("stablecoin", stablecoinId);
  if (hours !== 24) params.set("hours", hours.toString());
  const qs = params.toString();

  return useApiQuery<MintBurnFlowsResponse>(
    ["mint-burn-flows", stablecoinId ?? "all", hours],
    `/api/mint-burn-flows${qs ? `?${qs}` : ""}`,
    CRON_20MIN
  );
}

export function useMintBurnEvents(stablecoinId: string, opts?: { direction?: string; limit?: number; offset?: number }) {
  const params = new URLSearchParams({ stablecoin: stablecoinId });
  if (opts?.direction) params.set("direction", opts.direction);
  if (opts?.limit) params.set("limit", opts.limit.toString());
  if (opts?.offset) params.set("offset", opts.offset.toString());

  return useApiQuery<MintBurnEventsResponse>(
    ["mint-burn-events", stablecoinId, opts?.direction ?? "all", opts?.offset ?? 0],
    `/api/mint-burn-events?${params}`,
    CRON_20MIN
  );
}
```

---

## 9. Integration with Other Features

### Depeg Early Warning (detect-depegs.ts)

The flow data can be consumed directly by the depeg detection pipeline to add a "supply velocity" signal:

```typescript
// In detect-depegs.ts, before opening a new depeg event:
const recentBurns = await db.prepare(
  `SELECT SUM(burn_volume_usd) as total_burns
   FROM mint_burn_hourly
   WHERE stablecoin_id = ? AND hour_ts > ?`
).bind(coinId, nowSec - 3600 * 6).first();

// If >$500M burned in last 6 hours, lower the depeg confirmation threshold
if (recentBurns?.total_burns > 500_000_000) {
  // Skip pending phase, immediately open depeg event
}
```

This is a future enhancement -- Phase 1 does not modify the depeg pipeline. The data is available for manual correlation first.

### Daily Digest (daily-digest.ts)

Add flow data to the `DigestInputData` object assembled before the LLM call:

```typescript
// In daily-digest.ts data collection:
const flowData = await db.prepare(`
  SELECT stablecoin_id, symbol,
    SUM(CASE WHEN net_flow_usd > 0 THEN net_flow_usd ELSE 0 END) as total_minted,
    SUM(CASE WHEN net_flow_usd < 0 THEN net_flow_usd ELSE 0 END) as total_burned,
    SUM(net_flow_usd) as net_flow
  FROM mint_burn_hourly
  WHERE hour_ts > ?
  GROUP BY stablecoin_id
  ORDER BY ABS(SUM(net_flow_usd)) DESC
  LIMIT 5
`).bind(nowSec - 86400).all();
```

This enables digest entries like: "USDC saw $500M in net redemptions yesterday, its largest single-day outflow since March 2023. USDT absorbed the rotation with $320M in fresh mints."

### Pharos Stability Index (stability-index.ts)

A future PSI v2 could incorporate aggregate flow velocity as a fourth component:

```
Score = 100 - severity - breadth + trend + flow_signal

flow_signal = clamp(-3, +3, (gauge_score - 50) / 50 * 3)
```

This would cause the PSI to dip before depeg events fire (flows precede price), making it a true leading indicator.

### Report Cards (report-cards.ts)

A future "Resilience" dimension enhancement could incorporate flow stability: coins with low flow volatility (steady mint/burn rates) score higher than coins with erratic, spike-driven flows.

### Stress Test (stress-test-panel.tsx)

The stress test panel could incorporate flow-based scenario modeling: "If redemptions continue at the current rate of $X/hour, in Y hours the circulating supply will drop below Z, potentially straining reserves."

```
hours_to_threshold = (current_supply - reserve_floor) / abs(hourly_burn_rate)
```

---

## 10. Edge Cases & Limitations

### Bridge transfers that mimic mints/burns

**Problem**: Cross-chain bridge operations often mint on the destination chain (Transfer from zero) and burn on the source chain (Transfer to zero). These are supply movements, not new issuance or redemption.

**Phase 1 mitigation**: Since Phase 1 only tracks Ethereum for all 10 coins, and USDT/USDC are natively issued on Ethereum, most bridge mints on Ethereum are actually canonical -- the token is being bridged *back* to its native chain. For crypto-backed coins (DAI, GHO, USDe, USDS, BOLD), minting IS issuance (there's no bridging involved -- they're minted on Ethereum). frxUSD and FDUSD are also primarily issued on Ethereum. The false positive rate is low.

**Phase 2+ mitigation**: Maintain a `bridge_addresses` deny-list in the config. Known bridge contracts (Arbitrum Gateway, Polygon Bridge, etc.) are excluded from flow calculations. The list is curated manually and updated as new bridges are identified.

**Long-term**: Tag bridge events with `is_bridge = true` rather than excluding them. This enables a separate "Cross-chain flow" view showing supply movement between chains without polluting the issuance/redemption signal.

### Proxy contract upgrades

**Problem**: If a token's proxy is upgraded and the new implementation changes the minting address (e.g., USDT migrating from legacy to USDT0), the config must be updated.

**Mitigation**: The per-token config in `mint-burn-contracts.ts` is updated in code alongside any contract change. The blacklist tracker already handles this pattern (USDT0 events were added when Arbitrum/Polygon USDT was upgraded). The mint/burn config follows the same code-update process.

### Rate limiting on Etherscan/TronGrid

**Problem**: Etherscan V2 free tier allows 5 calls/second. TronGrid allows 15 calls/second (with API key).

**Mitigation**: Reuse the existing `createRateLimiter()` pattern from `evm-logs.ts`. Phase 1 needs ~7 calls per run (well under any limit). Phase 2+ may need 30-50 calls; the rate limiter ensures compliance.

### Coins with complex multi-step mint processes

**Problem**: Some coins (e.g., crvUSD with PegKeeper mechanics, or wrapped stablecoins) have multi-step minting where intermediate transfers to/from zero address occur.

**Mitigation**: Defer complex coins to Phase 3. Phase 1 coins all have clean Transfer from/to zero events, even those with multi-step internal mechanics. GHO (Aave facilitators) and DAI (Vat/DaiJoin) both emit a single Transfer from zero at the final step — the CDP mechanics are invisible at the event level. BOLD (Liquity V2 CDPs) follows the same pattern.

### Data gaps during API outages

**Problem**: If Etherscan V2 is down during a cron run, events in that block range are missed.

**Mitigation**: The incremental sync pattern does not advance `last_block` on API failure (same as blacklist). The next successful run will scan from the last known block, catching any missed events. The `apiError` flag is tracked in cron metadata for alerting.

### Historical backfill

**Problem**: On initial deployment, there is no historical data. The FIS will be null for all coins until 7 days of data accumulates (30 days for a stable baseline).

**Mitigation**:
1. **Admin backfill endpoint**: `GET /api/backfill-mint-burn?stablecoin=X&fromBlock=Y` scans historical blocks in batches. Requires `ADMIN_KEY` authentication (same pattern as other admin endpoints). Processes blocks in configurable batch sizes (default 10K blocks per request) to stay within Worker timeout. For Ethereum, scanning the last 90 days of all 10 coins is ~270K blocks, feasible in multiple admin-triggered batches.
2. **No baseline bootstrapping**: The FIS reports `null` until 7 days of real flow data accumulates. Raw flow numbers (volumes, net flow, event counts) are always returned. The gauge reads `null` until all tracked coins have baselines. The admin backfill endpoint can accelerate baseline building by replaying historical blocks.

### Token-specific decimals

USDT and USDC use 6 decimals; DAI uses 18. The `decodeUint256()` helper from `evm-logs.ts` handles this correctly via the per-config `decimals` field. No additional work needed.

### Zero-amount events

Some contracts emit Transfer events with `value = 0` (e.g., approve-then-transferFrom patterns). These are filtered out at parse time (amount must be > 0 AND > dustThreshold).

---

## 11. Future Enhancements

### Whale tracking (Phase 3)

Flag individual events above $10M as "whale events." The `counterparty` field in `mint_burn_events` enables this:

```sql
SELECT counterparty, SUM(amount_usd) as total_volume, COUNT(*) as event_count
FROM mint_burn_events
WHERE stablecoin_id = ? AND timestamp > ?
GROUP BY counterparty
ORDER BY total_volume DESC
LIMIT 20
```

Surface as "Top Minters" and "Top Redeemers" tables on the detail page.

### CEX deposit flow detection (Phase 4)

Track transfers to known CEX deposit addresses (Binance, Coinbase, Kraken hot wallets). Large stablecoin inflows to exchanges often precede selling pressure. This requires maintaining a CEX address database and monitoring Transfer events beyond just mint/burn.

### Real-time WebSocket alerts (Phase 4)

Cloudflare Durable Objects could provide WebSocket connections for real-time flow alerts. When a single event exceeds $50M or the hourly burn rate exceeds 2x the 30-day average, push a notification to connected clients.

### Cross-chain flow visualization (Phase 3)

With multi-chain data from Phase 2, build a Sankey diagram showing supply movement between chains. "Ethereum -> Arbitrum: $500M this week" reveals L2 adoption trends.

### Integration with on-chain reserve monitoring (Phase 5)

For USDC and USDT, correlate mint/burn flows with on-chain reserve data (e.g., USDC's attestation of Circle Reserve Fund). If reserves are not growing proportionally to mints, flag as a potential concern.

### Predictive flow modeling (Phase 5)

Use historical flow patterns to predict near-term supply changes. "Based on current redemption velocity and day-of-week patterns, USDC supply is projected to drop by $1.2B by Friday."

---

## Appendix A: File Inventory (Phase 1)

| File | Role |
|------|------|
| `worker/src/lib/mint-burn-contracts.ts` | Per-coin contract configs, event definitions, bridge deny-list |
| `worker/src/cron/sync-mint-burn.ts` | Cron: incremental block scanning, event parsing, hourly aggregation |
| `worker/src/api/mint-burn-flows.ts` | `GET /api/mint-burn-flows` handler |
| `worker/src/api/mint-burn-events.ts` | `GET /api/mint-burn-events` handler |
| `worker/migrations/0031_mint_burn_v2.sql` | D1 schema migration |
| `src/hooks/use-mint-burn-flows.ts` | TanStack Query hooks |
| `src/components/flow-gauge.tsx` | Semicircular gauge SVG |
| `src/components/flow-gauge-mini.tsx` | Compact inline gauge |
| `src/components/flow-chart.tsx` | Stacked area chart |
| `src/components/flow-table.tsx` | Per-coin flow table |
| `src/components/flow-event-feed.tsx` | Raw event feed |
| `src/components/flow-summary-card.tsx` | Detail page summary |
| `src/app/flows/page.tsx` | Flows page (static export) |
| `src/app/flows/client.tsx` | Flows page client component |
| `src/app/flows/error.tsx` | Error boundary |

## Appendix B: Cron Slot Impact

Current trigger layout:

| Trigger | Schedule | Current jobs | New job |
|---------|----------|-------------|---------|
| 1 | `*/15 * * * *` | sync-stablecoins, sync-stablecoin-charts, sync-fx-rates, stability-index, health alert | -- |
| 2 | `3,23,43 * * * *` | sync-blacklist | **sync-mint-burn** |
| 3 | `10,40 * * * *` | sync-dex-liquidity | -- |
| 4 | `0 8 * * *` | snapshot-supply, snapshot-psi, sync-usds-status, sync-bluechip, daily-digest | -- |

Trigger 2 gains `sync-mint-burn` running in parallel with `sync-blacklist`. Both share a single Etherscan rate limiter (4 req/sec) created in the `scheduled()` handler to stay within the free-tier 5 req/sec cap. Subrequest budgets remain separate (900 blacklist + 200 mint-burn). Total Etherscan calls per Trigger 2 invocation increase from ~50-100 (blacklist only) to ~70-120 (blacklist + mint-burn Phase 1 with 10 coins), completing in ~18-30 seconds at the shared 4 req/sec rate.

## Appendix C: Etherscan V2 Log Query for Mint Detection

Example query to find USDC mints on Ethereum (Transfer from zero address):

```
GET https://api.etherscan.io/v2/api
  ?chainid=1
  &module=logs
  &action=getLogs
  &address=0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48
  &topic0=0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
  &topic1=0x0000000000000000000000000000000000000000000000000000000000000000
  &topic0_1_opr=and
  &fromBlock=19500000
  &toBlock=19500100
  &apikey=YOUR_KEY
```

For burn detection, use `topic2` instead of `topic1` (with `topic0_2_opr=and`):

```
  &topic2=0x0000000000000000000000000000000000000000000000000000000000000000
  &topic0_2_opr=and
```

This is more efficient than fetching all Transfer events and filtering in-code, because it reduces the result set at the API level. The existing `fetchEvmLogsForTopic()` in `evm-logs.ts` only supports `topic0` filtering. Phase 1 needs a variant that supports `topic0 + topic1` or `topic0 + topic2` compound filtering.

### Required change to `evm-logs.ts` (dedicated implementation task)

This is a prerequisite for the mint/burn cron. The new function must replicate all behavior of the existing `fetchEvmLogsForTopic()`:
- Recursive block-range splitting when results hit the 1000-entry Etherscan limit
- Max recursion depth (8)
- Budget tracking (increment `budget.count` before each fetch)
- Rate-limited fetch via `rateLimit` wrapper
- Same error handling and null-on-failure semantics

```typescript
export async function fetchEvmLogsForTopics(
  evmChainId: number,
  contractAddress: string,
  topics: { index: number; value: string }[],
  apiKey: string | null,
  fromBlock: number,
  toBlock: number,
  depth: number,
  rateLimit: RateLimitedFetch,
  budget: SubrequestBudget
): Promise<EtherscanLogEntry[] | null> {
  // Build topic params: topic0, topic1, topic0_1_opr, etc.
  const params = new URLSearchParams({
    chainid: evmChainId.toString(),
    module: "logs",
    action: "getLogs",
    address: contractAddress,
    fromBlock: fromBlock.toString(),
    toBlock: toBlock.toString(),
  });

  for (const t of topics) {
    params.set(`topic${t.index}`, t.value);
    if (t.index > 0) {
      params.set(`topic0_${t.index}_opr`, "and");
    }
  }

  if (apiKey) params.set("apikey", apiKey);
  // ... rest follows existing fetchEvmLogsForTopic pattern
  // (recursive split, budget check, rate limit, error handling)
}
```

**Implementation note**: Consider refactoring the existing `fetchEvmLogsForTopic` to call this new function internally (passing `[{ index: 0, value: topicHash }]` as the topics array), so both share the same recursive/budget/rate-limit logic. This avoids duplicating ~60 lines of fetch/split/retry code.

## Appendix D: Migration from Previous Attempt

Migrations 0019 (`mint_burn_events` table) and 0020 (`DROP TABLE mint_burn_events`) show a previous attempt at this feature that was abandoned. The new schema (migration 0031) differs in several ways:

1. **Added `stablecoin_id`** (Pharos ID, not just symbol) for consistent joins with other tables.
2. **Added `amount_usd`** for pre-computed USD values.
3. **Added `counterparty`** for whale tracking.
4. **Added `mint_burn_hourly`** aggregation table for fast queries.
5. **Renamed columns** to match conventions used in newer tables (`stablecoin_id` not `stablecoin`, `chain_id` not `chain_id`).
6. **Better indexes** aligned with actual query patterns.

Since 0020 already dropped the old tables, migration 0031 starts clean with no conflicts.
