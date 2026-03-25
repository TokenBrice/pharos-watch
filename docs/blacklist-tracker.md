# Blacklist Tracker

Multi-chain blacklist/freeze event tracker for stablecoins. Monitors on-chain events (blacklist, unblacklist, destroy/seize) across 21 contract configurations on 8 chains. Runs hourly, incrementally scanning from the last processed block.

**Cron-backed sync coverage:** USDC, USDT, PAXG, XAUT, PYUSD, USD1.

**Live API/UI filter enum:** USDC, USDT, PAXG, XAUT, PYUSD, USD1 via `BLACKLIST_STABLECOINS` in `shared/types/index.ts`.

Implementation note: `EURC` is intentionally not live-supported right now. Circle often mirrors the same blacklist action across both USDC and EURC, which creates many zero-balance EURC rows. Pharos will only re-enable EURC if those mirrored no-balance events can be classified without hiding genuine EURC signal.

---

## Cron Schedule

- **Pattern:** `3 * * * *` (hourly at :03)
- **Function:** `syncBlacklist(db, etherscanApiKey, trongridApiKey, drpcApiKey)`
- **File:** `worker/src/cron/sync-blacklist.ts`
- **Returns:** `{ itemCount, metadata: JSON { rowsWritten, eventsFetched, contractsSkipped, apiErrors, apiErrorConfigs, zeroCursorConfigCount, zeroCursorConfigs, rpcLogConfigs, apiErrorClasses, budgetUsed, budgetLimit, runtimeBudgetReached, runtimeBudgetMs } }`

`itemCount` now reflects the number of rows actually inserted into `blacklist_events`. `metadata.eventsFetched` tracks fetched/parsed rows before `INSERT OR IGNORE` deduplication, which is useful when diagnosing repeated rescans.

---

## Blockchain Infrastructure

### Etherscan v2 API

- **Base URL:** `https://api.etherscan.io/v2/api`
- Primary source for Ethereum, Arbitrum, and Polygon blacklist log scans
- Max 1000 logs per request (recursive splitting if exceeded, max depth 8)
- Operational caveats:
  - historical `eth_call` is unreliable on L2s (we use dRPC for L2 balance lookups)
  - Base, Optimism, Avalanche, and BSC use chain RPC `eth_getLogs` scans rather than relying on explorer log coverage

### Chain RPC Log Scans

- Source: `getChainRpc()` from `worker/src/lib/chain-registry.ts`
- Base, Optimism, Avalanche, and BSC prefer chain RPC `eth_getLogs` scans because the explorer path is not treated as a reliable primary log source on those chains
- Production uses Alchemy primaries when `ALCHEMY_API_KEY` is configured, otherwise public RPC URLs from the chain registry
- Used for both chain-head discovery and log scans; timestamps are resolved via `eth_getBlockByNumber`
- Range splitting is depth-first/sequential inside `worker/src/lib/alchemy-logs.ts` so one oversized scan cannot burst past the Workers shared fetch-connection pool

### dRPC Archive Nodes (L2-specific)

- For historical balance lookups on L2 chains (Arbitrum, Base, Optimism, Polygon, Avalanche, BSC)
- **Endpoint:** `https://lb.drpc.org/ogrpc?network={network}&dkey={drpcApiKey}`
- Preferred historical balance source when `DRPC_API_KEY` is configured
- If dRPC misses, blacklist balance enrichment now falls through to the shared chain registry RPC path (`getChainRpc()`), which means Alchemy primaries are used automatically when `ALCHEMY_API_KEY` is configured, then public RPC fallbacks. Etherscan remains the last best-effort fallback for chains where it can answer historical `eth_call`.

### TronGrid API

- **Base URL:** `https://api.trongrid.io/v1/`
- **Events:** `/contracts/{address}/events?event_name={name}&limit=200&order_by=block_timestamp,desc`
- **Balances:** `/accounts/{address}` (expects 41-prefix hex, NOT 0x or base58)
- **Optional auth:** `TRON-PRO-API-KEY` header

### Rate Limiters

| Service   | Rate limit        |
| --------- | ----------------- |
| Etherscan | 4 requests/second |
| TronGrid  | 3 requests/second |

