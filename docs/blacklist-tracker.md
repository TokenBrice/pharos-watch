# Blacklist Tracker

Multi-chain blacklist/freeze event tracker for stablecoins. Monitors on-chain events (blacklist, unblacklist, destroy/seize) across 71 contract configurations on 9 chains (35 tracked symbols; deferred coverage is reported from the runtime coverage manifest and is currently 10 known configs). Runs every 6 hours, incrementally scanning from the last processed block or timestamp cursor.

## Methodology Versioning

- **Current methodology version:** `v3.9972`
- **Runtime/version source:** `shared/lib/blacklist-tracker-version.ts`
- **Public changelog route:** `/methodology/blacklist-tracker-changelog/`
- **Version timeline:** [blacklist-tracker-timeline.md](./blacklist-tracker-timeline.md)

The tracker now has two distinct amount layers:

- `blacklist_events` stores event-time amounts only when Pharos can justify them historically
- `blacklist_current_balances` stores last-known successful persistent freeze-ledger snapshots used by the public frozen-total summary
- the `/freezewatch` tracked frozen total chart appears after the exposure summary and before the event ledger
- the `/freezewatch` status charts now support on-page drilldown into the matching stablecoin subset for each blacklistability bucket
- the `/freezewatch` summary cards now include an unfreezable market-share stat: blacklist-status `No` market cap divided by total tracked stablecoin market cap

**Cron-backed sync coverage:** USDC, USDT, PAXG, XAUT, PYUSD, USD1, USDG, RLUSD, U, USDtb, A7A5, FDUSD, BRZ, AUSD, MNEE, EURI, USDQ, USDO, USDX, AID, TGBP, EURC, BUIDL, USDP, TUSD, NUSD, EURCV, USDA, USAT, AEUR, XUSD, XAUm, JPYC, FRXUSD, FIDD.

**Live API/UI filter enum:** USDC, USDT, PAXG, XAUT, PYUSD, USD1, USDG, RLUSD, U, USDTB, A7A5, FDUSD, BRZ, AUSD, MNEE, EURI, USDQ, USDO, USDX, AID, TGBP, EURC, BUIDL, USDP, TUSD, NUSD, EURCV, USDA, USAT, AEUR, XUSD, XAUM, JPYC, FRXUSD, FIDD via `BLACKLIST_STABLECOINS` in `shared/types/market.ts` (re-exported through `shared/types/index.ts`).

Every stablecoin ID wired into `CONTRACT_CONFIGS` must resolve to direct `Freezable: Yes` in shared metadata/report-card status. `worker/src/lib/__tests__/blacklist-contracts.test.ts` guards this so direct tracker coverage does not show as only upstream-inherited exposure on `/freezewatch`.

Implementation note: `EURC` is live-supported with mirror-zero suppression. Circle often mirrors the same blacklist action across both USDC and EURC; rows classified as zero-balance mirrors stay auditable in storage but are excluded from public `/api/blacklist` events, active records, and frozen-value aggregates.

## Visible `/freezewatch` Exposure Contract

The public `/freezewatch` exposure summary uses `blacklistStatusBuckets` from `buildBlacklistStatusBuckets()` and the same four-status resolved model as report-card-backed product surfaces:

- `yes` means direct issuer blacklist, freeze, seizure, or equivalent holder-facing control.
- `upstream` means any reserve, backing, custody, parent-asset, or CEX/custody-rail exposure can freeze or block value upstream of the token. This is an any-reserve policy: a matched reserve path does not need to be majority-weighted to resolve as Upstream.
- `possible` is reserved for curated direct token/vault pause, freeze, blacklist, or mutable holder-facing control surfaces that are not confirmed active direct blacklist controls.
- `no` means no resolved exposure in the current model.

Observed event history stays in the event ledger. Event counts are observed supported tracker history, not policy probability, and the current summary payload is symbol-level only; the UI must not label those rows as contract-level event totals.

---

## Cron Schedule

- **Pattern:** `3 */6 * * *` (every 6 hours at :03)
- **Function:** `syncBlacklist(opts: SyncBlacklistOptions)`
- **File:** `worker/src/cron/sync-blacklist.ts`
- **Caller contract:** the 6-hourly handler passes `db`, provider keys, `chainRpcs`, optional abort signal, and cron progress hooks via `SyncBlacklistOptions`
- **Returns:** `{ itemCount, metadata: JSON { rowsWritten, eventsFetched, contractsSkipped, apiErrors, apiErrorConfigs, zeroCursorConfigCount, zeroCursorConfigs, configsAttempted, configsSucceeded, coverageFailures, stateConflicts, coverageOutcomeCounts, blacklistProviderCalls, maxProviderSplitDepth, oldestConfigSuccessAt, oldestConfigSuccessAgeSec, configsNeverSucceeded, rpcLogConfigs, providerCircuitSkips, etherscanCircuitSkips, tronGridCircuitSkips, apiErrorClasses, runtimeBudgetReached, subrequestBudgetReached, runtimeBudgetMs, incompleteRuntimeConfigs, enrichAttempted, enrichSucceeded, enrichFailed, currentBalanceCacheUpdated, currentBalanceCacheDeleted, currentBalanceCacheFailed, tronLedgerUpdated, producerGapMetricSnapshots, producerSummarySnapshot, producerSnapshotSkipped, producerSnapshotError, producerSnapshotWindowMs, producerSnapshotWindowUnavailable, budgetUsed, budgetLimit } }`

`itemCount` now reflects the number of rows actually inserted into `blacklist_events`. `metadata.eventsFetched` tracks fetched/parsed rows before `INSERT OR IGNORE` deduplication, which is useful when diagnosing repeated rescans.

---

## Blockchain Infrastructure

### Etherscan v2 API

- **Base URL:** `https://api.etherscan.io/v2/api`
- Primary source for Ethereum, Arbitrum, and Polygon blacklist log scans
- Max 1000 logs per request (recursive splitting if exceeded, max depth 8)
- Operational caveats:
  - historical `eth_call` can be unreliable (dRPC is now the preferred balance source for all EVM chains including mainnet)
- Base, Optimism, Avalanche, BSC, and Gnosis use chain RPC `eth_getLogs` scans rather than relying on explorer log coverage

### Chain RPC Log Scans

- Source: `getChainRpc()` from `worker/src/lib/chain-registry.ts`
- Base, Optimism, Avalanche, BSC, and Gnosis prefer chain RPC `eth_getLogs` scans because the explorer path is not treated as a reliable primary log source on those chains
- Production uses Alchemy primaries when `ALCHEMY_API_KEY` is configured, otherwise public RPC URLs from the chain registry
- Used for both chain-head discovery and log scans; timestamps are resolved via `eth_getBlockByNumber`
- Range splitting is depth-first/sequential inside `worker/src/lib/alchemy-logs.ts` so one oversized scan cannot burst past the Workers shared fetch-connection pool

### dRPC Archive Nodes (all EVM chains including mainnet)

