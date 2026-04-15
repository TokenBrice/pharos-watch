# CeFi Blacklist/Freeze/Destroy Expansion Research

Date: 2026-04-15

## Assumptions

- "Our CeFi stablecoins" means active Pharos metadata entries with `flags.governance = "centralized"`.
- "blacklistable: yes" means the same app semantics used by report cards: explicit `canBeBlacklisted: true`, or omitted `canBeBlacklisted` on a centralized coin. This is implemented in `shared/lib/report-card-blacklist-matchers.ts`.
- Market cap ranking uses DefiLlama stablecoin circulating supply first, because Pharos treats DefiLlama as primary supply. CoinGecko market cap is used only for tracked centralized assets without a DefiLlama stablecoin ID, including tokenized commodity/NAV assets.
- The scope is implementation prep for the existing blacklist module, not a product decision to mix allowlist/KYC events into "blacklist" metrics.
- Current tracker architecture is the source of truth: `worker/src/lib/blacklist-contracts.ts`, `worker/src/cron/sync-blacklist.ts`, `worker/src/cron/blacklist/*`, `shared/types/market.ts`, `shared/lib/blacklist-aggregates.ts`, `shared/lib/blacklist-active-records.ts`, and `docs/blacklist-tracker.md`.

## Success Criteria

- Exhaust every active centralized/blacklistable Pharos asset over USD 500M market cap.
- For each asset, state whether current Pharos can track blacklist/freeze/destroy with the existing model.
- For each feasible implementation, identify event signatures, address extraction, amount extraction, chain/config work, ledger semantics, backfill shape, D1 effects, and RPC/API load.
- For infeasible or non-direct assets, describe what new model would be required instead of forcing misleading rows into `blacklist_events`.

## Source Passes

1. Read local docs and implementation:
   - `docs/architecture.md`
   - `docs/api-reference.md`
   - `docs/testing.md`
   - `docs/worker-and-api-limits.md`
   - `docs/blacklist-tracker.md`
   - `docs/blacklist-tracker-timeline.md`
   - `worker/src/lib/blacklist-contracts.ts`
   - `worker/src/cron/sync-blacklist.ts`
   - `worker/src/cron/blacklist/*`
2. Built the candidate universe from `shared/data/stablecoins/*.json`.
3. Pulled current market-cap/supply:
   - DefiLlama stablecoins API: `https://stablecoins.llama.fi/stablecoins?includePrices=true`
   - CoinGecko simple price API with `include_market_cap=true`
4. Verified event surfaces from contract ABIs/source:
   - Sourcify metadata where available.
   - Public RPC EIP-1967 implementation slots for proxies.
   - Official Superstate docs and GitHub source for USTB.
5. Queried production D1 where possible. Two parallel Wrangler reads failed because the non-interactive token refresh path rejected concurrent token fetches; sequential reads succeeded.

## Current Module Baseline

Current live cron coverage from `docs/blacklist-tracker.md`:

- USDC on Ethereum, Arbitrum, Base, Optimism, Polygon, Avalanche.
- USDT on Ethereum, Arbitrum, Optimism legacy, Optimism USDT0, Polygon, Avalanche, BSC, Tron.
- PAXG on Ethereum.
- XAUT on Ethereum.
- PYUSD on Ethereum and Arbitrum.
- USD1 on Ethereum, BSC, Tron.

Current public enum:

```ts
export const BLACKLIST_STABLECOINS = ["USDC", "USDT", "PAXG", "XAUT", "PYUSD", "USD1"] as const;
```

Current production D1 snapshot from `wrangler d1 execute stablecoin-db --remote`:

- `blacklist_events`: 16,359 rows.
- `blacklist_current_balances`: 10,479 rows.
- Event rows by major source:
  - USDT Tron: 6,696 blacklist, 413 unblacklist, 1,003 destroy.
  - USDT Ethereum: 2,896 blacklist, 282 unblacklist, 1,213 destroy.
  - USDC Ethereum: 614 blacklist, 165 unblacklist.
  - USDC L2/native chains: hundreds of blacklist/unblacklist rows per configured chain.
  - PAXG Ethereum: 285 blacklist, 10 destroy.
  - PYUSD Ethereum: 105 blacklist, 1 destroy.
  - XAUT Ethereum: 4 blacklist, 1 destroy.
  - USD1 BSC: 1 blacklist.
  - Legacy EURC rows still exist in D1 but EURC is intentionally not in the live public enum.

Current steady-state no-event load is approximately one cursor read and one cursor write per config per hour, plus one log query per event topic per config. Current config count is 21 in code, with 26 sync-state rows in production because of legacy/mixed-case keys.

## Exhausted Candidate Set

Sorted by chosen market-cap source at research time.

| Rank | Asset | Pharos ID | Chosen cap | Source | Existing live blacklist support | Implementation class |
| ---: | --- | --- | ---: | --- | --- | --- |
| 1 | USDT | `usdt-tether` | $185.60B | DefiLlama | Yes | Already live; chain expansion only |
| 2 | USDC | `usdc-circle` | $78.58B | DefiLlama | Yes | Already live; chain expansion only |
| 3 | USD1 | `usd1-world-liberty-financial` | $4.09B | DefiLlama | Yes | Already live; chain expansion only |
| 4 | PYUSD | `pyusd-paypal` | $4.06B | DefiLlama | Yes | Already live; chain expansion only |
| 5 | BUIDL | `buidl-blackrock` | $3.03B | DefiLlama | No | Seize-only; no direct freeze event found |
| 6 | USYC | `usyc-hashnote` | $2.81B | DefiLlama | No | No on-chain blacklist/freeze event found |
| 7 | XAUT | `xaut-tether` | $2.67B | CoinGecko | Yes | Already live |
| 8 | PAXG | `paxg-paxos` | $2.36B | CoinGecko | Yes | Already live |
| 9 | USDY | `usdy-ondo-finance` | $2.16B | DefiLlama | No | External blocklist/sanctions list contracts |
| 10 | USDG | `usdg-paxos` | $2.09B | DefiLlama | No | Straight Paxos freeze support |
| 11 | RLUSD | `rlusd-ripple` | $1.45B | DefiLlama | No | Account pause support; clawback requires extra model |
| 12 | U | `u-united-stables` | $973.12M | DefiLlama | No | Straight `Freeze`/`Unfreeze` support |
| 13 | USDTB | `usdtb-ethena` | $939.92M | DefiLlama | No | Batch block/unblock parser needed |
| 14 | USTB | `ustb-superstate` | $820.98M | CoinGecko | No | Allowlist/KYC plus admin burn, not direct blacklist |
| 15 | OUSG | `ousg-ondo-finance` | $599.90M | CoinGecko | No | KYC registry only; not a blacklist ledger |
| 16 | YLDS | `ylds-figure` | $575.40M | DefiLlama | No | Non-EVM/non-Tron indexing needed |
| 17 | A7A5 | `a7a5-old-vector` | $552.20M | DefiLlama | No | Straight Tether-like blacklist support with one renamed event |