**Budget:** 900 subrequests per cron cycle, shared across all configs + backfill.
**Runtime guard:** 7-minute in-app budget with a 60-second per-config start buffer, so the job exits cleanly before the outer 8-minute `logCronRun()` timeout.

---

## Contract Configurations

**File:** `worker/src/lib/blacklist-contracts.ts`

Canonical token addresses and decimals now resolve from the shared stablecoin loader in `shared/lib/stablecoins/index.ts`, backed by `shared/data/stablecoins/*.json`. `blacklist-contracts.ts` keeps only tracker-specific chain/event configuration, with one traded-contract exception for Optimism `USDT0` sourced from the shared `tradedContracts` metadata.

### USDC (6 chains)

All use USDC events: `Blacklisted(address)`, `UnBlacklisted(address)`. Decimals: 6.

| Chain     | Address                                      |
| --------- | -------------------------------------------- |
| Ethereum  | `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48` |
| Arbitrum  | `0xaf88d065e77c8cc2239327c5edb3a432268e5831` |
| Base      | `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` |
| Optimism  | `0x0b2c639c533813f4aa9d7837caf62653d097ff85` |
| Polygon   | `0x3c499c542cef5e3811e1192ce70d8cc03d5c3359` |
| Avalanche | `0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e` |

### USDT EVM (7 configs across 6 chains, mixed event patterns)

| Chain             | Address                                      | Decimals | Events         |
| ----------------- | -------------------------------------------- | -------- | -------------- |
| Ethereum          | `0xdac17f958d2ee523a2206206994597c13d831ec7` | 6        | Legacy         |
| Arbitrum          | `0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9` | 6        | Legacy + USDT0 |
| Optimism (legacy) | `0x94b008aa00579c1307b0ef2c499ad98a8ce58e58` | 6        | Legacy         |
| Optimism (USDT0)  | `0x01bFF41798a0BcF287b996046Ca68b395DbC1071` | 6        | USDT0          |
| Polygon           | `0xc2132d05d31c914a87c6611c10748aeb04b58e8f` | 6        | Legacy + USDT0 |
| Avalanche         | `0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7` | 6        | Legacy         |
| BSC               | `0x55d398326f99059ff775485246999027b3197955` | 18       | Legacy         |

### USDT Tron

- **Address:** `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`
- **Decimals:** 6
- **Events:** Legacy (`AddedBlackList`, `RemovedBlackList`, `DestroyedBlackFunds`)

### PAXG (Paxos Gold)

- **Chain:** Ethereum
- **Address:** `0x45804880De22913dAFE09f4980848ECE6EcbAf78`
- **Decimals:** 18
- **Events:** `AddressFrozen(address)`, `AddressUnfrozen(address)`, `FrozenAddressWiped(address)`
- **Note:** `FrozenAddressWiped` does NOT include the amount in the event data -- it must be fetched via `balanceOf()` at `blockNumber - 1`.

### XAUT (Tether Gold)

- **Chain:** Ethereum
- **Address:** `0x68749665FF8D2d112Fa859AA293F07A622782F38`
- **Decimals:** 6
- **Events:** USDT0 pattern (`BlockPlaced`, `BlockReleased`, `DestroyedBlockedFunds` with indexed address)

---

## Event Signatures

### USDC Events

```
Blacklisted(address)
  Topic: 0xffa4e6181777692565cf28528fc88fd1516ea86b56da075235fa575af6a4b855
  Address: indexed (topics[1])
  hasAmount: false

UnBlacklisted(address)
  Topic: 0x117e3210bb9aa7d9baff172026820255c6f6c30ba8999d1c2fd88e2848137c4e
  Address: indexed (topics[1])
  hasAmount: false
```

### USDT Legacy Events