- For historical balance lookups on all EVM chains (Ethereum, Arbitrum, Base, Optimism, Polygon, Avalanche, BSC)
- **Endpoint:** `https://lb.drpc.org/ogrpc?network={network}&dkey={drpcApiKey}`
- Preferred historical balance source when `DRPC_API_KEY` is configured
- Ethereum mainnet historical balance lookups now try dRPC and chain-RPC before Etherscan, eliminating the single-provider-failure blind spot that previously affected ~60% of events
- If dRPC misses, blacklist balance enrichment now falls through to the shared chain registry RPC path (`getChainRpc()`), which means Alchemy primaries are used automatically when `ALCHEMY_API_KEY` is configured, then public RPC fallbacks. Etherscan remains the last best-effort fallback for chains where it can answer historical `eth_call`.

### TronGrid API

- **Base URL:** `https://api.trongrid.io/v1/`
- **Events:** `/contracts/{address}/events?event_name={name}&limit=200&order_by=block_timestamp,asc`
- **Current balances:** JSON-RPC `eth_call` (`balanceOf`) against `https://api.trongrid.io/jsonrpc` first, falling back to REST `/accounts/{address}` when that returns null (Pharos converts stored Tron hex addresses to base58 for the REST path)
- **Optional auth:** `TRON-PRO-API-KEY` header

### Rate Limiters

| Service   | Rate limit        |
| --------- | ----------------- |
| Etherscan | 4 requests/second |
| TronGrid  | 3 requests/second |

**Budget:** 900 subrequests per cron cycle, shared across all configs + backfill.
**Runtime guard:** 10-minute in-app budget with a 60-second per-config start buffer, so the job exits cleanly before the outer 12-minute cron timeout enforced in `worker/src/lib/cron-lease.ts`.

---

## Contract Configurations

**File:** `worker/src/lib/blacklist-contracts.ts`

Canonical token addresses and decimals now resolve from the shared stablecoin registry in `shared/lib/stablecoins/registry.ts`, backed by per-coin metadata in `shared/data/stablecoins/coins/*.json` and the generated aggregate `shared/data/stablecoins/coins.generated.json`. `blacklist-contracts.ts` keeps only tracker-specific chain/event configuration, with one traded-contract exception for Optimism `USDT0` sourced from the shared `tradedContracts` metadata.

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

### PYUSD (PayPal USD)

| Chain    | Address                                      | Decimals | Events       |
| -------- | -------------------------------------------- | -------- | ------------ |
| Ethereum | `0x6c3ea9036406852006290770bedfcaba0e23a0e8` | 6        | Paxos freeze |
| Arbitrum | `0x46850ad61c2b7d64d08c9c754f45254596696984` | 6        | Paxos freeze |

### USD1 (World Liberty Financial USD)

| Chain    | Address                                      | Decimals | Events                                                                                                |
| -------- | -------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------- |
| Ethereum | `0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d` | 18       | Dual-index freeze/unfreeze plus WLFI `FrozenAccountDrained` / `FrozenFundsReallocated` destroy events |
| BSC      | `0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d` | 18       | Dual-index freeze/unfreeze plus WLFI `FrozenAccountDrained` / `FrozenFundsReallocated` destroy events |
| Tron     | `TPFqcBAaaUMCSVRCqPaQ9QnzKhmuoLR6Rc`         | 18       | Dual-index freeze/unfreeze plus WLFI `FrozenAccountDrained` / `FrozenFundsReallocated` destroy events |

### USDG (Global Dollar)

- **Chain:** Ethereum
- **Address:** `0xe343167631d89b6ffc58b88d6b7fb0228795491d`
- **Decimals:** 6
- **Events:** Paxos freeze pattern (`FreezeAddress`, `UnfreezeAddress`, `FrozenAddressWiped`)
- **Note:** `FrozenAddressWiped` does not emit an amount; Pharos recovers value with `balanceOf()` at `blockNumber - 1`.

### RLUSD (Ripple USD)

- **Chain:** Ethereum
- **Address:** `0x8292bb45bf1ee4d140127049757c2e0ff06317ed`
- **Decimals:** 18
- **Events:** `AccountPaused(address)`, `AccountUnpaused(address)`
- **Note:** RLUSD `clawback(address,uint256)` is not event-covered because the verified ABI does not expose a dedicated clawback event. Tracking clawbacks would require transaction-input classification over token burn/transfer logs.

### U (United Stables)

| Chain    | Address                                      | Decimals | Events            |
| -------- | -------------------------------------------- | -------- | ----------------- |
| Ethereum | `0xce24439f2d9c6a2289f741120fe202248b666666` | 18       | Dual-index freeze |
| BSC      | `0xce24439f2d9c6a2289f741120fe202248b666666` | 18       | Dual-index freeze |

### USDtb (Ethena / Anchorage)

- **Chain:** Ethereum
- **Address:** `0xc139190f447e929f090edeb554d95abb8b18ac1c`
- **Decimals:** 18
- **Events:** `AccountsBlocked(address[])`, `AccountsUnblocked(address[])`
- **Note:** One batch log expands into one `blacklist_events` row per affected address. Row IDs append the array index after `{chainId}-{txHash}-{logIndex}`.

### A7A5 (Old Vector)

- **Chain:** Ethereum
- **Address:** `0x6fa0be17e4bea2fcfa22ef89bf8ac9aab0ab0fc9`
- **Decimals:** 6
- **Events:** `Blacklisted(address)`, `DeBlacklisted(address)`, `DestroyedBlackFunds(address,uint256)`
- **Note:** A7A5 is RUB-pegged. USD values use a fresh `a7a5-old-vector` price-cache entry instead of assuming native units equal dollars.

### USDA (Avalon)

- **Chain:** Ethereum
- **Address:** `0x8a60e489004ca22d775c5f2c657598278d17d9c2`
- **Decimals:** 18
- **Events:** `AddedBlackList(address)`, `RemovedBlackList(address)`
- **Note:** The verified USDa contract also exposes role-gated `burn(address,uint256)` and blocks transfers where either side is `isBlackListed`, so the asset is directly freezable. It does not expose Tether's `DestroyedBlackFunds(address,uint256)` event, so Pharos does not map USDa burns into blacklist-tracker `destroy` rows.

### Direct EVM coverage wave (v3.9)

