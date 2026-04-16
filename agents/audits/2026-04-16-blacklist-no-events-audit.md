# Blacklist No-Events Implementation Audit

Date: 2026-04-16

## Scope

Affected symbols: U, FDUSD, BRZ, EURI, USDQ, USDX, AID, TGBP, EURC, and BUIDL.

Assumption: "no events" means public `/api/blacklist` and dashboard event output are empty for these symbols, not that no onchain issuer actions exist.

Success criteria:

- Confirm each affected symbol is included in the shared blacklist enum and worker contract registry.
- Confirm contract addresses, decimals, start blocks, and event parser configuration are internally consistent.
- Check production D1 event counts and sync cursors for these symbols.
- Run the targeted blacklist parser/API/shared tests.

## Findings

1. Registry and parser coverage is present for all ten symbols.

   - `shared/types/market.ts` includes all ten symbols in `BLACKLIST_STABLECOINS`.
   - `worker/src/lib/blacklist-contracts.ts` has configs for each affected symbol.
   - Parser support exists for the required event shapes: indexed address, dual-indexed address, non-indexed data address, dynamic address array, indexed amount topic, explicit data-slot amount, and BUIDL seize data slots.

2. Verified implementation ABIs match the configured event families for the Ethereum implementations checked through Sourcify/RPC.

   - FDUSD, EURI, and U expose `Freeze(address indexed,address indexed)` and `Unfreeze(address indexed,address indexed)`.
   - BRZ exposes `Blacklisted(address indexed)` and `UnBlacklisted(address indexed)`.
   - USDQ exposes `BlockPlaced(address indexed)`, `BlockReleased(address indexed)`, and `DestroyedBlockedFunds(address indexed,uint256)`.
   - USDX exposes `AddedBlacklist(address)` and `RemovedBlacklist(address)`.
   - AID exposes `AddedToDenyList(address[])` and `RemovedFromDenyList(address[])`.
   - TGBP exposes `Banned(address indexed)` and `UnBanned(address indexed)`.
   - BUIDL's implementation exposes `Seize(address indexed,address indexed,uint256,string)` and `OmnibusSeize(address indexed,address,uint256,string,uint8)`; the configured affected-address slots match the ABI field names.

3. Production D1 currently has no public rows for the affected set.

   - EURC is the only affected symbol with stored rows.
   - All EURC rows are suppressed as `circle_mirror_zero_balance`, with `amount_native = 0`, so public `/api/blacklist` correctly returns no EURC rows.
   - The other nine symbols have zero stored rows in `blacklist_events`.

4. Ethereum configs are generally caught up, but several non-Ethereum configs are still backfilling from their start blocks.

   Examples from production cursors versus live RPC heads during this audit:

   - Ethereum affected configs were within a few hundred blocks of head.
   - BSC FDUSD cursor was around block 30.85M while BSC head was around 92.85M.
   - BSC EURI cursor was around 42.87M while BSC head was around 92.85M.
   - BSC U cursor was around 74.92M while BSC head was around 92.85M.
   - Avalanche BUIDL cursor was around 55.40M while Avalanche head was around 83.08M.
   - Avalanche TGBP cursor was around 72.45M while Avalanche head was around 83.08M.
   - Gnosis BRZ cursor was still at deployment start minus one while Gnosis head was around 45.70M.

5. Recent `sync-blacklist` cron metadata shows budget/backlog pressure.

   - Recent runs used the full `900/900` subrequest budget and skipped configs while still reporting status `ok`.
   - Recent metadata also showed `no-coverage` entries for Gnosis BRZ and Avalanche BUIDL. In context, these are consistent with budget exhaustion or partial scan coverage, not necessarily bad contract topics.
   - Earlier runs showed `D1_ERROR: too many SQL variables` for high-row configs. The code has one conservative chunking precedent (`D1_SAFE_MAX_SQL_VARIABLES = 90`) in `worker/src/lib/alchemy-logs.ts`, while `filterNewBlacklistRows()` currently chunks 99 IDs. This is a plausible ingestion reliability issue for high-event batches.

6. Coverage is intentionally partial for some multi-chain deployments.

   - BRZ has additional Polygon, BSC, Base, Arbitrum, and Solana deployments not covered by the blacklist registry.
   - USDQ has Polygon, XRPL, and Algorand deployments not covered by the blacklist registry.
   - AID has Arbitrum and Base deployments not covered by the blacklist registry.
   - TGBP has Base, BSC, and Polygon deployments not covered by the blacklist registry.
   - EURC has World Chain, Stellar, and Solana deployments not covered by the blacklist registry.
   - BUIDL has Solana and Aptos deployments not covered by the blacklist registry.

## Validation

Command run:

```bash
npm test -- worker/src/cron/__tests__/sync-blacklist.test.ts worker/src/lib/__tests__/blacklist-contracts.test.ts worker/src/cron/blacklist/__tests__/evm-source.test.ts worker/src/cron/blacklist/__tests__/amount-recovery.test.ts worker/src/api/__tests__/blacklist.test.ts worker/src/api/__tests__/blacklist-summary.test.ts shared/lib/__tests__/blacklist.test.ts shared/lib/__tests__/blacklist-aggregates.test.ts shared/lib/__tests__/blacklist-active-records.test.ts
```

Result: 9 files passed, 81 tests passed.

## Conclusion

The affected symbols do not appear empty because of bad local event signatures, bad parser extraction, missing API enum entries, or missing registry entries.

The stronger implementation risks are operational:

- the non-Ethereum backfill is not caught up for several affected configs, so events after the current cursor would not be visible yet;
- the sync can exhaust its subrequest budget and skip configs while still surfacing an `ok` cron status;
- the 99-ID duplicate check chunk may exceed D1's practical SQL-variable ceiling on high-row batches.

EURC is a special case: events are being ingested, but they are all zero-balance mirror rows and are intentionally suppressed from public surfaces.

## Remediation Applied

- EVM config scans now mark the result incomplete when the subrequest budget is exhausted before all configured event topics are scanned, so the cursor stays pinned instead of advancing past unscanned topics.
- `sync-blacklist` now reports budget-exhausted config skips as degraded via `subrequestBudgetReached`.
- The duplicate-row precheck chunk was reduced from 99 to 90 IDs to stay below D1's practical SQL-variable ceiling.
- Added a regression test for the multi-topic budget-exhaustion cursor case.
