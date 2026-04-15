# Blacklist First-Wave Expansion Implementation Plan

Date: 2026-04-15

Research input: `agents/research/2026-04-15-cefi-blacklist-expansion-research.md`

## Scope

Implement the clear first-wave additions from the research document:

- `usdg-paxos` / USDG on Ethereum.
- `rlusd-ripple` / RLUSD on Ethereum.
- `u-united-stables` / U on Ethereum and BSC.
- `usdtb-ethena` / USDTB on Ethereum.
- `a7a5-old-vector` / A7A5 on Ethereum.

Do not include these second-wave or non-fit assets in this implementation:

- USDY: requires event-source contract provenance and list-source collision policy.
- BUIDL: seize-only and no direct freeze event found.
- USTB/OUSG: allowlist/KYC systems, not direct blacklist/freezes.
- USYC: no verified token-level blacklist/freeze event found.
- YLDS: non-EVM/non-Tron indexing project.
- A7A5 Tron: defer until TronGrid event shape/result keys are verified.

## Assumptions

- The first-wave implementation should preserve the current public event-type model: `blacklist`, `unblacklist`, `destroy`.
- "Freeze", "account pause", "block", and "blacklist" all map to `blacklist` because the current public surface is an issuer-intervention freeze ledger, not a legal-term-only blacklist ledger.
- "Unfreeze", "account unpause", "unblock", and "deblacklist" all map to `unblacklist`.
- USDTB has no destroy/seize support in the verified ABI; first-wave USDTB support is block/unblock only.
- RLUSD has a `clawback(address,uint256)` function but no explicit clawback event in the ABI; first-wave RLUSD support is account pause/unpause only. Transaction-input-based clawback classification is deferred.
- A7A5 is RUB-pegged. Event-time and ledger USD values must use price-cache conversion, not `amountNative` as USD.
- New historical start blocks must be determined before coding configs; no new EVM config should start at block `0`.

## Success Criteria

- `CONTRACT_CONFIGS` includes the five first-wave assets/chains, resolved from shared stablecoin metadata.
- Parser supports all first-wave event shapes:
  - indexed address in `topics[2]` for U.
  - non-indexed static address for RLUSD and A7A5.
  - dynamic `address[]` for USDTB batch block/unblock.
  - emitted destroy amount for A7A5.
  - no-amount wipe for USDG.
- USDTB batch logs expand to one row per affected address with unique row IDs.
- A7A5 USD values use `price_cache` (`asset_id = 'a7a5-old-vector'`) in the same style PAXG/XAUT use price-cache conversion.
- Public API schema, chart colors, filters, and coverage logic accept new symbols.
- Blacklist methodology docs and changelog reflect the coverage expansion and parser/valuation changes.
- Focused tests cover new contract configs, parser behavior, dynamic-array rows, non-USD valuation, and API symbol validation.
- Relevant validation passes locally.

## Implementation Steps

### 1. Confirm start blocks

Before editing `CONTRACT_CONFIG_SPECS`, derive deployment/start blocks for:

- USDG Ethereum.
- RLUSD Ethereum.
- U Ethereum.
- U BSC.
- USDTB Ethereum.
- A7A5 Ethereum.

Use one of:

- existing exact mint/burn start blocks when already curated and known exact,
- public explorer creation metadata if available,
- or a bounded public-RPC binary search for first non-empty contract code.

Record the chosen blocks in the implementation notes or comments only if they are non-obvious. The configs themselves should carry the exact `startBlock` values.

Confirmed during implementation:

- USDG Ethereum: `20_915_336`
- RLUSD Ethereum: `20_492_031`
- U Ethereum: `24_030_193`
- U BSC: `71_922_111`
- USDTB Ethereum: `21_287_284`
- A7A5 Ethereum: `22_080_045`

### 2. Extend public blacklist symbols

File: `shared/types/market.ts`

Add to `BLACKLIST_STABLECOINS`:

- `USDG`
- `RLUSD`
- `U`
- `USDTB`
- `A7A5`