| Asset | Chain(s)                                              | Events                                                                                                                              | Notes                                                                                                           |
| ----- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| FDUSD | Ethereum, BSC, Arbitrum                               | `Freeze(address,address)`, `Unfreeze(address,address)`                                                                              | Dual-index account address in `topics[2]`                                                                       |
| BRZ   | Ethereum, Gnosis                                      | `Blacklisted(address)`, `UnBlacklisted(address)`                                                                                    | Indexed address; BRL-denominated USD conversion                                                                 |
| AUSD  | Arbitrum, Base                                        | `AccountFrozen(address)`, `AccountUnfrozen(address)`                                                                                | Indexed address                                                                                                 |
| MNEE  | Ethereum                                              | `AccountFrozen(address)`, `AccountUnfrozen(address)`, `FundsConfiscated(address,uint256,address)`, `HoldingsBurnt(address,uint256)` | Confiscation/burn amounts are indexed in `topics[2]`; AccountBlacklisted/AccountDelisted intentionally deferred |
| EURI  | Ethereum, BSC                                         | `Freeze(address,address)`, `Unfreeze(address,address)`                                                                              | Dual-index account address; EUR-denominated USD conversion                                                      |
| USDQ  | Ethereum, Polygon                                     | `BlockPlaced(address)`, `BlockReleased(address)`, `DestroyedBlockedFunds(address,uint256)`                                          | USDT0/Hadron pattern                                                                                            |
| USDO  | Ethereum, Base                                        | `AccountBanned(address)`, `AccountUnbanned(address)`                                                                                | Indexed address                                                                                                 |
| USDX  | Ethereum                                              | `AddedBlacklist(address)`, `RemovedBlacklist(address)`                                                                              | Non-indexed address in data                                                                                     |
| AID   | Ethereum, Arbitrum                                    | `AddedToDenyList(address[])`, `RemovedFromDenyList(address[])`                                                                      | Dynamic address-array event expands to one row per address; Base remains deferred                               |
| TGBP  | Ethereum, Avalanche, Polygon                          | `Banned(address)`, `UnBanned(address)`                                                                                              | Indexed address; GBP-denominated USD conversion; Base and BSC remain deferred                                   |
| EURC  | Ethereum, Base, Avalanche                             | `Blacklisted(address)`, `UnBlacklisted(address)`                                                                                    | Circle mirror-zero rows are preserved with suppression metadata and excluded from public aggregates             |
| USDP  | Ethereum                                              | `FreezeAddress(address)`, `UnfreezeAddress(address)`, `FrozenAddressWiped(address)`                                                 | Same freeze pattern as PYUSD/USDG (Paxos family)                                                                |
| BUIDL | Ethereum, BSC, Optimism, Arbitrum, Avalanche, Polygon | `Seize(address,address,uint256,string)`, `OmnibusSeize(address,address,uint256,string,uint8)`                                       | Seize-only coverage mapped to `destroy`; not a live blacklist/freeze state                                      |

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

USDA (Avalon) uses the first two legacy `AddedBlackList` / `RemovedBlackList`
signatures only. Its verified contract has a role-gated burn function but no
`DestroyedBlackFunds` event, so USDa is intentionally excluded from this
destroy-event signature.

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

### Paxos Freeze Events (PYUSD, USDG)

```
FreezeAddress(address indexed)
  Topic: 0x1aa660498c83ea285bc55e4cfc00afcaa7120798db87b74f3c0d7c6e001bc392
  Address: indexed (topics[1])
  hasAmount: false

UnfreezeAddress(address indexed)
  Topic: 0x150465b020dfc06a59269da94ed66db9b65a516cf4fdd5f583b0f12752339bbe
  Address: indexed (topics[1])
  hasAmount: false

FrozenAddressWiped(address indexed)
  Topic: 0xfc5960f1c5a5d2b60f031bf534af053b1bf7d9881989afaeb8b1d164db23aede
  Amount: NOT in event; requires balanceOf() at blockNumber-1
```

### Dual-Index Freeze Events (USD1, U)

```
Freeze(address indexed caller, address indexed account)
  Topic: 0x51d18786e9cb144f87d46e7b796309ea84c7c687d91e09c97f051eacf59bc528
  Address: indexed account (topics[2])
  hasAmount: false

Unfreeze(address indexed caller, address indexed account)
  Topic: 0x4f3ab9ff0cc4f039268532098e01239544b0420171876e36889d01c62c784c79
  Address: indexed account (topics[2])
  hasAmount: false
```

### RLUSD Events

```
AccountPaused(address)
  Topic: 0xae7f60c1b8f645c3beffeb531169cbc446874bbf247698325318879ac850c346
  Address: NOT indexed (first 32 bytes of data)
  hasAmount: false

AccountUnpaused(address)
  Topic: 0x0c18efbde61ac471ead6960a3f1097735c68ecdb685ae8e2a108c28385399a65
  Address: NOT indexed (first 32 bytes of data)
  hasAmount: false
```

### USDtb Events

```
AccountsBlocked(address[])
  Topic: 0x5444f9841c04ce78987f28701fa07fc4c112840c1c8439e8f52bda50c3788a87
  Address list: ABI-encoded dynamic address[] in data
  hasAmount: false

AccountsUnblocked(address[])
  Topic: 0x4a637dd1cd99ae43d353009d0ffbc16b05cc69808b819ebf852c68ea47b34dd4
  Address list: ABI-encoded dynamic address[] in data
  hasAmount: false
```

### A7A5 Events

```
Blacklisted(address)
  Topic: 0xffa4e6181777692565cf28528fc88fd1516ea86b56da075235fa575af6a4b855
  Address: NOT indexed (first 32 bytes of data)
  hasAmount: false

DeBlacklisted(address)
  Topic: 0x8e6c9e5ceff66044a0b27759779a9be2e7c99655252b235ff3f754efb6b8a616
  Address: NOT indexed (first 32 bytes of data)
  hasAmount: false

DestroyedBlackFunds(address,uint256)
  Topic: 0x61e6e66b0d6339b2980aecc6ccc0039736791f0ccde9ed512e789a7fbdd698c6
  Address: NOT indexed (first 32 bytes of data)
  Amount: second 32 bytes of data
  hasAmount: true
```

### Wave 2A Direct EVM Events

```
AccountFrozen(address indexed)
  Topic: 0x4f2a367e694e71282f29ab5eaa04c4c0be45ac5bf2ca74fb67068b98bdc2887d
  Address: indexed (topics[1])
  hasAmount: false

AccountUnfrozen(address indexed)
  Topic: 0xf915cd9fe234de6e8d3afe7bf2388d35b2b6d48e8c629a24602019bde79c213a
  Address: indexed (topics[1])
  hasAmount: false

FundsConfiscated(address indexed,uint256 indexed,address indexed)
  Topic: 0x5a592536e075e29026312219123e24de374314962469686d4c992d3c7292c1b4
  Address: indexed (topics[1])
  Amount: indexed uint256 (topics[2])
  hasAmount: true

HoldingsBurnt(address indexed,uint256 indexed)
  Topic: 0x1b560ad975f2a2685fce792af7ad191c5f1c0bfbbf108c676319be3ccb014ddf
  Address: indexed (topics[1])
  Amount: indexed uint256 (topics[2])
  hasAmount: true

AccountBanned(address indexed)
  Topic: 0xf5ccd95e2294edead25b59a71c189b3543cffbde2ec0d763800bdcc8807c7c3e
  Address: indexed (topics[1])
  hasAmount: false

AccountUnbanned(address indexed)
  Topic: 0xc98af8f4ec4ddc4c9cd83aa9d9adbf34053062dc51ad93a562c787c2cc5dbc47
  Address: indexed (topics[1])
  hasAmount: false

AddedBlacklist(address)
  Topic: 0x86c048150dfc5def3c35f7bc81582956dd964e56d8c028c9f4f5e978bb203c31
  Address: NOT indexed (first 32 bytes of data)
  hasAmount: false

RemovedBlacklist(address)
  Topic: 0x90792cb7177eb70be35a14e39400d4143370da97f528237fd2b069e408ca68fb
  Address: NOT indexed (first 32 bytes of data)
  hasAmount: false

AddedToDenyList(address[])
  Topic: 0x02dd2f2ab1d45714c6f178e8ff8c5594023ec5d134bb99bbb230adabdb718c05
  Address list: ABI-encoded dynamic address[] in data
  hasAmount: false

RemovedFromDenyList(address[])
  Topic: 0xfe849628f690f8527fe506998b4ddf44a5b11ecb3ec64257db0951b62d9a4f38
  Address list: ABI-encoded dynamic address[] in data
  hasAmount: false

Banned(address indexed)
  Topic: 0x30d1df1214d91553408ca5384ce29e10e5866af8423c628be22860e41fb81005
  Address: indexed (topics[1])
  hasAmount: false

UnBanned(address indexed)
  Topic: 0xb39966eac8a0ae96284afcbb1a1e8eb366677548a09cf1bf773b39b26bedd234
  Address: indexed (topics[1])
  hasAmount: false

Seize(address indexed,address indexed,uint256,string)
  Topic: 0x5068c48f7f290ce2b8d555bd28014be9f312999bb621037ea3e9fc86335a21d7
  Address: indexed `from` (topics[1])
  Amount: first 32 bytes of data
  hasAmount: true

OmnibusSeize(address,address,uint256,string,uint8)
  Topic: 0x5c719d01bb88860dfca685ad3818d8b61a083caaf8f68abe6fa0fba4e40e33a9
  Address: first 32-byte data slot
  Amount: second 32-byte data slot
  hasAmount: true
```