No other active centralized/blacklistable Pharos asset exceeded the USD 500M cutoff in the DefiLlama-primary plus CoinGecko-fallback pass.

## Cross-Cutting Implementation Work

Every new symbol requires:

- Add to `BLACKLIST_STABLECOINS` in `shared/types/market.ts`.
- Add a brand/chart color in `shared/lib/classification.ts` for `BLACKLIST_CHART_COLORS`.
- Confirm frontend filter behavior in `src/components/blacklist-filters.tsx` still fits with the larger enum; 17 symbols will be too many for the current toggle row on mobile.
- Add event family definitions in `worker/src/lib/blacklist-contracts.ts`.
- Add `ContractEventConfigSpec` entries for chain/contract pairs.
- Extend parsing if the address is not a single indexed or ABI-static address:
  - `AccountsBlocked(address[])`
  - `BlockedAddressesAdded(address[])`
  - `SanctionedAddressesAdded(address[])`
  - Superstate allowlist entity events
- Update `shared/lib/blacklist.ts` if USD valuation is not 1:1. For all USD stablecoins and NAV tokens in this pass, USD amount can usually use native amount only if the token is USD-denominated and non-rebasing. For tokenized funds/NAV assets, amount USD should use live price or NAV, not raw token count.
- Update methodology docs and timeline if anything ships:
  - `docs/blacklist-tracker.md`
  - `docs/blacklist-tracker-timeline.md`
  - `/methodology` blacklist section
  - `shared/lib/blacklist-tracker-version.ts`

## Load Model

### Existing scanner mechanics

Per hourly cron run:

- `getLastBlock`: 1 D1 read per config.
- Backfill pass: 1 D1 read capped at 50 amount-gap rows, then up to 50 D1 updates.
- No-event EVM config: roughly `eventTopicCount` log queries plus chain-head resolution, then 1 cursor write if advanced.
- No-event Tron config: 1 TronGrid event request per event name, then 1 cursor write if advanced.
- New event row:
  - 1 duplicate-check D1 read chunk per <=200 fetched rows.
  - 1 `blacklist_events` insert.
  - Usually 1 historical or current `balanceOf` call if event has no amount.
  - 1 `blacklist_current_balances` upsert for blacklist/destroy rows.
  - No ledger delete on unblacklist; ledger rows are preserved.

### Conservative v1: only assets that map cleanly to current event-ledger semantics

Recommended first implementation wave:

- USDG Ethereum.
- RLUSD Ethereum pause/unpause.
- U Ethereum and BSC.
- USDTB Ethereum batch block/unblock.
- A7A5 Ethereum.

Approximate added configs: 7.

Approximate added steady-state hourly upstream calls:

- USDG: 3 event topics.
- RLUSD: 2 event topics.
- U: 2 topics x 2 chains = 4.
- USDTB: 2 event topics.
- A7A5: 3 event topics.
- Chain-head calls: <=3 extra per hour because Ethereum/BSC heads are already cached when existing configs run.

Net: about +14 log calls/hour plus +7 D1 cursor reads/hour and +7 D1 cursor writes/hour. This is small relative to the 900 blacklist subrequest budget and current 7-minute runtime budget.

Event-time writes:

- Single-address blacklist/freeze: 1 event insert + 1 current-balance upsert.
- Single-address unfreeze/unblock: 1 event insert only.
- Single-address destroy/seize with amount: 1 event insert + 1 ledger upsert.
- USDTB batch block/unblock: expands one log into N rows. A 100-address batch means about 100 inserts and, for block events, up to 100 current-balance calls and upserts. This is the only v1 item that can burst.

### API read impact

The public summary handler currently reads all blacklist events and all current-balance rows on every `GET /api/blacklist-summary` response:

- Current event table read surface: 16,359 rows.
- Current freeze-ledger read surface: 10,479 rows.
- Current total summary read surface: about 26,838 rows before in-memory aggregation.

The first-wave assets should add little steady-state read pressure unless USDTB emits very large batch block events. If first-wave additions add 1,000 event rows and 500 ledger rows, summary reads grow by about 5.6%. If USDY/USTB-style list systems are added and emit large institutional onboarding/offboarding batches, read growth could be much larger because each address-level list update becomes a row. At roughly 100,000+ combined event/ledger rows, `/api/blacklist-summary` should probably move to a cached aggregate or incremental rollup instead of scanning raw rows for every request.

`GET /api/blacklist` remains paginated, but total-count and filtered reads still scale with indexed row count. New symbols require indexes already present on `stablecoin`, `chain_name`, `event_type`, and `timestamp`; no new index is needed for first-wave token-event support.

### Full compliance-surface v2

Adds USDY blocklist/sanctions list contracts, BUIDL seize-only events, USTB allowlist/admin-burn semantics, and possibly OUSG KYC semantics.

Approximate additional steady-state topics:

- USDY Ethereum and Arbitrum: at least 2 blocklist events per list contract, plus sanctions add/remove events, plus token-level list-address setter events. Expect 6-8 topics per chain if we track both blocklist and sanctions surfaces properly.
- BUIDL EVM: `Seize` and `OmnibusSeize` on each verified EVM deployment. Current local metadata has Ethereum, BSC, Optimism, Arbitrum, Avalanche, Polygon plus Solana/Aptos. Expect 2 topics per EVM deployment that is source-verified enough to decode.
- USTB Ethereum: `AdminBurn`, `OffchainRedeem`, `Bridge`, and allowlist events if we model eligibility revocations. Allowlist modeling needs additional state tables, not only `blacklist_events`.
- OUSG Ethereum: KYC registry changes, not direct blacklist/freeze.

Net: +35 to +60 log calls/hour if all EVM compliance surfaces are tracked, plus new D1 tables for list state. This is still within the 900 subrequest budget, but batch list events and state reconciliation can become the real D1/write driver.

## Detailed Asset Review

### 1. USDT (`usdt-tether`)

Status: already live-supported.

Current Pharos coverage:

- Ethereum: legacy Tether events.
- Arbitrum: legacy plus USDT0 events.
- Optimism legacy: legacy Tether events.
- Optimism USDT0 traded contract: USDT0 events.
- Polygon: legacy plus USDT0 events.
- Avalanche: legacy events.
- BSC: legacy events.
- Tron: legacy events via TronGrid.

Current event families:

- Legacy:
  - `AddedBlackList(address)`, topic `0x42e160154868087d6bfdc0ca23d96a1c1cfa32f1b72ba9ba27b69b98a0d819dc`.
  - `RemovedBlackList(address)`, topic `0xd7e9ec6e6ecd65492dce6bf513cd6867560d49544421d0783ddf06e76c24470c`.
  - `DestroyedBlackFunds(address,uint256)`, topic `0x61e6e66b0d6339b2980aecc6ccc0039736791f0ccde9ed512e789a7fbdd698c6`.
  - Legacy address is ABI-static in `data`; destroy amount is the second ABI word.