```
AddedBlackList(address)
  Topic: 0x42e160154868087d6bfdc0ca23d96a1c1cfa32f1b72ba9ba27b69b98a0d819dc
  Address: NOT indexed (in data)
  hasAmount: false

RemovedBlackList(address)
  Topic: 0xd7e9ec6e6ecd65492dce6bf513cd6867560d49544421d0783ddf06e76c24470c
  Address: NOT indexed (in data)
  hasAmount: false

DestroyedBlackFunds(address,uint256)
  Topic: 0x61e6e66b0d6339b2980aecc6ccc0039736791f0ccde9ed512e789a7fbdd698c6
  Address: NOT indexed (first 32 bytes of data)
  Amount: second 32 bytes of data
  hasAmount: true
```

### USDT0 Events (new Tether contracts)

```
BlockPlaced(address indexed)
  Topic: 0x406bbf2d8d145125adf1198d2cf8a67c66cc4bb0ab01c37dccd4f7c0aae1e7c7
  Address: indexed (topics[1])
  hasAmount: false

BlockReleased(address indexed)
  Topic: 0x665918c9e02eb2fd85acca3969cb054fc84c138e60ec4af22ab6ef2fd4c93c27
  Address: indexed (topics[1])
  hasAmount: false

DestroyedBlockedFunds(address indexed,uint256)
  Topic: 0x6a2859ae7902313752498feb80a014e6e7275fe964c79aa965db815db1c7f1e9
  Address: indexed (topics[1])
  Amount: first 32 bytes of data
  hasAmount: true
```

### PAXG Events

```
AddressFrozen(address indexed)
  Topic: 0x90811a8edd3b3c17eeaefffc17f639cc69145d41a359c9843994dc2538203690

AddressUnfrozen(address indexed)
  Topic: 0xc3776b472ebf54114339eec9e4dc924e7ce307a97f5c1ee72b6d474e6e5e8b7c

FrozenAddressWiped(address indexed)
  Topic: 0xfc5960f1c5a5d2b60f031bf534af053b1bf7d9881989afaeb8b1d164db23aede
  Amount: NOT in event; requires balanceOf() at blockNumber-1
```

---

## Database Schema

### blacklist_events table

**Migrations:** baseline schema in `worker/migrations/0000_baseline.sql`, plus `0076_blacklist_provenance_and_amount_semantics.sql` and `0077_blacklist_amount_recovery_telemetry.sql`. Historical pre-squash index/version additions are tracked in [`worker/migrations/MANIFEST.md`](../worker/migrations/MANIFEST.md).

```sql
CREATE TABLE blacklist_events (
  id TEXT PRIMARY KEY,
  stablecoin TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  chain_name TEXT NOT NULL,
  event_type TEXT NOT NULL,
  address TEXT NOT NULL,
  amount REAL,
  amount_native REAL,
  amount_usd_at_event REAL,
  amount_source TEXT NOT NULL DEFAULT 'unavailable',
  amount_status TEXT NOT NULL DEFAULT 'recoverable_pending',
  tx_hash TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  methodology_version TEXT NOT NULL DEFAULT '3.1',
  contract_address TEXT,
  config_key TEXT,
  event_signature TEXT,
  event_topic0 TEXT,
  amount_attempt_count INTEGER NOT NULL DEFAULT 0,
  amount_last_attempted_at INTEGER,
  amount_last_error_class TEXT,
  amount_last_provider TEXT,
  explorer_tx_url TEXT NOT NULL,
  explorer_address_url TEXT NOT NULL
);

CREATE INDEX idx_be_timestamp ON blacklist_events(timestamp DESC);
CREATE INDEX idx_be_stablecoin ON blacklist_events(stablecoin);
CREATE INDEX idx_be_chain_name ON blacklist_events(chain_name);
CREATE INDEX idx_be_event_type ON blacklist_events(event_type);
CREATE INDEX idx_blacklist_events_chain_ts ON blacklist_events(chain_name, timestamp DESC);
CREATE INDEX idx_blacklist_events_config_key ON blacklist_events(config_key);
CREATE INDEX idx_blacklist_events_amount_status ON blacklist_events(amount_status);
```

**Row ID format:** `{chainId}-{txHash}-{logIndex}` -- ensures uniqueness via `INSERT OR IGNORE`.

**event_type values:** `"blacklist"`, `"unblacklist"`, `"destroy"`

**Amount semantics**