### Tier-1 Expansion Events (v3.95)

```
Blacklisted(address indexed,bool)
  Topic: 0xcf3473b85df1594d47b6958f29a32bea0abff9dd68296f7bf33443646793cfd8
  Address: indexed (topics[1])
  Direction: bool at first 32-byte data slot (non-zero → blacklist, zero → unblacklist)
  hasAmount: false
  Note: TrueUSD uses a single topic for both directions; the bool is resolved via
        BlacklistEventDef.eventTypeFromDataBoolIndex=0. DestroyedBlackFunds on
        TUSD reuses the USDT legacy topic 0x61e6e66b0d6339b2980aecc6ccc0039736791f0ccde9ed512e789a7fbdd698c6.

AddedToDenylist(address indexed)
  Topic: 0x8d6233ac6005c4f3eaa99b3aebdbe7ad15476dd961858142c4080952392f979d
  Address: indexed (topics[1])
  hasAmount: false

RemovedFromDenylist(address indexed)
  Topic: 0x29e32a16a9d465ee92796d9fc7e93d2a9ab78cdc803298df7ed84b52d19cd42f
  Address: indexed (topics[1])
  hasAmount: false

AddressesFrozen(address[])
  Topic: 0x07381cac78ed3e2aa4d96e0d2c80e39d1c2fff09d8f6f079fa7249b553f45425
  Address list: ABI-encoded dynamic address[] in data
  hasAmount: false

AddressesUnFrozen(address[])
  Topic: 0xb474664863a35c00b84f99fe9155ea67676b17495d6f9d6b0277787801f77a45
  Address list: ABI-encoded dynamic address[] in data
  hasAmount: false

Blocklisted(address indexed)
  Topic: 0x917c251bb231c4b997a420bebe47edad5c20e70715da16c38e9b2e172e44ab92
  Address: indexed (topics[1])
  hasAmount: false
  Note: CENTRE fork (JPYC). Distinct from USDC's Blacklisted/UnBlacklisted
        (note the 'ock' vs 'ack' spelling).

UnBlocklisted(address indexed)
  Topic: 0xbc3fe0fc667d12a7a22748747f024a7d971127ffc48f6622675d3e97a2591a51
  Address: indexed (topics[1])
  hasAmount: false

AccountFrozen(address)
  Topic: 0x4f2a367e694e71282f29ab5eaa04c4c0be45ac5bf2ca74fb67068b98bdc2887d
  Address: NOT indexed (first 32-byte data slot)
  hasAmount: false
  Note: FRXUSD reuses the AccountFrozen signature (same keccak as Agora AUSD's
        indexed variant — indexed-ness does not affect the topic) but with a
        NON-indexed address in data[0], resolved via addressDataIndex=0.

AccountThawed(address)
  Topic: 0x74bb8c2778db9c683c274e7bfdcb56dba4f1c737411c8182363097eec281eea4
  Address: NOT indexed (first 32-byte data slot)
  hasAmount: false

TransferRestrictionImposed(address indexed)
  Topic: 0x31180c9d9d89196003f30f7b6643004f76e5feb146dbf10ae71764a88cfed5ef
  Address: indexed (topics[1])
  hasAmount: false

TransferRestrictionRemoved(address indexed)
  Topic: 0x1c425db0931b7efc6b31b2491db198b75f20cfd6885f51c35f5f2a5495ef4619
  Address: indexed (topics[1])
  hasAmount: false
```

---

## Database Schema

### blacklist_events table