- USDT0:
  - `BlockPlaced(address)`, topic `0x406bbf2d8d145125adf1198d2cf8a67c66cc4bb0ab01c37dccd4f7c0aae1e7c7`.
  - `BlockReleased(address)`, topic `0x665918c9e02eb2fd85acca3969cb054fc84c138e60ec4af22ab6ef2fd4c93c27`.
  - `DestroyedBlockedFunds(address,uint256)`, topic `0x6a2859ae7902313752498feb80a014e6e7275fe964c79aa965db815db1c7f1e9`.
  - Address is indexed in `topics[1]`; amount is first ABI word in `data`.

Implementation notes:

- No new coin work is needed.
- Additional chain coverage should not blindly use every `contracts[]` entry. USDT has local contracts on Solana, TON, NEAR, Aptos, Sui, Celo, Ink, Mantle, Berachain, Monad, Plasma, and many others. Many are non-EVM or lack current scanner RPC support.
- For EVM USDT0-style deployments on new EVM chains, the current event family is reusable if ABI verification confirms `BlockPlaced`, `BlockReleased`, and `DestroyedBlockedFunds`.
- For Solana/Sui/Aptos/TON/NEAR, this is a separate indexer project. The current module only understands EVM logs and TronGrid events.

Impact if adding one more EVM USDT0 chain:

- +1 config.
- +3 log-topic calls/hour.
- +1 D1 cursor read/hour and +1 cursor write/hour.
- New events: 1 insert/event; block events also current-balance fetch/upsert; destroy emits amount and upserts ledger.

Recommended next action:

- Leave USDT as live baseline unless a specific chain is prioritized by supply and has verified USDT0/legacy event ABI plus an available log source.

### 2. USDC (`usdc-circle`)

Status: already live-supported.

Current Pharos coverage:

- Ethereum, Arbitrum, Base, Optimism, Polygon, Avalanche.

Current event family:

- `Blacklisted(address)`, topic `0xffa4e6181777692565cf28528fc88fd1516ea86b56da075235fa575af6a4b855`.
- `UnBlacklisted(address)`, topic `0x117e3210bb9aa7d9baff172026820255c6f6c30ba8999d1c2fd88e2848137c4e`.
- Address is indexed in `topics[1]`.
- No destroy event is configured in current Pharos.

Implementation notes:

- No new coin work is needed.
- Circle native USDC deployments can usually reuse the current event family, but local metadata includes many non-EVM and bridged/non-native variants. Do not add them by symbol alone.
- EURC was intentionally removed from live filters because Circle often mirrors USDC blacklist actions into EURC with zero-balance rows. Any USDC chain expansion should preserve that lesson: amount/ledger rows must distinguish mirrored no-balance noise from real frozen value.

Impact if adding one more native EVM USDC chain:

- +1 config.
- +2 log-topic calls/hour.
- +1 D1 cursor read/hour and +1 cursor write/hour.
- +1 current-balance call and ledger upsert for each blacklist event.

Recommended next action:

- Treat USDC as already covered for the major native EVM chains. Chain expansion should be supply-ranked and source-verified per deployment.

### 3. USD1 (`usd1-world-liberty-financial`)

Status: already live-supported.

Current Pharos coverage:

- Ethereum.
- BSC.
- Tron.

Current event family:

- `Freeze(address,address)`, topic `0x51d18786e9cb144f87d46e7b796309ea84c7c687d91e09c97f051eacf59bc528`.
- `Unfreeze(address,address)`, topic `0x4f3ab9ff0cc4f039268532098e01239544b0420171876e36889d01c62c784c79`.
- Affected address is `topics[2]` on EVM because `topics[1]` is the caller.
- Tron parser uses `tronResultKey: "account"`.
- No destroy event has been identified/configured.

Implementation notes:

- No new coin work is needed for the already configured chains.
- Local metadata also has USD1 contracts on Solana, Plume, Monad, Mantle, Aptos, and AB Core. Those are not current-module ready unless the chain is EVM with a reliable log source and verified ABI matching `Freeze/Unfreeze`.

Impact if adding one more matching EVM chain:

- +1 config.
- +2 log-topic calls/hour.
- New freeze: event insert plus current balance upsert.
- New unfreeze: event insert only.

Recommended next action:

- Leave as live baseline. Any chain expansion should start with Plume/Mantle/Monad only after confirming scanner support and ABI parity.

### 4. PYUSD (`pyusd-paypal`)

Status: already live-supported.

Current Pharos coverage:

- Ethereum.
- Arbitrum.

Current event family:

- `FreezeAddress(address)`, topic `0x1aa660498c83ea285bc55e4cfc00afcaa7120798db87b74f3c0d7c6e001bc392`.
- `UnfreezeAddress(address)`, topic `0x150465b020dfc06a59269da94ed66db9b65a516cf4fdd5f583b0f12752339bbe`.
- `FrozenAddressWiped(address)`, topic `0xfc5960f1c5a5d2b60f031bf534af053b1bf7d9881989afaeb8b1d164db23aede`.
- Address is indexed in `topics[1]`.
- Wipe event has no amount; Pharos samples `balanceOf(address)` at `blockNumber - 1`.

Implementation notes:

- No new coin work is needed for current EVM coverage.
- Local metadata also includes Solana, Stellar, and Flow. Those require non-EVM indexing.

Impact if adding another PaxosTokenV2-style EVM PYUSD deployment:

- +1 config.
- +3 log-topic calls/hour.
- Wipe/destroy rows need historical balance sampling if amount is not emitted.

Recommended next action:

- Leave as live baseline.

### 5. BUIDL (`buidl-blackrock`)

Status: not live-supported.

Local contracts:

- Ethereum `0x7712c34205737192402172409a8f7ccef8aa2aec`.
- BSC `0x2d5bdc96d9c8aabbdb38c9a27398513e7e5ef84f`.
- Optimism `0xa1cdab15bba75a80df4089cafba013e376957cf5`.
- Arbitrum `0xa6525ae43edcd03dc08e775774dcabd3bb925872`.
- Avalanche `0x53fc82f14f009009b440a706e31c9021e1196a2f`.
- Polygon `0x2893ef551b6dd69f661ac00f11d93e5dc5dc0e99`.
- Solana and Aptos also exist in metadata but are out of current module scope.

ABI findings:

- Optimism and Arbitrum implementations resolve to Securitize `DSToken` via Sourcify partial matches.
- Relevant events:
  - `Seize(address,address,uint256,string)`, topic `0x5068c48f7f290ce2b8d555bd28014be9f312999bb621037ea3e9fc86335a21d7`.
  - `OmnibusSeize(address,address,uint256,string,uint8)`, topic `0x5c719d01bb88860dfca685ad3818d8b61a083caaf8f68abe6fa0fba4e40e33a9`.
  - `Pause()` and `Unpause()` are contract-global, not per-address.
- No direct `Blacklisted`, `Freeze`, `Blocked`, or account-level pause event was found in the token ABI.
- There are lock/partition manager references (`LOCK_MANAGER`, `PARTITIONS_MANAGER`), but address-level locking is not emitted directly by the token ABI surfaced here.

Implementation shape:

- Do not map BUIDL to normal `blacklist`/`unblacklist` without finding lock-manager list events.
- A narrow "destroy/seize tracker" is feasible:
  - Add an event family for `Seize` and `OmnibusSeize`.
  - Map both to `event_type = "destroy"` or introduce a new event type such as `seize`.
  - Current public schema only accepts `"blacklist" | "unblacklist" | "destroy"`, so using `destroy` is technically possible but semantically lossy.
  - For `Seize`, affected address is indexed `from` in `topics[1]`; recipient is `topics[2]`; amount is first ABI word in `data`.
  - For `OmnibusSeize`, affected `from` is not indexed and is the first ABI word in `data`; amount is the second ABI word in `data`.
  - Amount is emitted, so no historical `balanceOf` is needed.

Ledger semantics:

- A seize should upsert `blacklist_current_balances` with `source = "destroy_event"` if we continue to use the freeze ledger as a preserved seized-value store.
- It should not count as currently frozen in `activeFrozenTotal`, matching current v3.7 destroyed exclusion.
- Because no preceding blacklist event may exist, `buildBlacklistActiveRecords()` currently ignores destroy events without an active blacklist row. The tracked ledger path can still hold seized value, but active-record logic would need a small adjustment if BUIDL seize events should be visible as active records.

Load estimate:

- If tracking only verified EVM deployments on Ethereum, Optimism, Arbitrum, Avalanche, Polygon, BSC:
  - Up to +6 configs.
  - +12 log-topic calls/hour.
  - +6 cursor reads/hour and +6 cursor writes/hour.
  - Event writes are 1 event row + 1 ledger upsert per seize.
- If only Ethereum is included initially:
  - +1 config.
  - +2 log-topic calls/hour.

Recommendation:

- Do not include BUIDL in a first "freeze/blacklist" expansion unless we either:
  - find the lock-manager events and can map them to address-level frozen balances, or
  - explicitly add a "seize-only" coverage class to methodology/API copy.

Sources:

- Sourcify Optimism `DSToken` implementation: `https://repo.sourcify.dev/contracts/partial_match/10/0xca91fa164b75da598e16b4d89fb2086b47140df3/metadata.json`
- Sourcify Arbitrum `DSToken` implementation: `https://repo.sourcify.dev/contracts/partial_match/42161/0xdbf6db49066784a69244d3b33cf44c25ec86c0f7/metadata.json`

### 6. USYC (`usyc-hashnote`)

Status: not live-supported.

Local contracts:

- Ethereum `0x136471a34f6ef19fe571effc1ca711fdb8e49f2b`.
- BSC `0x8D0fA28f221eB5735BC71d3a0Da67EE5bC821311`.

ABI findings:

- Ethereum proxy resolves to `YieldCoin`.
- Events include `Deposit`, `Withdrawal`, `TradeToFiat`, `MinterConfigured`, fee/oracle/teller events, and ERC-20 `Transfer`.
- Functions include mint/burn/minter allowance and owner/upgrade controls.
- No account-level blacklist/freeze/unfreeze/block/seize event was found.
- No compliance list pointer was found in the ABI.

Implementation shape:

- There is no safe current-module implementation for blacklist/freeze/destroy tracking.
- Mint/burn flow is already a better fit for visible on-chain USYC token movements.
- Any claimed blacklist support would need an external issuer/compliance system source, not EVM token logs.

Load estimate:

- No tracker config recommended.
- If a future external compliance source exists, D1 load depends on that API and should probably write a separate compliance table rather than `blacklist_events`.

Recommendation:

- Mark as "not implementable from verified token events" for now.

Source:

- Sourcify Ethereum `YieldCoin` implementation: `https://repo.sourcify.dev/contracts/full_match/1/0xbf0f2f3aad6b99893d80c550fbacec915545eb92/metadata.json`

### 7. XAUT (`xaut-tether`)

Status: already live-supported.

Current Pharos coverage:

- Ethereum `0x68749665ff8d2d112fa859aa293f07a622782f38`.

Current event family:

- Uses USDT0 pattern:
  - `BlockPlaced(address)`.
  - `BlockReleased(address)`.
  - `DestroyedBlockedFunds(address,uint256)`.
- Address indexed in `topics[1]`.
- Destroy amount emitted in `data`.

Implementation notes:

- No new work for current Ethereum support.
- Gold valuation is already handled specially:
  - `isGoldBlacklistStablecoin()`.
  - `fetchGoldPriceFromCache()`.
  - Current-balance override for gold contracts whose `balanceOf()` returns zero while frozen.

Impact:

- Already in baseline.

### 8. PAXG (`paxg-paxos`)

Status: already live-supported.

Current Pharos coverage:

- Ethereum `0x45804880de22913dafe09f4980848ece6ecbaf78`.

Current event family:

- `AddressFrozen(address)`, topic `0x90811a8edd3b3c17eeaefffc17f639cc69145d41a359c9843994dc2538203690`.
- `AddressUnfrozen(address)`, topic `0xc3776b472ebf54114339eec9e4dc924e7ce307a97f5c1ee72b6d474e6e5e8b7c`.
- `FrozenAddressWiped(address)`, topic `0xfc5960f1c5a5d2b60f031bf534af053b1bf7d9881989afaeb8b1d164db23aede`.
- Address indexed in `topics[1]`.
- Wipe amount is not emitted; Pharos samples `balanceOf(address)` at `blockNumber - 1`.

Implementation notes:

- No new work.

Impact:

- Already in baseline.

### 9. USDY (`usdy-ondo-finance`)

Status: not live-supported.

Local contracts:

- Ethereum `0x96f6ef951840721adbf46ac996b59e0235cb985c`.
- Arbitrum `0x35e050d3c0ec2d29d269a8ecea763a183bdf9a9d`.
- Mantle, Plume, Sei, Sui, Solana, Aptos, Stellar, Noble, Osmosis, Mantra also exist in metadata.

Token ABI findings:

- Ethereum and Arbitrum token implementations expose:
  - `BlocklistSet(address,address)`.
  - `SanctionsListSet(address,address)`.
  - `AllowlistSet(address,address)` on Ethereum.
  - `blocklist()`.
  - `sanctionsList()`.
- The token itself does not emit per-address block/unblock events.

Ethereum list contracts resolved by RPC:

- `blocklist()` = `0xd8c8174691d936E2C80114EC449037b13421B0a8`.
  - `BlockedAddressesAdded(address[])`, topic `0x3a615a701ac9b684212c0070be113e8c7847390b2cb8a03c9998684e2a86ae29`.
  - `BlockedAddressesRemoved(address[])`, topic `0x825ac0fb57c227a7d56aba274d9e0e69c9c6b837841a26298e3e0148c201ba28`.
  - Address list is a dynamic ABI `address[]` in `data`.