- `amount_native` is the canonical token-native quantity for the event
- `amount_usd_at_event` is populated only when Pharos can justify an event-time USD valuation
- `amount_source` records where the value came from (`event`, `historical_balance`, `derived`, `unavailable`)
- `amount_status` records whether the amount is resolved, recoverable, or intentionally unavailable
- `amount_attempt_count` records how many historical-recovery attempts Pharos has made for the row
- `amount_last_attempted_at`, `amount_last_error_class`, and `amount_last_provider` are operator diagnostics for unresolved rows

### blacklist_sync_state table

**Migration:** baseline schema in `worker/migrations/0000_baseline.sql`

```sql
CREATE TABLE blacklist_sync_state (
  config_key TEXT PRIMARY KEY,
  last_block INTEGER NOT NULL DEFAULT 0
);
```

**Config key format:**

| Chain type | Format                        | Example                                   |
| ---------- | ----------------------------- | ----------------------------------------- |
| EVM        | `{chainId}-{contractAddress}` | `ethereum-0xa0b86991...`                  |
| Tron       | `tron-{contractAddress}`      | `tron-TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` |

For EVM configs, the stored contract-address segment is canonicalized to lowercase on write. Reads merge both lowercase and legacy mixed-case keys so older cursor rows keep working after contract metadata switches to checksum casing.

**Important:** For EVM chains, `last_block` stores block numbers. For Tron, it stores millisecond timestamps (NOT block numbers).
For RPC log-scan chains (Base, Optimism, Avalanche, BSC), partial `eth_getLogs` coverage now advances `last_block` to the highest contiguous block that was fully scanned so backlogs catch up across runs instead of restarting from `0`.

---

## Sync Flow

### Execution Order (each cron cycle)

1. **Backfill** (runs FIRST to prioritize budget)
   - Targets rows with NULL amount only
   - Orders newest rows first so fresh gaps clear before archival backlog
   - Batch size: 50 rows per cycle
   - Confirmed zero balances are treated as complete and are not retried
   - Fetches historical balances via RPC or API

2. **Incremental scan** (per contract config)
   - EVM: fetch logs from `lastBlock + 1` to latest via Etherscan `getLogs` or chain RPC `eth_getLogs`
   - Selected RPC-log configs seed empty cursors from known contract deployment blocks instead of scanning from genesis
   - RPC-log chains scan in bounded windows per run (provider-aware for Alchemy vs public fallback) so successful empty windows still advance the cursor
   - Tron: fetch events from `lastTimestamp` via TronGrid `/contracts/{addr}/events`
   - Parse events into `BlacklistRow` objects
   - If the runtime guard is nearly exhausted, the cron stops before starting another config and defers the remainder to the next cycle

3. **Balance enrichment** (in-memory, before DB insertion)
   - Enrich parsed rows with balances BEFORE inserting into D1
   - EVM Ethereum: Etherscan `eth_call` at historical block (`blockNumber - 1`)
   - EVM L2/sidechain: dRPC archive node first when configured, then `getChainRpc()` (Alchemy/public RPC), then Etherscan best-effort
   - Tron: TronGrid `/accounts/{addr}` (convert `0x` to `41` prefix)
   - RPC-log chains reuse persistent block-timestamp cache rows to avoid re-resolving the same blocks every run
   - `INSERT OR IGNORE` enriched rows into `blacklist_events`

4. **Sync state advancement**
   - EVM: advance to max block of fetched events, or to the active source's chain head minus safety margin if no events
   - EVM RPC partial coverage: if `eth_getLogs`/timestamp resolution only completes part of the range, advance to the highest contiguous fully scanned block and retry the remainder next cycle
   - Tron: advance to max timestamp, or to `now - TRON_SAFETY_MS` if no events

### Safety Margins

```
INDEXING_SAFETY_SEC = 900 (15 minutes)
TRON_SAFETY_MS = 900,000 ms
```

Per-chain block margins (`INDEXING_SAFETY_SEC / blockTime`):