**Migrations:** baseline schema in `worker/migrations/0000_baseline.sql`, plus `0076_blacklist_provenance_and_amount_semantics.sql`, `0077_blacklist_amount_recovery_telemetry.sql`, and `0095_blacklist_event_suppression.sql` (adds the `suppression_reason` column + index). Historical pre-squash index/version additions are tracked in [`worker/migrations/MANIFEST.md`](../worker/migrations/MANIFEST.md).

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
  suppression_reason TEXT,
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
CREATE INDEX idx_blacklist_events_suppression_reason ON blacklist_events(suppression_reason);
```

**Row ID format:** `{chainId}-{txHash}-{logIndex}` -- ensures uniqueness via `INSERT OR IGNORE`.

**event_type values:** `"blacklist"`, `"unblacklist"`, `"destroy"`

**Amount semantics**

- `amount_native` is the canonical token-native quantity for the event
- `amount_usd_at_event` is populated only when Pharos can justify an event-time USD valuation
- `amount_source` records where the value came from (`event`, `historical_balance`, `current_balance_snapshot`, `derived`, `legacy_migration`, `unavailable`)
- `amount_status` records whether the amount is resolved, recoverable, or intentionally unavailable
- `amount_attempt_count` records how many historical-recovery attempts Pharos has made for the row
- `amount_last_attempted_at`, `amount_last_error_class`, and `amount_last_provider` are operator diagnostics for unresolved rows
- `suppression_reason` records auditable rows excluded from public aggregate/event surfaces; currently `circle_mirror_zero_balance` for EURC rows that mirror Circle actions without frozen EURC value

`amount_source='current_balance_snapshot'` is written when Tron rows are reconciled from the freeze-ledger mirror in `blacklist_current_balances`. `sync-blacklist` reapplies that mirror after refreshing current balances, so newly ingested Tron blacklist rows resolve in the same cron cycle rather than waiting for the next 6-hour pass. `amount_source='derived'` and `amount_source='legacy_migration'` are treated as legacy migration artifacts, not active ingestion modes. Older Tron blacklist/unblacklist rows that still carried current-state-derived values are reset so event rows no longer claim unsupported historical precision. Legacy derived-zero EVM rows receive at most three historical recovery attempts before the row is marked `permanently_unavailable`.

### blacklist_current_balances table

**Migration:** `0081_blacklist_current_balances.sql`

This table is a separate freeze-ledger snapshot store used by the public frozen-total summary. It does **not** replace `blacklist_events`, and it must not be described as a live balance guarantee. Public totals are last-known successful snapshots.

Rows are seeded from externally reconciled freeze ledgers where Pharos has verified a higher-confidence historical surface. As of `v3.5`, that bootstrap source is `kyc.rip` / [`stables.rip`](https://stables.rip/) for:

- Ethereum `USDC`
- Ethereum `USDT`
- Tron `USDT`

```sql
CREATE TABLE blacklist_current_balances (
  id TEXT PRIMARY KEY,
  stablecoin TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  address TEXT NOT NULL,
  amount_native REAL,
  amount_usd REAL,
  source TEXT NOT NULL DEFAULT 'current_balance',
  status TEXT NOT NULL DEFAULT 'resolved',
  observed_at INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempted_at INTEGER,
  last_error_class TEXT
);
```

Use it for:

- tracked freeze-ledger totals (`trackedFrozenTotal`)
- tracked freeze-ledger record counts (`trackedAddressCount`)
- tracked snapshot gap tracking (`trackedAmountGapCount`)

Do **not** treat it as raw event history. New snapshot rows are keyed to contract/config-scoped blacklist/freeze identities so same-symbol/same-chain deployments cannot overwrite each other. Legacy rows can still fall back to the older symbol/chain/address identity until remediated. Rows are preserved across later unblacklist events so seized or later-burned balances do not disappear from the public freeze totals. If a blacklist and matching unblacklist arrive in the same cron batch, the blacklist row is still selected for a snapshot before the release marker is skipped as non-deleting. Destroy events can overwrite the stored amount with the seized burn amount when that event emits a better value than the original snapshot.

Legacy `activeAddressCount`, `activeFrozenTotal`, and `activeAmountGapCount` remain in `/api/blacklist-summary` for wire compatibility. They describe Pharos' local net-active event-state view and should not be used as the public frozen-total source. New consumers should prefer the tracked freeze-ledger fields above for historical freeze exposure and use the active fields only when they specifically need the current local net-frozen state machine.

Provider refresh failures preserve the last successful amount and update status/provenance metadata instead of reducing the public frozen total to zero or null. Treat `status='provider_failed'`, stale `observed_at`, and `last_error_class` as data-quality signals around the last-known value, not as proof that funds were unfrozen.

### blacklist_sync_state table

**Migrations:** baseline schema in `worker/migrations/0000_baseline.sql`; typed attempt state in `worker/migrations/0174_blacklist_sync_fairness.sql`

```sql
CREATE TABLE blacklist_sync_state (
  config_key TEXT PRIMARY KEY,
  last_block INTEGER NOT NULL DEFAULT 0,
  cursor_kind TEXT NOT NULL DEFAULT 'evm_block',
  cursor_value INTEGER,
  attempt_generation INTEGER NOT NULL DEFAULT 0,
  last_attempted_at INTEGER,
  last_succeeded_at INTEGER,
  last_skipped_at INTEGER,
  last_failed_at INTEGER,
  consecutive_skips INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_outcome TEXT,
  last_observed_safe_head INTEGER,
  last_safe_head_observed_at INTEGER
);
```

**Config key format:**

| Chain type | Format                        | Example                                   |
| ---------- | ----------------------------- | ----------------------------------------- |
| EVM        | `{chainId}-{contractAddress}` | `ethereum-0xa0b86991...`                  |
| Tron       | `tron-{contractAddress}`      | `tron-TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` |

For EVM configs, the stored contract-address segment is canonicalized to lowercase on write. Reads merge both lowercase and legacy mixed-case keys so older cursor rows keep working after contract metadata switches to checksum casing.

`cursor_kind` discriminates EVM block cursors from Tron millisecond timestamps. `cursor_value` is authoritative for the new runner, while `last_block` is dual-read and dual-written for rollback compatibility with the previous Worker. A claim increments `attempt_generation`; finalization updates the cursor, safe-head observation, success/failure/skip timestamps, and streaks only when both the generation and starting cursor still match. This prevents a late writer from overwriting newer progress.

For EVM configs, partial provider coverage advances only to the minimum contiguous block proven across every required topic. Missing-topic coverage pins the cursor. For Tron, all configured event families must finish before the safe timestamp frontier advances.

---

## Sync Flow

### Execution Order (each cron cycle)

1. **Fair incremental event scan** (per contract config)
   - Partition typed EVM-block and Tron-timestamp states, sort each cohort by oldest `last_attempted_at`, and merge equal timestamps by alternating cohorts. Raw cursor magnitudes are never compared.
   - Claim the loaded `(config_key, cursor, attempt_generation)` before provider work; a concurrent claim conflict is visible and degrades the run.
   - EVM: resolve a real chain head, subtract the 15-minute safety margin, and fetch logs from `cursor + 1` only to that safe head via Etherscan `getLogs` or chain RPC `eth_getLogs`.
   - Selected RPC-log configs seed empty cursors from known contract deployment blocks instead of scanning from genesis
   - RPC-log chains scan in bounded windows per run; Arbitrum is also bounded to 25,000,000 explorer/Alchemy-primary blocks or 250,000 fallback-RPC blocks.
   - RPC providers receive all required topic0 signatures as one OR-topic filter when supported. Explorer scans remain per-topic. Every configured topic reports complete, quiet, partial, provider-error, missing-topic, or incomplete coverage, and the shared cursor advances only to the minimum contiguous frontier.
   - Recursive Alchemy range splitting is sequential and bounded by depth, the run deadline, the shared subrequest budget, and a 64-call per-scan ceiling.
   - Tron: fetch confirmed events from `lastTimestamp` through `now - 15 minutes` via TronGrid `/contracts/{addr}/events`, using the documented `min_timestamp`, `max_timestamp`, and fingerprint parameters.
   - TronGrid pagination links must remain on the exact HTTPS TronGrid contract/event endpoint; malformed, cross-origin, cyclic, or overlong links fail the config without forwarding the API key.
   - Parse events into `BlacklistRow` objects
   - If the runtime guard is nearly exhausted, persist the unstarted tail as `budget_skipped`. Any skipped required config degrades the run; oldest-attempt ordering admits that tail first on the next due run.

2. **New-event balance enrichment** (in-memory, before DB insertion)
   - Enrich parsed rows with balances BEFORE inserting into D1
   - All EVM chains: dRPC archive node first when configured, then `getChainRpc()` (Alchemy/public RPC), then Etherscan best-effort -- all at historical block (`blockNumber - 1`)
   - Tron: destroy events keep their native event amount; blacklist/unblacklist events are not assigned historical balances from current-state account reads
   - RPC-log chains reuse persistent block-timestamp cache rows to avoid re-resolving the same blocks every run
   - `INSERT OR IGNORE` enriched rows into `blacklist_events`

3. **Freeze-ledger snapshot refresh**
   - Newly blacklisted addresses fetch a latest token balance snapshot and persist it into `blacklist_current_balances`
   - New snapshot writes are contract/config-scoped; legacy rows can use symbol/chain/address fallback identity during remediation
   - Provider refresh failures retain the previous resolved amount while surfacing failure status/provenance
   - Later unblacklist events do **not** delete the ledger row; if a blacklist and release are ingested in the same cron cycle, the blacklist event still receives a snapshot before the release marker is skipped
   - Destroy events preserve the row and can replace the stored amount with the emitted seized/burned amount when available
   - This ledger feeds the public tracked frozen-total summary without claiming unsupported event-time precision for blacklist rows

4. **Generation-fenced state finalization**
   - Persist event rows before advancing the cursor.
   - Dual-write `cursor_value` and legacy `last_block` monotonically under the claimed generation.
   - Record the latest safe head and reset or increment per-config success/failure/skip streaks.

5. **Historical maintenance** (runs after event admission)
   - Enqueue recoverable/provider/ambiguous amount rows and eligible legacy derived-zero rows, then backfill up to 100 due rows by durable priority/retry availability.
   - Close resolved or terminal repair rows; provider failures retain bounded exponential retry timing instead of spending every run indefinitely.
   - Migrate up to 100 unambiguous legacy event identities and 50 contract-scoped current-balance identities. Ambiguous same-symbol/same-chain rows are never guessed.
   - Reapply the Tron current-balance ledger mirror so newly ingested rows resolve in the same cycle.
   - Maintenance yields to the event scan and stops under the shared runtime/subrequest budget.

6. **Producer snapshots**
   - Publish only when every required config has a successful complete/quiet scan, no state conflict occurred, and snapshot tail budget remains.
   - Stamp freshness with the oldest required config's `last_succeeded_at`, not the cron completion time.

7. **Bounded provider telemetry**
   - Persist per-config provider mode, coverage outcome, from/to/safe frontiers, fetched/inserted counts, provider call count, maximum split depth, and at most four bounded failure samples.
   - Retain 14 days, pruning on the blacklist lane.

### Safety Margins

```
INDEXING_SAFETY_SEC = 900 (15 minutes)
TRON_INDEXING_SAFETY_MS = 900,000 ms
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
| Gnosis    | 180                    | 5s         |