- `sanctionsList()` = `0x40C57923924B5c5c5455c48D93317139ADDaC8fb`.
  - `SanctionedAddress(address)`, topic `0x8027911123971054d93579ebea046c8461473fa4d2e510b9b49eed3bed3270e0`.
  - `NonSanctionedAddress(address)`, topic `0xd595018321fcb8c2bcbf5bfe4b27d74bea505825f7d195abe8517f94a065539c`.
  - `SanctionedAddressesAdded(address[])`, topic `0x2596d7dd6966c5673f9c06ddb0564c4f0e6d8d206ea075b83ad9ddd71a4fb927`.
  - `SanctionedAddressesRemoved(address[])`, topic `0x32aab684eee99db715515d1a9987a8fe33bb6341b0e35e60db7eab48a08f9a3a`.

Implementation shape:

- Add a new config type, not just `ContractEventConfig`, because the event source contract is not the token contract.
- Required fields:
  - `stablecoinId`.
  - `stablecoin` symbol.
  - `tokenContractAddress`.
  - `eventSourceAddress`.
  - `eventSourceRole`: `blocklist` or `sanctionsList`.
  - `listPointerSource`: token contract and getter (`blocklist()`/`sanctionsList()`).
- Parser must decode dynamic `address[]` events and emit one normalized row per address.
- For `BlockedAddressesAdded` and `SanctionedAddressesAdded`, map to `event_type = "blacklist"`.
- For `BlockedAddressesRemoved` and `SanctionedAddressesRemoved`, map to `event_type = "unblacklist"`.
- For single-address sanctions events, parse the static address from `data` unless the ABI marks it indexed in a chain-specific implementation.
- Current balance must be fetched from the USDY token contract, not the list contract.
- `contract_address` should probably store the token contract, while a new provenance column may be needed for `event_source_address`. Overloading `contract_address` with the list contract would break balance/config resolution.

Ledger semantics:

- A sanctions-list event and a blocklist event can refer to the same address. Current active-record key is `(stablecoin, chain, address)`, so two independent list sources would collide.
- Options:
  - Treat both as the same "blacklisted" state and accept one active status per address.
  - Add `restriction_source` to the row/current-balance key so blocklist and sanctions list are separately visible.
- The second option is more correct but requires schema work.

Load estimate:

- Ethereum only, blocklist plus sanctions list:
  - +2 event-source configs if implemented that way.
  - +6 log-topic calls/hour: 2 for blocklist, 4 for sanctions list.
  - +2 cursor reads/hour and +2 cursor writes/hour.
  - Batch events can expand to many D1 rows and current-balance calls.
- Ethereum plus Arbitrum:
  - Roughly double, plus Arbitrum list-address resolution.
- Add token pointer tracking:
  - +2 token-level setter topics per token contract if we want to detect list contract rotations without manual config updates.

Recommendation:

- USDY is valuable but should be v2, after adding dynamic-array event parsing and event-source-contract provenance.

Sources:

- Sourcify Ethereum USDY implementation: `https://repo.sourcify.dev/contracts/full_match/1/0xea0f7eebdc2ae40edfe33bf03d332f8a7f617528/metadata.json`
- Sourcify Ethereum blocklist: `https://repo.sourcify.dev/contracts/full_match/1/0xd8c8174691d936E2C80114EC449037b13421B0a8/metadata.json`
- Sourcify Ethereum sanctions list: `https://repo.sourcify.dev/contracts/partial_match/1/0x40C57923924B5c5c5455c48D93317139ADDaC8fb/metadata.json`

### 10. USDG (`usdg-paxos`)

Status: not live-supported.

Local contracts:

- Ethereum `0xe343167631d89b6ffc58b88d6b7fb0228795491d`.
- Solana `2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH`.
- Ink `0xe343167631d89b6ffc58b88d6b7fb0228795491d`.
- X Layer `0x4ae46a509f6b1d9056937ba4500cb143933d2dc8`.

ABI findings:

- Ethereum proxy resolves to `USDG`.
- Relevant events:
  - `FreezeAddress(address)`, topic `0x1aa660498c83ea285bc55e4cfc00afcaa7120798db87b74f3c0d7c6e001bc392`.
  - `UnfreezeAddress(address)`, topic `0x150465b020dfc06a59269da94ed66db9b65a516cf4fdd5f583b0f12752339bbe`.
  - `FrozenAddressWiped(address)`, topic `0xfc5960f1c5a5d2b60f031bf534af053b1bf7d9881989afaeb8b1d164db23aede`.
- Address is indexed in `topics[1]`.
- Wipe amount is not emitted.
- USDG also has rewards-freeze events, but those are reward-accounting events, not token freeze events:
  - `RewardsFrozen(address,uint32,uint256)`.
  - `FrozenRewardsLost(address,uint32,uint256)`.

Implementation shape:

- Reuse `PYUSD_EVENT_FAMILY`.
- Add `USDG` to `BLACKLIST_STABLECOINS` and colors.
- Add Ethereum config:
  - `chain: ETHEREUM`
  - `stablecoinId: "usdg-paxos"`
  - `events: PYUSD_EVENT_FAMILY.events`
  - start block can reuse existing mint/burn exact start `20_915_336`.
- Ink and X Layer should wait:
  - Current `buildChainRpcs()` does not include Ink/X Layer public RPCs.
  - Etherscan v2 support must be verified before relying on explorer logs.
  - Sourcify did not resolve these implementations in the quick pass.
- Solana is out of current module scope.

Ledger semantics:

- Freeze: event insert plus `balanceOf` current snapshot.
- Unfreeze: event insert only; preserve ledger.
- Wipe: event insert, attempt event receipt first, then `balanceOf(block - 1)`. USDG uses the same no-amount wipe pattern as PYUSD/PAXG.
- USD valuation is 1:1; no gold logic needed.

Load estimate:

- Ethereum-only:
  - +1 config.
  - +3 log-topic calls/hour.
  - +1 D1 cursor read/hour and +1 cursor write/hour.
  - Each freeze/wipe adds 1 event insert plus 1 ledger upsert.

Recommendation:

- Best first new asset. It fits the current model exactly.

Source:

- Sourcify Ethereum USDG implementation: `https://repo.sourcify.dev/contracts/full_match/1/0xfacd5ff359adf87822374275699dd518aaf9a65f/metadata.json`

### 11. RLUSD (`rlusd-ripple`)

Status: not live-supported.

Local contracts:

- Ethereum `0x8292bb45bf1ee4d140127049757c2e0ff06317ed`.
- XRPL issuer entry.

ABI findings:

- Ethereum proxy resolves to `StablecoinUpgradeableV2`.
- Relevant events:
  - `AccountPaused(address)`, topic `0xae7f60c1b8f645c3beffeb531169cbc446874bbf247698325318879ac850c346`.
  - `AccountUnpaused(address)`, topic `0x0c18efbde61ac471ead6960a3f1097735c68ecdb685ae8e2a108c28385399a65`.
  - Global `Paused(address)` and `Unpaused(address)` are contract-level pause events, not account freezes.
- Functions:
  - `pauseAccounts(address[])`.
  - `unpauseAccount(address)`.
  - `accountPaused(address)`.
  - `clawback(address,uint256)`.
- No explicit `Clawback` event appears in the ABI. A clawback likely emits ERC-20 `Transfer(account, zero, amount)` only, which is not enough to classify without transaction-input/trace context.