| Chain     | Safety margin (blocks) | Block time |
| --------- | ---------------------- | ---------- |
| Ethereum  | 75                     | 12s        |
| Arbitrum  | 3,600                  | 0.25s      |
| Base      | 450                    | 2s         |
| Optimism  | 450                    | 2s         |
| Polygon   | 450                    | 2s         |
| Avalanche | 450                    | 2s         |
| BSC       | 300                    | 3s         |

---

## Balance Enrichment

### EVM Strategy

1. **Ethereum mainnet:** Etherscan `eth_call` with historical block tag (`blockNumber - 1`)
2. **L2 with dRPC key:** dRPC archive node `eth_call` at historical block
3. **L2 RPC fallback:** if dRPC misses, `getChainRpc()` retries the same historical `eth_call` against the configured chain RPCs (Alchemy primary when available, then public fallback)
4. **Best-effort explorer fallback:** Etherscan `eth_call` with historical block tag (same code path as Ethereum, but some non-mainnet explorer paths may silently ignore the block tag or reject it entirely)

### Tron Strategy

- Convert address: `0x` prefix to `41` prefix (TronGrid requirement)
- API: `GET /v1/accounts/{tronAddress}`
- Extract TRC20 balance: `data[0].trc20[contractAddress]`
- Empty account (`data === []`): return 0, not null

### Destroy Amount Recovery

For destroy events, try fetching from transaction receipt first (`eth_getTransactionReceipt` then parse matching event log). Fall back to `balanceOf` if receipt parsing fails.

---

## API Endpoint

### GET /api/blacklist

**File:** `worker/src/api/blacklist.ts`
**Cache:** realtime profile (`s-maxage=60`, `max-age=10`). Freshness headers with 900s TTL.

**Query parameters:**

| Param        | Type   | Default | Description                                                          |
| ------------ | ------ | ------- | -------------------------------------------------------------------- |
| `limit`      | number | 1000    | Max results (1-1000; `0` maps to default `1000`)                     |
| `offset`     | number | 0       | Pagination offset                                                    |
| `stablecoin` | string | --      | Filter by name (`"USDC"`, `"USDT"`, `"PAXG"`, `"XAUT"`, `"PYUSD"`, `"USD1"`)  |
| `chain`      | string | --      | Filter by `chain_name`                                               |
| `eventType`  | string | --      | Filter by `event_type` (`"blacklist"`, `"unblacklist"`, `"destroy"`) |
| `q`          | string | --      | Case-insensitive address substring search                            |
| `sortBy`     | string | date    | Sort field (`"date"`, `"stablecoin"`, `"chain"`, `"event"`)          |
| `sortDirection` | string | desc | Sort direction (`"asc"`, `"desc"`)                                   |

The handler now exposes only the live-supported symbols: USDC, USDT, PAXG, XAUT, PYUSD, and USD1.

**Response:**

```json
{
  "events": [
    {
      "id": "ethereum-0x...",
      "stablecoin": "USDC",
      "chainId": "ethereum",
      "chainName": "Ethereum",
      "eventType": "blacklist",
      "address": "0x...",
      "amountNative": 12345.67,
      "amountUsdAtEvent": 12345.67,
      "amountSource": "historical_balance",
      "amountStatus": "resolved",
      "txHash": "0x...",
      "blockNumber": 20000000,
      "timestamp": 1704067200,
      "contractAddress": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      "configKey": "ethereum-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      "eventSignature": "Blacklisted(address)",
      "eventTopic0": "0xffa4e6181777692565cf28528fc88fd1516ea86b56da075235fa575af6a4b855",
      "explorerTxUrl": "https://etherscan.io/tx/0x...",
      "explorerAddressUrl": "https://etherscan.io/address/0x..."
    }
  ],
  "total": 12345,
  "methodology": {
    "version": "3.2",
    "versionLabel": "v3.2",
    "currentVersion": "3.2",
    "currentVersionLabel": "v3.2",
    "changelogPath": "/methodology/blacklist-tracker-changelog/",
    "asOf": 1704067200,
    "isCurrent": true
  }
}
```

### GET /api/blacklist-summary

**File:** `worker/src/api/blacklist-summary.ts`
**Cache:** realtime profile (`s-maxage=60`, `max-age=10`). Freshness headers with 900s TTL.