---

## Balance Enrichment

### EVM Strategy

1. **All EVM chains with dRPC key:** dRPC archive node `eth_call` at historical block (`blockNumber - 1`) -- preferred source for all chains including Ethereum mainnet
2. **RPC fallback:** if dRPC misses, `getChainRpc()` retries the same historical `eth_call` against the configured chain RPCs (Alchemy primary when available, then public fallback)
3. **Best-effort explorer fallback:** Etherscan `eth_call` with historical block tag -- last resort for all chains; some non-mainnet explorer paths may silently ignore the block tag or reject it entirely

### Tron Strategy

- Convert stored hex address to base58 for TronGrid account lookups
- API: `GET /v1/accounts/{tronAddress}`
- Extract TRC20 balance: `data[0].trc20[contractAddress]`
- Missing account rows or missing TRC20 token-balance entries are treated as null/provider-missing, not false zero
- Confirmed zero is used only when the token balance is present and explicitly reports zero
- These balances seed the persistent freeze ledger only, not event-time blacklist row attribution

### Destroy Amount Recovery

For destroy events, try fetching from transaction receipt first (`eth_getTransactionReceipt` then parse matching event log). Fall back to `balanceOf` if receipt parsing fails.

---

## API Endpoint

### GET /api/blacklist

**File:** `worker/src/api/blacklist.ts`
**Cache:** producer-backed profile (`s-maxage=300`, `max-age=60`, `stale-while-revalidate=300`). Freshness headers follow the 6-hourly `sync-blacklist` writer timestamp.

**Query parameters:**

| Param           | Type   | Default | Description                                                                                                                                                                                                                                                                                                                                                                      |
| --------------- | ------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `limit`         | number | 1000    | Max results (1-1000; `0` maps to default `1000`)                                                                                                                                                                                                                                                                                                                                 |
| `offset`        | number | 0       | Pagination offset                                                                                                                                                                                                                                                                                                                                                                |
| `stablecoin`    | string | --      | Filter by name (`"USDC"`, `"USDT"`, `"PAXG"`, `"XAUT"`, `"PYUSD"`, `"USD1"`, `"USDG"`, `"RLUSD"`, `"U"`, `"USDTB"`, `"A7A5"`, `"FDUSD"`, `"BRZ"`, `"AUSD"`, `"EURI"`, `"USDQ"`, `"USDO"`, `"USDX"`, `"AID"`, `"TGBP"`, `"MNEE"`, `"EURC"`, `"BUIDL"`, `"USDP"`, `"TUSD"`, `"NUSD"`, `"EURCV"`, `"USDA"`, `"USAT"`, `"AEUR"`, `"XUSD"`, `"XAUM"`, `"JPYC"`, `"FRXUSD"`, `"FIDD"`) |
| `chain`         | string | --      | Filter by `chain_name`                                                                                                                                                                                                                                                                                                                                                           |
| `chainId`       | string | --      | Filter by canonical chain id; must match `chain` if both are provided                                                                                                                                                                                                                                                                                                            |
| `eventType`     | string | --      | Filter by `event_type` (`"blacklist"`, `"unblacklist"`, `"destroy"`)                                                                                                                                                                                                                                                                                                             |
| `q`             | string | --      | Case-insensitive address substring search                                                                                                                                                                                                                                                                                                                                        |
| `sortBy`        | string | date    | Sort field (`"date"`, `"stablecoin"`, `"chain"`, `"event"`)                                                                                                                                                                                                                                                                                                                      |
| `sortDirection` | string | desc    | Sort direction (`"asc"`, `"desc"`)                                                                                                                                                                                                                                                                                                                                               |