Implementation shape:

- Add new event family:
  - `AccountPaused(address)` -> `blacklist`.
  - `AccountUnpaused(address)` -> `unblacklist`.
- Parser change:
  - The address appears non-indexed in the ABI output from Sourcify, so parse it from the first ABI word in `data`, not from `topics[1]`.
  - Current parser supports unindexed address only for the first ABI word, so this part is already compatible if `addressTopicIndex` is omitted and `topics.length <= 1`.
- Add Ethereum config only.
- Add XRPL only if/when a separate XRPL event/indexing path exists.

Destroy/clawback:

- Do not track RLUSD clawback in v1 unless we add a transaction-input-aware path:
  - Watch `Transfer(address,address,uint256)` to zero from the token.
  - Fetch transaction input and match selector for `clawback(address,uint256)`.
  - Exclude ordinary `burn(uint256)` and user redemptions.
- Current `fetchDestroyAmountFromLog()` is receipt-oriented after a known destroy event; it does not discover clawbacks from Transfer logs.

Ledger semantics:

- Account pause: insert event, fetch current balance at latest, upsert ledger.
- Account unpause: insert event only, preserve ledger.
- No destroyed/seized amount until clawback model exists.

Load estimate:

- Ethereum-only:
  - +1 config.
  - +2 log-topic calls/hour.
  - +1 D1 cursor read/write per hour.
  - New pause events add one current-balance call and ledger upsert.

Recommendation:

- Good first-wave asset for freeze status. Document that clawback/destroy is not covered until transaction-input classification is added.

Source:

- Sourcify Ethereum RLUSD implementation: `https://repo.sourcify.dev/contracts/partial_match/1/0x9747a0d261c2d56eb93f542068e5d1e23170fa9e/metadata.json`

### 12. U (`u-united-stables`)

Status: not live-supported.

Local contracts:

- BSC `0xce24439f2d9c6a2289f741120fe202248b666666`.
- Ethereum `0xce24439f2d9c6a2289f741120fe202248b666666`.

ABI findings:

- Both Ethereum and BSC resolve to `StablecoinV2`.
- Relevant events:
  - `Freeze(address,address)`, topic `0x51d18786e9cb144f87d46e7b796309ea84c7c687d91e09c97f051eacf59bc528`.
  - `Unfreeze(address,address)`, topic `0x4f3ab9ff0cc4f039268532098e01239544b0420171876e36889d01c62c784c79`.
- Affected address is `account`, indexed as the second indexed parameter (`topics[2]`).
- Functions expose `frozen(address)`, `freeze(address)`, and `unfreeze(address)`.
- No destroy/wipe/seize event found in the ABI. Burn events exist but are normal supply events.

Implementation shape:

- Reuse the existing `USD1_EVENT_FAMILY`.
- Add configs for Ethereum and BSC.
- For BSC, current module already has BSC RPC log scan support and BSC is already used by USDT and USD1.
- For Ethereum, Etherscan v2 path is already used by other configs.
- Start block must be verified. Current mint/burn config uses default `21_900_000`; confirm actual deployment block before full historical backfill.

Ledger semantics:

- Freeze: event insert plus current balance upsert.
- Unfreeze: event insert only.
- No destroy tracking in v1.

Load estimate:

- +2 configs.
- +4 log-topic calls/hour.
- +2 cursor reads/hour and +2 cursor writes/hour.
- Event write pattern matches USD1.

Recommendation:

- Good first-wave asset. Very low parser risk.

Source:

- Sourcify Ethereum/BSC implementation: `https://repo.sourcify.dev/contracts/full_match/1/0xbef21313c69c009fd7d9510a8d3a481a32473dfc/metadata.json`

### 13. USDTB (`usdtb-ethena`)

Status: not live-supported.

Local contracts:

- Ethereum `0xc139190f447e929f090edeb554d95abb8b18ac1c`.
- Arbitrum `0xc708b6887db46005da033501f8aebee72d191a5d`.
- Base `0xc708b6887db46005da033501f8aebee72d191a5d`.

ABI findings:

- Ethereum proxy resolves to `AnchorageTokenUSDtb`.
- Relevant events:
  - `AccountsBlocked(address[])`, topic `0x5444f9841c04ce78987f28701fa07fc4c112840c1c8439e8f52bda50c3788a87`.
  - `AccountsUnblocked(address[])`, topic `0x4a637dd1cd99ae43d353009d0ffbc16b05cc69808b819ebf852c68ea47b34dd4`.
- Functions:
  - `blockAccounts(address[])`.
  - `unblockAccounts(address[])`.
  - `isBlocked(address)`.
- No destroy/seize/clawback event found in the ABI.
- Arbitrum/Base deployments did not resolve via Sourcify in the quick pass. They may be bridge/OFT or a different implementation.

Implementation shape:

- Add dynamic array event support. Current parser can decode a static address but not `address[]`.
- Parser should expand one event log into one `BlacklistRow` per account:
  - Row ID cannot be just `{chainId}-{txHash}-{logIndex}` or every account in the same batch collides.
  - Use `{chainId}-{txHash}-{logIndex}-{addressIndex}` or include the address hash.
  - `event_signature` stays `AccountsBlocked(address[])`.
  - `event_topic0` is the batch topic.
- For block events, fetch current token balance per address from the USDTB token contract.
- For unblock events, insert event rows only.
- Ethereum should be first. Arbitrum/Base require ABI verification before adding.

Ledger semantics:

- Batch block: each address becomes an independent frozen address row.
- Batch unblock: each address becomes an independent unblacklist row.
- No destroy in v1.

Load estimate:

- Ethereum-only:
  - +1 config.
  - +2 log-topic calls/hour.
  - +1 cursor read/write per hour.
  - D1 and RPC cost are event-size dependent: one 500-address block batch can create 500 event rows and 500 current-balance reads/upserts.
- Arbitrum/Base if verified:
  - +2 configs and +4 log-topic calls/hour.

Recommendation:

- Good first-wave asset after implementing dynamic `address[]` decoding and multi-row ID generation.

Source:

- Sourcify Ethereum USDTB implementation: `https://repo.sourcify.dev/contracts/partial_match/1/0x9d6d77a21702b9afcf924983fbfb84aaaae79589/metadata.json`

### 14. USTB (`ustb-superstate`)

Status: not live-supported.

Local contracts:

- Ethereum `0x43415eb6ff9db7e26a15b704e7a3edce97d31c4e`.
- Plume `0xe4fa682f94610ccd170680cc3b045d77d9e528a8`.

Official docs/source findings:

- Superstate docs list Ethereum USTB token proxy and AllowlistV3 proxy.
- Docs state functions gated by Superstate Admin include minting, adding/removing users from the allowlist, and forcibly burning investor tokens.
- EVM transfers check that sender and receiver are on the Allowlist and authorized for the token.
- The AllowlistV3 source exposes:
  - `FundPermissionSet(uint256,string,bool)`, topic `0x8b21380fe0a0556737077f6863df81c4256a80da50cdc28d470d7f3cb57a5370`.
  - `ProtocolAddressPermissionSet(address,string,bool)`, topic `0x6428dcbeec3e74b2cee92f5015063661d5a2a6e6c16c5e5e0ca49b4dc5327c78`.
  - `EntityIdSet(address,uint256)`, topic `0x74fa176a3afad3e3acd18ea48291e85b8876c68409a05936e5f40e2df752986f`.