Returns server-side aggregate stats, quarterly chart buckets, supported chain filters, and total event count for the blacklist UI.

---

## Admin Endpoints

### POST /api/reset-blacklist-sync

Requires Access service-token headers on `ops-api.pharos.watch`.  Rolls back sync state:

- EVM: subtract 50,000 blocks (~7 days on Ethereum)
- Tron: subtract 604,800,000 ms (7 days)
- Returns: `{ ok: true, evmReset: N, tronReset: M }`

### GET /api/debug-sync-state

Requires Access service-token headers on `ops-api.pharos.watch`.  Returns all sync state rows.

### POST /api/remediate-blacklist-amount-gaps

Requires Access service-token headers on `ops-api.pharos.watch`. Runs a bounded admin remediation pass for recoverable blacklist rows.

Recommended flow:

1. run with `dryRun=true`
2. target a narrow cohort such as Avalanche `USDC`
3. then execute a small write-enabled batch

Supported inputs:

- `chainId`
- `stablecoin`
- `limit`
- `dryRun`
- `onlyMissingProvenance`
- `maxAttempts`

All blacklist admin endpoints are routed in `worker/src/route-registry.ts` and executed via `worker/src/handlers/http.ts`.

---

## Frontend

### Hook

**File:** `src/hooks/use-blacklist-events.ts`
**Endpoints:** `GET /api/blacklist-summary` + `GET /api/blacklist`
**Cache:** `staleTime: 20 min`, `refetchInterval: 40 min`

The summary hook loads aggregate cards/chart/filter metadata from the dedicated summary endpoint. The page hook fetches only the currently requested table slice, including server-side filtering, sorting, search, and pagination.

### Page: /blacklist

**File:** `src/app/blacklist/page.tsx`

| Component        | File                                   | Description                                                                                     |
| ---------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| BlacklistFilters | `src/components/blacklist-filters.tsx` | Stablecoin, chain, event type dropdowns                                                         |
| Search           | (inline)                               | Server-backed address search                                                                    |
| BlacklistTable   | `src/components/blacklist-table.tsx`   | Server-sorted, 50 rows per page                                                                 |
| BlacklistStats   | `src/components/blacklist-stats.tsx`   | USDC/USDT unique blacklisted addresses, gold frozen, total destroyed funds, recent events (30d) |
| BlacklistChart   | `src/components/blacklist-chart.tsx`   | Quarterly stacked bar chart of blacklisted funds by stablecoin                                  |
| CSV export       | (inline)                               | Download filtered events as CSV                                                                 |

### Amount Display Logic

- `null` or (`0` and not destroy): show "--"
- Gold coins (PAXG, XAUT): 4 decimal places + symbol (converted to USD using live price)
- Stablecoins (USDC, USDT): `formatCurrency` (USD)

### Special UI Components

| Component         | Description                                                           |
| ----------------- | --------------------------------------------------------------------- |
| UsdsStatusCard    | Monitors USDS for freeze capability (currently none)                  |
| EurcBlacklistCard | Explains EURC/USDC simultaneous freezes and zero-balance EURC entries |

---

## Environment Variables

| Variable            | Type   | Required | Description                                                          |
| ------------------- | ------ | -------- | -------------------------------------------------------------------- |
| `ETHERSCAN_API_KEY` | Secret | Yes      | Etherscan v2 API key for supported-chain log scans + L1 calls        |
| `TRONGRID_API_KEY`  | Secret | No       | TronGrid Pro API key (improves rate limits)                          |
| `DRPC_API_KEY`      | Secret | No       | dRPC key for L2 archive node balance lookups                         |
| `ALCHEMY_API_KEY`   | Secret | No       | Preferred chain RPC source for Base/Optimism/Avalanche/BSC log scans; strongly recommended for faster historical catch-up on zero-cursor configs |

---

## Known Gotchas