The handler now exposes only unsuppressed rows for the live-supported symbols: USDC, USDT, PAXG, XAUT, PYUSD, USD1, USDG, RLUSD, U, USDTB, A7A5, FDUSD, BRZ, AUSD, MNEE, EURI, USDQ, USDO, USDX, AID, TGBP, EURC, BUIDL, USDP, TUSD, NUSD, EURCV, USDA, USAT, AEUR, XUSD, XAUM, JPYC, FRXUSD, and FIDD.

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
    "version": "3.9",
    "versionLabel": "v3.9",
    "currentVersion": "3.9972",
    "currentVersionLabel": "v3.9972",
    "changelogPath": "/methodology/blacklist-tracker-changelog/",
    "asOf": 1704067200,
    "isCurrent": false
  }
}
```

### GET /api/blacklist-summary

**File:** `worker/src/api/blacklist-summary.ts`
**Cache:** producer-backed profile (`s-maxage=300`, `max-age=60`, `stale-while-revalidate=300`). Freshness headers follow the 6-hourly `sync-blacklist` writer timestamp.

Returns server-side aggregate stats, quarterly chart buckets, supported chain filters, coverage metadata, and total event count for the blacklist UI.

The summary now mixes two intentionally distinct lenses:

- event-history stats such as `destroyedTotal`
- recent activity stats such as `recentCount` (30d) and `recentCount24h`
- local event-state stats such as `activeFrozenTotal`, sourced from Pharos' active blacklist state machine
- tracked freeze-ledger stats such as `trackedFrozenTotal`, sourced from last-known successful `blacklist_current_balances` snapshots
- data-quality metadata when available, including snapshot age, source/status distributions, provider failures, and manifest-derived deferred coverage; retained snapshot age, permanent unavailable rows, and deferred coverage are diagnostics unless recoverable gaps or provider failures cross warning criteria
- latest guarded reconciliation evidence under `reconciliation`, including immutable manifest identity/hash, exact event and destroyed-amount parity, targeted balance replay parity, unresolved gaps, recorded-bookmark presence, and Tron/Arbitrum safe-head proof
- quarterly chart buckets sourced from the tracked freeze ledger and attributed to each row's latest recorded blacklist quarter

Coverage entries are contract/config-level records. Every supported row is expected to carry the required tracked fields `symbol`, `stablecoinId`, `chainId`, `chainName`, `contractAddress`, `configKey`, `providerSource`, `eventFamilies`, and `eventTypes`; deferred rows carry `symbol`, `chainId`, and `reason`.

---

## Admin Endpoints

### POST /api/reset-blacklist-sync

Requires Access service-token headers on `ops-api.pharos.watch`. Rolls back sync state:

- EVM: subtract 50,000 blocks (~7 days on Ethereum)
- Tron: subtract 604,800,000 ms (7 days)
- Rewinds both `cursor_value` and compatibility `last_block`, increments `attempt_generation`, and clears success freshness so late writers cannot restore the old cursor
- Returns: `{ ok: true, evmReset: N, tronReset: M }`

This global rewind is an emergency tool, not the recovery path for a known missing-event manifest. Reviewed recovery must target exact configs/events and verify identity, balance replay, and safe-head parity without moving unrelated cursors.

### GET /api/debug-sync-state

Requires Access service-token headers on `ops-api.pharos.watch`. Returns the complete config registry joined to typed cursor, generation, attempt/success/skip/failure, safe-head, event-count, and latest-run error telemetry.

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
- `onlyMissingProvenance` (default `false`; set `true` to restrict remediation to legacy rows missing contract/config provenance)
- `maxAttempts`

### POST /api/backfill-blacklist-current-balances

Requires Access service-token headers on `ops-api.pharos.watch`. Runs the current-balance-cache writer against historical blacklist rows so older tracked freeze events can populate `blacklist_current_balances` through the same `syncCurrentBalanceCacheForRows` path used by the scheduled sync.

Supported inputs:

- `stablecoin` (symbol, optional)
- `chainId` (optional)
- `limit` (default `500`, max `2000`; selects the newest latest-per-address rows per config)
- `dryRun` (`true` to inspect candidates without writing)

Frozen stablecoins are excluded. Use narrow `stablecoin` + `chainId` filters and `dryRun=true` before a write-enabled backfill.

All blacklist admin endpoints are aggregated and dispatched by `worker/src/routes/registry.ts` and executed via `worker/src/handlers/http/request-dispatch.ts`, but their route definitions live in `worker/src/routes/ops-routes.ts` (`reset-blacklist-sync`, `debug-sync-state`) and `worker/src/routes/admin-routes.ts` (`remediate-blacklist-amount-gaps`, `backfill-blacklist-current-balances`).

---

## Frontend

### Hook

**File:** `src/hooks/use-blacklist-events.ts`
**Endpoints:** `GET /api/blacklist-summary` + `GET /api/blacklist`
**Cache:** `staleTime: 360 min` (6h, = `sync-blacklist` producer interval), `refetchInterval: 720 min` (12h)

The summary hook loads aggregate cards/chart/filter metadata from the dedicated summary endpoint. The page hook fetches only the currently requested table slice, including server-side filtering, sorting, search, and pagination.
Both endpoints now emit freshness headers from the same 6-hourly `sync-blacklist` writer timestamp, so the shared stale-data banner does not warn before the next scheduled blacklist run is actually late.

### Page: /freezewatch

**File:** `src/app/freezewatch/page.tsx`

| Component        | File                                   | Description                                                                                                  |
| ---------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| BlacklistFilters | `src/components/blacklist-filters.tsx` | Stablecoin, chain, event type dropdowns                                                                      |
| Search           | (inline)                               | Server-backed address search                                                                                 |
| BlacklistTable   | `src/components/blacklist-table.tsx`   | Server-sorted, 50 rows per page                                                                              |
| BlacklistStats   | `src/components/blacklist-stats.tsx`   | Unfreezable market share, last-known freeze-ledger totals, and wiped value                                   |
| BlacklistChart   | `src/components/blacklist-chart.tsx`   | Quarterly stacked bar chart of tracked freeze-ledger balances by stablecoin, attributed to blacklist quarter |
| CSV export       | (inline)                               | Download the currently loaded table page as CSV, after server-side filters/sort/search/pagination            |

On mobile, the event ledger renders event cards instead of the dense table. The same server-side sort, filter, search,
pagination, and CSV export state is preserved; cards prioritize asset, chain, action, event time, amount provenance,
address, and transaction link. From `md` upward, the full table remains the primary ledger.

### Amount Display Logic

- `null` or (`0` and not destroy): show the amount status/source instead of implying a confirmed value
- Gold coins (PAXG, XAUT, XAUM): 4 decimal places + symbol (converted to USD only when the coin-specific price-cache entry is positive and newer than the 6-hour replay budget)
- A7A5, EURC, BRZ, EURI, TGBP, EURCV, AEUR, and JPYC: native amounts are non-USD-denominated and converted to USD only when their coin-specific price-cache entries are positive and newer than the 6-hour replay budget
- USD-pegged stablecoins: `formatCurrency` (USD)

### Special UI Components

| Component         | Description                                                           |
| ----------------- | --------------------------------------------------------------------- |
| UsdsStatusCard    | Monitors USDS for freeze capability (currently none)                  |
| EurcBlacklistCard | Explains EURC/USDC simultaneous freezes and zero-balance EURC entries |

### Detail-page block

Stablecoin detail pages (`/stablecoin/<id>`) render two blacklist blocks, both gated on the same conditions:

1. The coin's symbol is in `BLACKLIST_STABLECOINS` (`shared/types/market.ts`).
2. `summary.stats.perCoinTotalEvents[symbol] > 0` (real, non-suppressed events exist).

`BlacklistSection` (`id="blacklist"`, Activity tab, rendered after the flow-summary card) consists of:

- **BlacklistDetailStats** — three `MetricStatCard`s showing `perCoinFrozenAddressCount`, `perCoinFrozenTotal` (USD), and `perCoinDestroyedTotal` (USD).
- **BlacklistDetailChart** — quarterly stacked bars with three event-type series (blacklist / unblacklist / destroy), driven by `perCoinQuarterlyEventTypes[symbol]`.

`BlacklistHistorySection` (`id="blacklist-history"`, History tab, rendered immediately after the Mint & Burn Flow History) consists of:

- **BlacklistDetailEventFeed** — latest 10 events for the coin via `useBlacklistEventsPage({ stablecoin: symbol, limit: 10, offset: 0 })`, with a "See all events →" footer link to `/freezewatch/?stablecoin=<symbol>`.

Source files: `src/components/stablecoin-detail/blacklist-section.tsx`, `blacklist-detail-stats.tsx`, `blacklist-detail-chart.tsx`, `blacklist-detail-event-feed.tsx`.

Gating is driven by the view model (`src/lib/stablecoin-detail-view-model.ts` → `hasBlacklist`) so the scrollspy nav omits the "Blacklist" pill when the block is absent. Coins with events but no freeze-ledger snapshot rows render `0` / `$0` for the two freeze metrics — honest about what is measured today.

---

## Environment Variables

| Variable            | Type   | Required | Description                                                                                                                                      |
| ------------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ETHERSCAN_API_KEY` | Secret | Yes      | Etherscan v2 API key for supported-chain log scans + L1 calls                                                                                    |
| `TRONGRID_API_KEY`  | Secret | No       | TronGrid Pro API key (improves rate limits)                                                                                                      |
| `DRPC_API_KEY`      | Secret | No       | dRPC key for archive node balance lookups (all EVM chains including mainnet)                                                                     |
| `ALCHEMY_API_KEY`   | Secret | No       | Preferred chain RPC source for Base/Optimism/Avalanche/BSC log scans; strongly recommended for faster historical catch-up on zero-cursor configs |