Expected downstream effects:

- `BlacklistStablecoin` widens.
- API stablecoin filter accepts the new symbols.
- `BlacklistChartPointSchema` gains zero/default fields for the new symbols.
- DEWS issuer-freeze signal coverage can apply to the new symbols when those IDs are PSI-eligible.
- Coverage page marks these symbols as blacklist-covered.

### 3. Add chart colors

File: `shared/lib/classification.ts`

Add `BLACKLIST_CHART_COLORS` entries for the new symbols. Use distinct colors that do not collapse into existing USDT/USDC/PYUSD/USD1/gold colors.

No design refactor in this task. The current filter chips already wrap; leave a larger control redesign for a dedicated UI pass.

### 4. Generalize price-cache valuation for non-USD blacklist assets

Files:

- `shared/lib/blacklist.ts`
- `worker/src/cron/blacklist/current-balance-cache.ts`
- `worker/src/cron/blacklist/amount-recovery.ts`

Current behavior:

- `computeBlacklistAmountUsdAtEvent()` returns `amountNative` for every non-gold symbol.
- PAXG/XAUT pass an optional gold price fetched from `price_cache`.

Required behavior:

- Keep gold-only zero-balance override exactly gold-only.
- Introduce a small symbol-to-price-cache map for symbols that require multiplication by an asset price:
  - `PAXG -> paxg-paxos`
  - `XAUT -> xaut-tether`
  - `A7A5 -> a7a5-old-vector`
- Generalize the price fetch helper so A7A5 enrichment and current-balance upserts receive a USD price.
- If A7A5 price is unavailable, store `amount_usd_at_event = null` / `amount_usd = null` instead of silently treating RUB amount as USD.
- Preserve existing PAXG/XAUT behavior and tests.

Implementation shape:

- Add `getBlacklistPriceAssetId(stablecoin)` or equivalent in `shared/lib/blacklist.ts`.
- Keep `isGoldBlacklistStablecoin()` for the zero-balance override.
- Rename `fetchGoldPriceFromCache()` to a generic helper, or keep a wrapper alias if that reduces churn.
- Update `enrichRowBalances()` and `backfillAmounts()` to fetch price for any priced blacklist symbol.
- Update `syncCurrentBalanceCacheForRows()` to fetch price for any priced blacklist symbol.

### 5. Add first-wave event families and configs

File: `worker/src/lib/blacklist-contracts.ts`

Add event definitions:

USDG:

- Reuse `PYUSD_EVENT_FAMILY`:
  - `FreezeAddress(address)`
  - `UnfreezeAddress(address)`
  - `FrozenAddressWiped(address)`

U:

- Reuse `USD1_EVENT_FAMILY`:
  - `Freeze(address,address)` with `addressTopicIndex: 2`
  - `Unfreeze(address,address)` with `addressTopicIndex: 2`

RLUSD:

- New family:
  - `AccountPaused(address)` topic `0xae7f60c1b8f645c3beffeb531169cbc446874bbf247698325318879ac850c346` -> `blacklist`
  - `AccountUnpaused(address)` topic `0x0c18efbde61ac471ead6960a3f1097735c68ecdb685ae8e2a108c28385399a65` -> `unblacklist`
- ABI marks address as non-indexed; no `addressTopicIndex`.

USDTB:

- New family:
  - `AccountsBlocked(address[])` topic `0x5444f9841c04ce78987f28701fa07fc4c112840c1c8439e8f52bda50c3788a87` -> `blacklist`
  - `AccountsUnblocked(address[])` topic `0x4a637dd1cd99ae43d353009d0ffbc16b05cc69808b819ebf852c68ea47b34dd4` -> `unblacklist`
- Mark these event definitions as dynamic address-list events.

A7A5:

- New family:
  - `Blacklisted(address)` topic `0xffa4e6181777692565cf28528fc88fd1516ea86b56da075235fa575af6a4b855` -> `blacklist`
  - `DeBlacklisted(address)` topic `0x8e6c9e5ceff66044a0b27759779a9be2e7c99655252b235ff3f754efb6b8a616` -> `unblacklist`
  - `DestroyedBlackFunds(address,uint256)` topic `0x61e6e66b0d6339b2980aecc6ccc0039736791f0ccde9ed512e789a7fbdd698c6` -> `destroy`
- ABI marks address as non-indexed; no `addressTopicIndex`.
- Destroy amount is emitted in the second ABI word, which current non-indexed destroy parsing already supports.

Add config specs:

- `{ chain: ETHEREUM, stablecoinId: "usdg-paxos", startBlock, events: PYUSD_EVENT_FAMILY.events }`
- `{ chain: ETHEREUM, stablecoinId: "rlusd-ripple", startBlock, events: RLUSD_EVENT_FAMILY.events }`
- `{ chain: ETHEREUM, stablecoinId: "u-united-stables", startBlock, events: U_EVENT_FAMILY.events }`
- `{ chain: BSC, stablecoinId: "u-united-stables", startBlock, events: U_EVENT_FAMILY.events }`
- `{ chain: ETHEREUM, stablecoinId: "usdtb-ethena", startBlock, events: USDTB_EVENT_FAMILY.events }`
- `{ chain: ETHEREUM, stablecoinId: "a7a5-old-vector", startBlock, events: A7A5_EVENT_FAMILY.events }`

### 6. Add dynamic `address[]` parsing

File: `worker/src/cron/blacklist/evm-source.ts`

Extend `BlacklistEventDef` with a narrowly scoped flag, for example:

```ts
addressArrayData?: boolean;
```

Parser behavior:

- If `addressArrayData` is true:
  - Decode `log.data` as ABI `address[]`.
  - Create one `BlacklistRow` per address.
  - Row ID must include per-address index: `{chainId}-{txHash}-{logIndex}-{addressIndex}`.
  - `amount_native` is null.
  - `amount_status` is `recoverable_pending` for block events and the normal pending status for unblock events, matching current amount-recovery semantics.
- If decoding fails or array is empty, skip that log without inserting malformed rows.
- Existing single-address behavior remains unchanged.

Preferred decoder:

- Use `decodeAbiParameters` from `viem/utils`, already used elsewhere in the worker.
- Avoid ad hoc string slicing for the dynamic array.

Load note:

- Each USDTB blocked address will enter normal historical amount enrichment and then current-balance cache sync. A 100-address batch can therefore use about 200 balance calls before budget exhaustion. That is acceptable because the existing budget will leave unresolved rows for later backfill if needed.

### 7. Keep current ledger semantics

No schema migration for first wave.

Expected row behavior:

- USDG freeze: event insert + historical amount attempt + current-balance ledger upsert.
- USDG wipe: event insert + destroy amount recovery via receipt/historical balance + destroy ledger upsert.
- RLUSD account pause: event insert + historical amount attempt + current-balance ledger upsert.
- RLUSD account unpause: event insert only; ledger preserved.
- U freeze/unfreeze: same as USD1.
- USDTB account block/unblock: same as freeze/unfreeze, but batch-expanded.
- A7A5 blacklist/deblacklist/destroy: same as USDT legacy, with A7A5 price-cache USD conversion.

Do not add a new `seize` event type in this task.

### 8. Update docs and methodology

Files:

- `docs/blacklist-tracker.md`
- `docs/blacklist-tracker-timeline.md`
- `src/app/methodology/sections/monitoring/blacklist-tracker-section.tsx`
- `shared/lib/blacklist-tracker-version.ts`

Version:

- Bump Blacklist Tracker from `3.7` to `3.8`.
- Use date `2026-04-15`.
- Add changelog entry:
  - first-wave coverage for USDG, RLUSD, U, USDTB, A7A5,
  - dynamic `address[]` parsing for USDTB,
  - A7A5 non-USD price-cache valuation,
  - explicit carve-out that RLUSD clawback and A7A5 Tron are not part of this release.

Docs:

- Update cron-backed sync coverage list.
- Update live API/UI filter enum list.
- Add contract configuration tables for first-wave assets.
- Add event signature details for new families.
- Update gotchas with:
  - USDTB batch events expand one log into many rows.
  - A7A5 is RUB-pegged and uses price-cache conversion.
  - RLUSD clawback is not covered by account-pause tracking.

### 9. Tests

Add/update tests:

- `worker/src/lib/__tests__/blacklist-contracts.test.ts`
  - Existing metadata alignment test should cover new configs automatically.
  - Add targeted assertions that first-wave configs exist.
  - Add topic/signature lookup assertions for new families.
- `worker/src/cron/blacklist/__tests__/evm-source.test.ts`
  - RLUSD non-indexed address data.
  - A7A5 non-indexed destroy amount.
  - USDTB `address[]` dynamic batch expands into multiple rows and unique IDs.
  - Existing USDC/USD1 regressions still pass.
- `worker/src/cron/blacklist/__tests__/current-balance-cache.test.ts`
  - A7A5 price-cache conversion for ledger upsert.
  - Gold zero-balance override still only applies to PAXG/XAUT.
- `shared/lib/__tests__/blacklist-aggregates.test.ts`
  - Exact chart objects must include new zero-value symbol keys, or assertions should become more targeted.
  - Add one chart assertion for a new first-wave symbol.
- `worker/src/api/__tests__/blacklist.test.ts`
  - New symbol filters accepted.
  - EURC still rejected.
- Any `BlacklistSummaryResponse` fixtures that hard-code chart objects must include the new keys.

### 10. Verification

Focused commands after implementation:

```bash
npm test -- worker/src/cron/blacklist/__tests__/evm-source.test.ts worker/src/lib/__tests__/blacklist-contracts.test.ts worker/src/cron/blacklist/__tests__/current-balance-cache.test.ts worker/src/api/__tests__/blacklist.test.ts shared/lib/__tests__/blacklist-aggregates.test.ts
npm run check:doc-sync
cd worker && npx tsc --noEmit
```

If code touched shared public schemas in a way that broad tests may catch, run:

```bash
npm test
```

Pre-push remains:

```bash
npm run test:merge-gate
```

## Review Loop

### Review 1 Findings

Severity scale: Critical, High, Medium, Low.

- Medium: A7A5 is RUB-pegged, but the initial implementation idea would have inherited the current non-gold `amountNative === amountUsd` assumption. That would materially overstate USD frozen/destroyed value.
- Medium: USDTB batch block events can produce many rows from one log. If row IDs remain `{chainId}-{txHash}-{logIndex}`, every address after the first would collide.
- Medium: New configs must not start at genesis. BSC/large EVM RPC scans from `0` would create avoidable backlog and load.
- Low: RLUSD has clawback but no explicit clawback event; the release needs a documented gap so users do not infer clawback coverage.
- Low: Adding five symbols expands filter chips and chart keys; tests with exact chart objects will need updates.

### Review 1 Fixes Applied To Plan

- Added a dedicated price-cache valuation step for A7A5 and preserved gold-only zero-balance override semantics.
- Added dynamic `address[]` parsing with per-address row ID suffixing.
- Added explicit start-block confirmation as step 1.
- Added RLUSD clawback exclusion to assumptions and docs requirements.
- Added exact test updates for schema/chart fixture expansion.

### Review 2 Findings

Severity scale: Critical, High, Medium, Low.

- Low: The plan still allows USDTB historical amount enrichment to double balance calls for large batches. This is acceptable under the existing 900-call budget because unresolved rows already degrade to backfill; no Medium issue remains.
- Low: The plan does not redesign legacy summary cards (`usdcBlacklisted`, `usdtBlacklisted`, `goldBlacklisted`) for the larger symbol set. This is acceptable for a first-wave tracker expansion because `frozenAddresses`, `trackedAddressCount`, and `trackedFrozenTotal` already cover all symbols, and a stats redesign would be a separate product change.

Review 2 result: 0 Medium-or-higher plan issues remain. Implementation may proceed.