1. **Tron address format:** events return `0x`-prefix hex; TronGrid API requires `41`-prefix hex.
2. **Tron empty accounts:** `{ success: true, data: [] }` means 0 balance, NOT an API error.
3. **Tron sync state uses millisecond timestamps**, NOT block numbers.
4. **USDT has TWO event patterns:** legacy (`AddedBlackList`, address NOT indexed) and USDT0 (`BlockPlaced`, address indexed). Some chains (Arbitrum, Polygon) emit both.
5. **PAXG FrozenAddressWiped** has no amount in the event -- must fetch via `balanceOf` at `blockNumber - 1`.
6. **XAUT uses USDT0 event pattern** (was mistakenly using legacy pattern until 2026-02-11 fix).
7. **Explorer historical calls on L2s** are not dependable enough to be primary -- rely on dRPC first, then chain-RPC/Alchemy fallback; explorer fallback is best-effort only.
8. **Base, Optimism, Avalanche, and BSC log scans** use chain RPC `eth_getLogs` paths instead of depending on explorer log coverage.
9. **EVM sentinel bug (fixed):** storing `99999999` as `last_block` could cause permanent scan stall.
10. **Budget limit (900 subrequests)** is shared across ALL configs + backfill per cron cycle.
11. **Partial RPC scans now preserve progress:** incomplete Base/Optimism/Avalanche/BSC log scans still advance to the highest safely covered block, so large first-sync backlogs drain over multiple cron runs instead of re-scanning genesis every time.
12. **Circle actions can hit USDC + EURC together** -- expect matching addresses across both tickers, and many EURC rows may show zero balance at blacklist time.
13. **Legacy mixed-case cursor rows:** older runs may have stored checksum-cased EVM addresses in `blacklist_sync_state`; current reads merge those with lowercase canonical keys to avoid duplicate cursors and redundant rescans.
14. **RPC bootstrap guards:** Avalanche USDC, Avalanche USDT, and BSC USDT now start from known deployment blocks, and RPC-log scans use bounded per-run block windows. This prevents empty zero-cursor configs from repeatedly attempting impractical genesis-to-head scans.
15. **Recoverable-gap telemetry is row-level:** use `amount_attempt_count`, `amount_last_error_class`, and `amount_last_provider` to diagnose stranded historical rows instead of inferring from null amounts alone.

---

## File Index

| File                                                       | Role                                                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `worker/src/cron/sync-blacklist.ts`                        | Main cron: incremental scan, backfill, balance enrichment, sync state                      |
| `worker/src/lib/blacklist-contracts.ts`                    | Blacklist event configs: chains, event signatures, and shared-contract resolution rules    |
| `worker/src/lib/evm-logs.ts`                               | Etherscan v2 log fetching, recursive splitting, rate limiting, `decodeUint256`             |
| `worker/src/api/blacklist.ts`                              | `GET /api/blacklist` handler                                                               |
| `worker/src/route-registry.ts`                             | API route dispatch, including admin endpoints (`reset-blacklist-sync`, `debug-sync-state`, `remediate-blacklist-amount-gaps`) |
| `worker/src/handlers/scheduled.ts`                         | Cron scheduling orchestration for `sync-blacklist`                                         |
| `worker/src/lib/db.ts`                                     | `getLastBlock()`, `setLastBlock()`, `batchExecute()`                                       |
| `worker/migrations/0000_baseline.sql`                      | Baseline blacklist schema, including `blacklist_events`, `blacklist_sync_state`, and the pre-0072 index/version additions |
| `worker/migrations/0076_blacklist_provenance_and_amount_semantics.sql` | Adds amount provenance and semantics columns                                  |
| `worker/migrations/0077_blacklist_amount_recovery_telemetry.sql` | Adds recovery-attempt telemetry for unresolved amount rows                       |
| `src/hooks/use-blacklist-events.ts`                        | TanStack Query hook                                                                        |
| `src/app/blacklist/page.tsx`                               | Blacklist page with filters, stats, chart, table                                           |
| `src/components/blacklist-filters.tsx`                     | Filter UI (stablecoin, chain, event type)                                                  |
| `src/components/blacklist-table.tsx`                       | Sortable paginated table                                                                   |
| `src/components/blacklist-stats.tsx`                       | Summary statistics cards                                                                   |
| `src/components/blacklist-chart.tsx`                       | Quarterly stacked bar chart                                                                |