---

## Known Gotchas

1. **Tron address format:** events return `0x`-prefix hex; TronGrid API requires `41`-prefix hex.
2. **Tron missing balances:** missing account rows or absent TRC20 token entries are null/provider-missing, not false zero; only an explicit token balance of `0` is treated as confirmed zero.
3. **Tron sync state uses millisecond timestamps**, NOT block numbers.
4. **USDT has TWO event patterns:** legacy (`AddedBlackList`, address NOT indexed) and USDT0 (`BlockPlaced`, address indexed). Some chains (Arbitrum, Polygon) emit both.
5. **PAXG FrozenAddressWiped** has no amount in the event -- must fetch via `balanceOf` at `blockNumber - 1`.
6. **XAUT uses USDT0 event pattern** (was mistakenly using legacy pattern until 2026-02-11 fix).
7. **Explorer historical calls** are not dependable enough to be primary on any chain -- rely on dRPC first, then chain-RPC/Alchemy fallback; explorer fallback is best-effort only.
8. **Base, Optimism, Avalanche, BSC, and Gnosis log scans** use chain RPC `eth_getLogs` paths instead of depending on explorer log coverage.
9. **EVM sentinel bug (fixed):** storing `99999999` as `last_block` could cause permanent scan stall.
10. **Budget limit (900 subrequests)** is shared across ALL configs + backfill per cron cycle.
11. **Partial RPC scans now preserve progress:** incomplete Base/Optimism/Avalanche/BSC log scans still advance to the highest safely covered block, so large first-sync backlogs drain over multiple cron runs instead of re-scanning genesis every time.
12. **Circle actions can hit USDC + EURC together** -- expect matching addresses across both tickers, and many EURC rows may show zero balance at blacklist time.
13. **Legacy mixed-case cursor rows:** older runs may have stored checksum-cased EVM addresses in `blacklist_sync_state`; current reads merge those with lowercase canonical keys to avoid duplicate cursors and redundant rescans.
14. **RPC bootstrap guards:** Base USDC, Optimism USDC, Optimism legacy USDT, Optimism USDT0, Avalanche USDC, Avalanche USDT, and BSC USDT start from known deployment blocks, and RPC-log scans use bounded per-run block windows. This prevents empty zero-cursor configs from repeatedly attempting impractical genesis-to-head scans.
15. **Recoverable-gap telemetry is row-level:** use `amount_attempt_count`, `amount_last_error_class`, and `amount_last_provider` to diagnose stranded historical rows instead of inferring from null amounts alone.
16. **USDtb emits batch events:** `AccountsBlocked(address[])` and `AccountsUnblocked(address[])` expand one log into one row per affected address, with the array index appended to the row ID.
17. **A7A5 is non-USD:** never treat native A7A5 units as USD; amount conversion depends on a fresh `a7a5-old-vector` price-cache entry.
18. **RLUSD clawback is not covered:** v3.8 tracks account pause/unpause only. Clawback support needs transaction-input classification because the verified ABI does not expose a dedicated clawback event.
19. **MNEE has independent blacklist and freeze states:** v3.9 tracks MNEE freeze/unfreeze plus confiscation/burn events only. AccountBlacklisted/AccountDelisted need a future restriction-source key to avoid active-state collisions.
20. **EURC/BRZ/EURI/TGBP/EURCV/AEUR/JPYC are non-USD:** public USD values depend on fresh price-cache conversion rather than native token units (EUR for EURC/EURI/EURCV/AEUR, BRL for BRZ, GBP for TGBP, JPY for JPYC).
21. **Gnosis dRPC free-tier caps log range at 10k blocks:** scan windows must stay at or below 9k blocks per request, otherwise `eth_getLogs` rejects the range and no events are returned.

---

## File Index

| File                                                                   | Role                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `worker/src/cron/sync-blacklist.ts`                                    | Main cron: incremental scan, backfill, balance enrichment, sync state                                                                                                                                                          |
| `worker/src/lib/blacklist-contracts.ts`                                | Blacklist event configs: chains, event signatures, and shared-contract resolution rules                                                                                                                                        |
| `worker/src/lib/evm-logs.ts`                                           | Etherscan v2 log fetching, recursive splitting, rate limiting, `decodeUint256`                                                                                                                                                 |
| `worker/src/api/blacklist.ts`                                          | `GET /api/blacklist` handler                                                                                                                                                                                                   |
| `worker/src/routes/registry.ts`                                        | API route aggregator/dispatcher; admin route definitions live in `ops-routes.ts` (`reset-blacklist-sync`, `debug-sync-state`) and `admin-routes.ts` (`remediate-blacklist-amount-gaps`, `backfill-blacklist-current-balances`) |
| `worker/src/handlers/scheduled.ts`                                     | Thin cron-expression dispatcher for scheduled slots                                                                                                                                                                            |
| `worker/src/handlers/scheduled/hourly-blacklist.ts`                    | Dedicated 6-hourly `sync-blacklist` slot runner                                                                                                                                                                                |
| `worker/src/lib/db.ts`                                                 | `getLastBlock()`, `setLastBlock()`, `batchExecute()`                                                                                                                                                                           |
| `worker/migrations/0000_baseline.sql`                                  | Baseline blacklist schema, including `blacklist_events`, `blacklist_sync_state`, and the pre-0072 index/version additions                                                                                                      |
| `worker/migrations/0076_blacklist_provenance_and_amount_semantics.sql` | Adds amount provenance and semantics columns                                                                                                                                                                                   |
| `worker/migrations/0077_blacklist_amount_recovery_telemetry.sql`       | Adds recovery-attempt telemetry for unresolved amount rows                                                                                                                                                                     |
| `src/hooks/use-blacklist-events.ts`                                    | TanStack Query hook                                                                                                                                                                                                            |
| `src/app/freezewatch/page.tsx`                                         | FreezeWatch page with filters, stats, chart, table                                                                                                                                                                             |
| `src/components/blacklist-filters.tsx`                                 | Filter UI (stablecoin, chain, event type)                                                                                                                                                                                      |
| `src/components/blacklist-table.tsx`                                   | Sortable paginated table                                                                                                                                                                                                       |
| `src/components/blacklist-stats.tsx`                                   | Summary statistics cards                                                                                                                                                                                                       |
| `src/components/blacklist-chart.tsx`                                   | Quarterly tracked freeze-ledger chart                                                                                                                                                                                          |