- Token source exposes:
  - `AdminBurn(address,address,uint256)`, topic `0xa0222c54f2ca627a77e5ce2b2b1346919bc0357e1501f9817c567e5151397c81`.
  - `OffchainRedeem(address,address,uint256)`, topic `0x5380355699fac5266e4d95cf6985cf6a48abe03aa33d07723bdd0338a367af25`.
  - `Bridge(address,address,uint256,address,string,uint256)`, topic `0xb636c803e5654f044e1b724dda035449558155d348b39be4ffb37988592461bf`.

Implementation shape:

- Do not treat all allowlist removals as ordinary blacklist events without a new methodology section.
- To model transfer eligibility:
  - Need a new state table mapping addresses to `entityId`.
  - Need a new state table mapping `entityId + fundSymbol` to permission.
  - Need to process `EntityIdSet` and `FundPermissionSet` in order.
  - For protocol addresses, process `ProtocolAddressPermissionSet` directly.
  - Need to derive an address as "blocked for USTB" only when its entity or protocol permission changes from allowed to not allowed.
- To model forced burn:
  - `AdminBurn` is trackable as a destroy/seize event.
  - `OffchainRedeem` and `Bridge` are user/operational redemptions, not blacklist destroys.
- Amount USD cannot simply equal native token count if USTB trades as a NAV/yield token. Use current price/NAV from price cache when valuing burns/frozen balances.

Ledger semantics:

- Eligibility revocation is not the same as freezing a balance. An address may be unable to transfer but not "blacklisted" in the same sense as USDT/USDC.
- If we expose this, public copy should call it "permission revoked" or "allowlist removed" rather than "blacklisted".
- `AdminBurn` can map to `destroy` or a future `seize` event type.

Load estimate:

- Ethereum-only minimal forced-burn support:
  - +1 token config.
  - +1 log-topic call/hour for `AdminBurn`.
  - +1 cursor read/write per hour.
  - +1 insert + 1 ledger upsert per admin burn.
- Full allowlist support:
  - +1 allowlist config with 3 topics.
  - D1 writes for every entity/address/permission event.
  - Current-balance refresh requires deriving affected addresses from entity permission changes, which can fan out to many addresses.

Recommendation:

- Do not include USTB in v1 blacklist expansion.
- Add `AdminBurn` as seize-only only if the methodology explicitly distinguishes it.
- Treat allowlist modeling as a separate "permissioned-token compliance tracker" feature.

Sources:

- Superstate smart contracts docs: `https://docs.superstate.com/welcome-to-superstate/smart-contracts`
- Superstate USTB GitHub: `https://github.com/superstateinc/ustb`
- USTB token source: `https://raw.githubusercontent.com/superstateinc/ustb/main/src/SuperstateToken.sol`
- Allowlist source: `https://raw.githubusercontent.com/superstateinc/ustb/main/src/allowlist/AllowList.sol`

### 15. OUSG (`ousg-ondo-finance`)

Status: not live-supported.

Local contracts:

- Ethereum `0x1b19c19393e2d034d8ff31ff34c81252fcbbee92`.
- Polygon `0xba11c5effa33c4d6f8f593cfa394241cfe925811`.
- Solana entry.

ABI findings:

- Ethereum token proxy resolves to `CashKYCSenderReceiver`.
- Token events include `KYCRegistrySet(address,address)` but no blocklist/freeze events.
- Token exposes `kycRegistry()` and `kycRequirementGroup()`.
- Ethereum `kycRegistry()` resolves to `0x56A5D911052323D688C731d516530878557463e7`.
- Registry ABI exposes:
  - `KYCRequirementGroupSet(uint256,address)`.
  - `OndoRegistrySet(address,address)`.
  - role events.
  - `isRegistered(address,address)`.
  - `getKYCStatus(uint256,address)`.
- No direct per-address blacklist/freeze event was found in the token or registry view ABI during the quick pass.

Implementation shape:

- This is not a current-module blacklist event.
- A KYC registry tracker would need to understand Ondo registry internals, not just token logs.
- Like USTB, "not KYC eligible" is not necessarily "blacklisted/frozen/destroyed".

Load estimate:

- No blacklist config recommended.
- If later modeled as compliance eligibility, expect state-table writes rather than `blacklist_events` rows.

Recommendation:

- Exclude from blacklist v1. Revisit only as a permissioned-token compliance tracker.

Source:

- Sourcify OUSG token implementation: `https://repo.sourcify.dev/contracts/full_match/1/0x1ceb44b6e515abf009e0ccb6ddafd723886cf3ff/metadata.json`

### 16. YLDS (`ylds-figure`)

Status: not live-supported.

Local contracts:

- Solana `8fr7WGTVFszfyNWRMXj6fRjZZAnDwmXwEpCrtzmUkdih`.
- Provenance `uylds.fcc`.

Findings:

- No EVM or Tron deployment is in local metadata.
- Current blacklist module has no Solana or Provenance event source.
- Figure's current public materials describe YLDS as multi-chain over time, but local active contracts for Pharos are Solana/Provenance.

Implementation shape:

- Solana support would require a new indexer path:
  - Token account freeze/thaw instructions, likely SPL Token or Token-2022 semantics.
  - Mint freeze authority / permanent delegate checks.
  - Account state snapshots for frozen token accounts.
  - Current balance reads through Solana RPC `getTokenAccountsByOwner` or indexed token account APIs.
- Provenance support would require Cosmos/Provenance transaction/event indexing.
- Neither path fits `fetchEvmEventsIncremental()` or `fetchTronEventsIncremental()`.

Load estimate:

- Not comparable to current module.
- Solana account-freeze tracking is likely heavier than EVM log scans unless backed by an indexer, because account state and instruction parsing are not exposed as simple contract topics.

Recommendation:

- Exclude from current expansion. Treat as a separate non-EVM compliance indexing project.

Source:

- Figure SEC-hosted filing surfaced current multi-chain statements, but local Pharos metadata remains Solana/Provenance only: `https://investors.figure.com/static-files/0acec7cd-0215-430b-a01c-c8a2349b6b1c`

### 17. A7A5 (`a7a5-old-vector`)

Status: not live-supported.

Local contracts:

- Ethereum `0x6fa0be17e4bea2fcfa22ef89bf8ac9aab0ab0fc9`.
- Tron `TLeVfrdym8RoJreJ23dAGyfJDygRtiWKBZ`.

ABI findings:

- Ethereum source resolves to `A7A5`.
- Relevant events:
  - `Blacklisted(address)`, topic `0xffa4e6181777692565cf28528fc88fd1516ea86b56da075235fa575af6a4b855`.
  - `DeBlacklisted(address)`, topic `0x8e6c9e5ceff66044a0b27759779a9be2e7c99655252b235ff3f754efb6b8a616`.
  - `DestroyedBlackFunds(address,uint256)`, topic `0x61e6e66b0d6339b2980aecc6ccc0039736791f0ccde9ed512e789a7fbdd698c6`.
- ABI marks blacklist address as non-indexed, so parse from `data` first word.
- Destroy address is non-indexed first word; amount is second word.
- Functions match Tether-like naming:
  - `addBlackList(address)`.
  - `removeBlackList(address)`.
  - `destroyBlackFunds(address)`.
  - `isBlackListed(address)`.

Implementation shape:

- Add a new A7A5 event family:
  - Reuse USDC `Blacklisted(address)` topic for blacklist but set unindexed address parsing.
  - Add `DeBlacklisted(address)` as unblacklist.
  - Reuse legacy Tether `DestroyedBlackFunds(address,uint256)` parsing.
- Current parser can already parse non-indexed address for events without `addressTopicIndex`; this should work.
- Add Ethereum config.
- Tron should be verified against TronGrid ABI/events before adding. If it follows the same names and result keys as Ethereum, extend the Tron parser event-name map for `Blacklisted` and `DeBlacklisted`. Current Tron map only knows Tether legacy and USD1 `Freeze`/`Unfreeze`.

Ledger semantics:

- Blacklist: insert event plus current balance upsert.
- DeBlacklisted: insert event only.
- DestroyedBlackFunds: emitted amount, so insert event plus ledger upsert with `source = "event"`.

Load estimate:

- Ethereum-only:
  - +1 config.
  - +3 log-topic calls/hour.
  - +1 D1 cursor read/write per hour.
- Ethereum + Tron if verified:
  - +2 configs.
  - +6 upstream event requests/hour.
  - Tron blacklist/unblacklist amount remains permanently unavailable unless current-balance ledger is used; destroy amount is emitted.

Recommendation:

- Good first-wave Ethereum asset. Tron can follow after event API verification.

Source:

- Sourcify Ethereum A7A5 contract: `https://repo.sourcify.dev/contracts/partial_match/1/0x6fa0be17e4bea2fcfa22ef89bf8ac9aab0ab0fc9/metadata.json`

## Recommended Implementation Order

1. USDG Ethereum.
   - Lowest risk, exact Paxos/PYUSD event shape.
2. U Ethereum + BSC.
   - Reuses USD1 `Freeze/Unfreeze` shape.
3. RLUSD Ethereum.
   - Simple account pause events, but document clawback gap.
4. A7A5 Ethereum.
   - Tether-like, only needs `DeBlacklisted` event family and maybe symbol enum/color.
5. USDTB Ethereum.
   - High value, but requires dynamic `address[]` decoding and multi-row IDs.
6. USDY Ethereum, then Arbitrum.
   - Requires event-source contract provenance and list-source collision policy.
7. BUIDL seize-only.
   - Only after deciding whether "seize-only" belongs on `/blacklist`.
8. USTB admin-burn or allowlist model.
   - Only after defining a separate permissioned-token compliance methodology.
9. OUSG, USYC, YLDS.
   - Do not implement in the existing blacklist tracker without new source models.

## Concrete Code Changes for First Wave

Files likely touched:

- `shared/types/market.ts`
  - Add `USDG`, `RLUSD`, `U`, `USDTB`, `A7A5`.
  - If adding BUIDL/USDY/USTB later, add those only when their semantics are finalized.
- `shared/lib/classification.ts`
  - Add chart colors for new enum values.
- `worker/src/lib/blacklist-contracts.ts`
  - Export/reuse event families:
    - Paxos freeze (`FreezeAddress`, `UnfreezeAddress`, `FrozenAddressWiped`) for USDG.
    - USD1 freeze (`Freeze`, `Unfreeze`) for U.
    - New Ripple account pause family.
    - New USDTB batch block family.
    - New A7A5 black/deblack/destroy family.
  - Add chain constants as needed using `chainConfig()`.
  - Add configs.
- `worker/src/cron/blacklist/evm-source.ts`
  - Add dynamic `address[]` event expansion for USDTB.
  - Change row ID generation for multi-address logs.
  - Consider adding `addressDataIndex` or `addressArrayDataIndex` to `BlacklistEventDef`.
- `worker/src/cron/blacklist/tron-source.ts`
  - Only if A7A5 Tron is added; add event names/result keys after verification.
- `worker/src/cron/blacklist/amount-recovery.ts`
  - Ensure `FrozenAddressWiped` for USDG resolves with USDG config.
  - No change expected for U/RLUSD/A7A5 Ethereum.
- `worker/src/cron/blacklist/current-balance-cache.ts`
  - Confirm current balance source uses token contract when event source differs. Needed for USDY/USTB later, not first wave except USDTB uses token contract normally.
- `shared/lib/blacklist-aggregates.ts`
  - Mostly dynamic already, but summary fields `usdcBlacklisted`, `usdtBlacklisted`, and `goldBlacklisted` are legacy-specific. Adding many stablecoins increases the mismatch between public stats and live enum.
- `src/components/blacklist-stats.tsx`
  - Review copy/stats. Current headline buckets are USDC/USDT/gold-centric.
- Tests:
  - `worker/src/lib/__tests__/blacklist-contracts.test.ts` if present or add one.
  - `worker/src/cron/blacklist` parser tests for each new event family.
  - `shared/lib/__tests__/blacklist-aggregates.test.ts`.
  - `src/lib/__tests__/blacklist-api.test.ts`.
  - `src/app/blacklist/view-model.test.tsx`.

## Open Decisions Before Coding

- Should the public enum grow to 10-15 symbols immediately, or should `/blacklist` separate "covered assets" from filter chips?
- Should "seize-only" events be represented as `destroy`, or should `BlacklistEventType` get a new `seize` value?
- Should list-based systems such as USDY use the existing address key or include `restriction_source` to distinguish blocklist and sanctions list?
- Should permissioned-token allowlist removals (USTB/OUSG) be in this module at all, or in a separate compliance/permission tracker?
- For NAV/yield-bearing tokens, should frozen/seized USD valuation use token count, price cache, NAV oracle, or event-date price? USTB/OUSG/BUIDL/USYC are not all $1 redemption tokens in the same way.

## Bottom Line

The clean, low-risk expansion is not "all centralized assets over $500M." It is a smaller first wave:

- USDG Ethereum.
- U Ethereum/BSC.
- RLUSD Ethereum.
- A7A5 Ethereum.
- USDTB Ethereum after batch parser support.

That first wave would add roughly 14 log-topic calls/hour and 7 cursor read/write pairs/hour in steady state, with event-time writes scaling mostly one or two D1 writes per affected address.

USDY is the highest-value second wave, but it needs event-source-contract provenance and dynamic list decoding. BUIDL, USTB, OUSG, USYC, and YLDS should not be forced into the current blacklist model without explicit methodology changes, because their on-chain controls are seize-only, allowlist/KYC, absent from token logs, or non-EVM/non-Tron.
