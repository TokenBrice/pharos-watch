# Design: pyUSD + USD1 Blacklist Tracking

**Date**: 2026-03-24
**Status**: Approved
**Methodology version**: v3.2 → v3.3

## Summary

Add blacklist event tracking for pyUSD (PayPal/Paxos) and USD1 (World Liberty Financial) to the existing blacklist tracker. pyUSD is a config-level addition using Paxos freeze events. USD1 requires a small parser extension to handle two-indexed-address events where the affected address is in `topics[2]`.

## Scope

### pyUSD (PayPal USD, Paxos)

- **Chains**: Ethereum, Arbitrum
- **Contract source**: Resolved from `shared/data/stablecoins/usd-major.json` via `resolveTrackedContractConfig`
- **Decimals**: 6
- **Event family** ("paxos-pyusd-freeze"):

| Event | Signature | Type | hasAmount | addressTopicIndex |
|---|---|---|---|---|
| FreezeAddress | `FreezeAddress(address)` | blacklist | false | 1 (default) |
| UnfreezeAddress | `UnfreezeAddress(address)` | unblacklist | false | 1 (default) |
| FrozenAddressWiped | `FrozenAddressWiped(address)` | destroy | false | 1 (default) |

Amount recovery for all three events uses the existing backfill pipeline (balanceOf at blockNumber-1), identical to the PAXG pattern.

### USD1 (World Liberty Financial)

- **Chains**: Ethereum, BSC, Tron
- **Contract source**: Resolved from `shared/data/stablecoins/usd-major.json` via `resolveTrackedContractConfig`
- **Decimals**: 18
- **Event family** ("wlfi-freeze"):

| Event | Signature | Type | hasAmount | addressTopicIndex |
|---|---|---|---|---|
| Freeze | `Freeze(address,address)` | blacklist | false | 2 |
| Unfreeze | `Unfreeze(address,address)` | unblacklist | false | 2 |

No destroy/wipe event exists. Frozen funds are immobilized but not seized.

The `Freeze(address indexed caller, address indexed account)` event has two indexed address parameters. The affected account is in `topics[2]`, not `topics[1]`. This requires the `addressTopicIndex` parser extension described below.

### Tron risk (USD1 only)

TronGrid may return empty `result` objects if the USD1 Tron contract is not ABI-verified on Tronscan. In that case, address extraction will fail and rows will be unusable. Mitigation: verify during implementation whether TronGrid decodes the events. If not, defer USD1 Tron support until contract verification or alternative decoding is available.

## Design

### 1. Type and schema changes

**`shared/types/market.ts`**:

Extend the blacklist stablecoin union:
```ts
export const BLACKLIST_STABLECOINS = ["USDC", "USDT", "PAXG", "XAUT", "PYUSD", "USD1"] as const;
```

Make `BlacklistChartPointSchema` dynamic instead of hardcoded. Replace the fixed-key schema with a dynamic shape driven by `BLACKLIST_STABLECOINS`:
```ts
const BlacklistChartPointSchema = z.object({
  quarter: z.string(),
  ...Object.fromEntries(BLACKLIST_STABLECOINS.map((s) => [s, z.number()])),
  total: z.number(),
});
```

Update `SummaryRow` in `worker/src/api/blacklist-summary.ts` to use `BlacklistStablecoin` from shared types instead of the hardcoded union `"USDC" | "USDT" | "PAXG" | "XAUT"`.

### 2. BlacklistEventDef extension

**`worker/src/lib/blacklist-contracts.ts`**: Add two optional fields to `BlacklistEventDef`.

```ts
export interface BlacklistEventDef {
  signature: string;
  topicHash: string;
  eventType: BlacklistEventType;
  hasAmount: boolean;
  addressTopicIndex?: number;  // EVM: which topics[] slot holds the affected address (default 1)
  tronResultKey?: string;      // Tron: which result key holds the affected address
}
```

### 3. Event families and contract configs

**`worker/src/lib/blacklist-contracts.ts`**: Define new event families and contract config specs.

pyUSD event family ("paxos-pyusd-freeze"):
- Compute keccak256 topic hashes for `FreezeAddress(address)`, `UnfreezeAddress(address)`, `FrozenAddressWiped(address)`
- All three: `hasAmount: false`, no `addressTopicIndex` (default 1)

USD1 event family ("wlfi-freeze"):
- Compute keccak256 topic hashes for `Freeze(address,address)`, `Unfreeze(address,address)`
- Both: `hasAmount: false`, `addressTopicIndex: 2`, `tronResultKey: "account"`

Contract config specs:
- `{ chain: ETHEREUM, stablecoinId: "pyusd-paypal", events: PYUSD_EVENT_FAMILY.events }`
- `{ chain: ARBITRUM, stablecoinId: "pyusd-paypal", events: PYUSD_EVENT_FAMILY.events }`
- `{ chain: ETHEREUM, stablecoinId: "usd1-world-liberty-financial", events: USD1_EVENT_FAMILY.events }`
- `{ chain: BSC, stablecoinId: "usd1-world-liberty-financial", events: USD1_EVENT_FAMILY.events }`
- `{ chain: TRON, stablecoinId: "usd1-world-liberty-financial", events: USD1_EVENT_FAMILY.events }`

### 4. EVM parser change

**`worker/src/cron/blacklist/evm-source.ts`**, `parseEvmLogs`: Replace hardcoded `topics[1]` with configurable index.

```ts
// Before:
const addressIndexed = log.topics.length > 1;
const affectedAddress = addressIndexed
  ? decodeAddress(log.topics[1])
  : decodeAddress(log.data.slice(0, 66));

// After:
const topicIdx = eventDef.addressTopicIndex ?? 1;
const addressIndexed = log.topics.length > topicIdx;
const affectedAddress = addressIndexed
  ? decodeAddress(log.topics[topicIdx])
  : decodeAddress(log.data.slice(0, 66));
```

All existing configs default to index 1. Zero behavioral change for current stablecoins.

### 5. Tron parser changes

**`worker/src/cron/blacklist/tron-source.ts`**:

Extend `TRON_EVENT_NAME_MAP`:
```ts
const TRON_EVENT_NAME_MAP: Record<string, BlacklistEventType> = {
  AddedBlackList: "blacklist",
  RemovedBlackList: "unblacklist",
  DestroyedBlackFunds: "destroy",
  Freeze: "blacklist",
  Unfreeze: "unblacklist",
};
```

Extend address extraction in `parseTronEvent`. Use `tronResultKey` as the primary lookup when set, then fall back to existing keys. Do NOT add hardcoded `evt.result.account` — rely on `tronResultKey` for USD1 specifics:
```ts
const affectedAddress =
  (eventDef.tronResultKey && evt.result[eventDef.tronResultKey])
  || evt.result._user
  || evt.result._blackListedUser
  || evt.result["0"]
  || evt.result["1"]
  || "";
```

**Note on Tron amount_status**: The existing Tron parser sets `amount_status: "permanently_unavailable"` for non-destroy events with null amounts. This means USD1 Tron freeze/unfreeze events will not be eligible for balance backfill, unlike their EVM counterparts which get `"recoverable_pending"`. This is intentional — Tron does not reliably support historical `balanceOf` lookups, consistent with how USDT Tron blacklist events are handled today.

### 6. Amount enrichment

No changes to `sync-blacklist.ts` backfill logic or `balance-providers.ts`. The existing pipeline handles new configs automatically:
- Freeze/unfreeze events with `amount_status: "recoverable_pending"` get balanceOf lookups
- pyUSD `FrozenAddressWiped` uses pre-block balance (same as PAXG)
- USD1 has no destroy event

### 7. Aggregation layer fixes

Several aggregation modules have hardcoded 4-stablecoin references that must be updated:

**`shared/lib/blacklist-aggregates.ts`**:

`BlacklistChartPoint` interface — make dynamic. Replace the fixed `USDT`, `USDC`, `PAXG`, `XAUT` properties with a `Record<BlacklistStablecoin, number>` intersection (or generate keys from `BLACKLIST_STABLECOINS`):
```ts
export type BlacklistChartPoint = { quarter: string; total: number } & Record<BlacklistStablecoin, number>;
```

`buildBlacklistChartData` — three hardcoded sites to make dynamic:
1. Bucket initialization (line 91): replace `{ USDT: 0, USDC: 0, PAXG: 0, XAUT: 0 }` with a factory from `BLACKLIST_STABLECOINS`
2. Total computation (line 101): replace summing four named keys with `BLACKLIST_STABLECOINS.reduce()`
3. Result push (lines 102-108): replace individual `USDT: bucket?.USDT ?? 0` spreads with a dynamic spread from the bucket

```ts
const emptyBucket = () => Object.fromEntries(BLACKLIST_STABLECOINS.map((s) => [s, 0])) as Record<BlacklistStablecoin, number>;
// ... bucket init:
const bucket = buckets.get(sortKey) ?? emptyBucket();
// ... total:
const total = BLACKLIST_STABLECOINS.reduce((sum, s) => sum + (bucket?.[s] ?? 0), 0);
// ... result push:
result.push({ quarter: sortKeyToLabel(sortKey), ...Object.fromEntries(BLACKLIST_STABLECOINS.map((s) => [s, bucket?.[s] ?? 0])), total });
```

`computeBlacklistSummaryStats` — the routing logic at line 56 sends all non-USDC/non-gold stablecoins into the `usdtAddresses` bucket. Since we decided not to add dedicated stat cards for pyUSD/USD1 (decision C), add an explicit `otherAddresses` bucket for non-USDC/non-USDT/non-gold stablecoins. These feed into `frozenAddresses` (total) but not into any issuer-specific card. Update the routing:
```ts
const map = isGold ? goldAddresses
  : evt.stablecoin === "USDC" ? usdcAddresses
  : evt.stablecoin === "USDT" ? usdtAddresses
  : otherAddresses;
```

### 8. API

**`worker/src/api/blacklist-summary.ts`**: Update the local `SummaryRow` type to use `BlacklistStablecoin` from shared types instead of the hardcoded `"USDC" | "USDT" | "PAXG" | "XAUT"` union.

**`worker/src/api/blacklist.ts`**: No changes — filter validation already driven by shared types.

### 9. Frontend

**`src/components/blacklist-chart.tsx`**: Update `STABLECOINS_ORDER` to include PYUSD and USD1:
```ts
const STABLECOINS_ORDER = ["USDT", "USDC", "PYUSD", "USD1", "PAXG", "XAUT"] as const satisfies readonly BlacklistStablecoin[];
```
Update the stacked bar radius logic (currently applied to XAUT as the top bar) to apply to the last element dynamically.

**`shared/lib/classification.ts`**: Add entries to `BLACKLIST_CHART_COLORS`:
```ts
export const BLACKLIST_CHART_COLORS: Record<BlacklistStablecoin, string> = {
  USDT: "#06b6d4",
  USDC: "#3b82f6",
  PYUSD: "#002e6e",  // PayPal brand blue (dark)
  USD1: "#c026d3",   // Fuchsia — distinct from existing palette
  PAXG: "#eab308",
  XAUT: "#f59e0b",
};
```
(Final colors to be verified during implementation — PYUSD `#002e6e` at 62% opacity may lack contrast on dark themes. Pick a lighter alternative if needed.)

**Stats cards** (`blacklist-stats.tsx`): No changes — pyUSD/USD1 events contribute to `frozenAddresses` total and `recentCount` but not to issuer-specific cards.

**Filter dropdowns**: Automatically include new entries via `BLACKLIST_STABLECOINS`.

**Table**: Renders whatever the API returns. No changes.

**`computeBlacklistAmountUsdAtEvent`**: pyUSD and USD1 are USD-pegged, fall through to default path. No change needed.

### 10. Methodology and documentation

- Bump methodology version to **v3.3** in `shared/lib/blacklist-tracker-version.ts`
- Update `docs/blacklist-tracker.md`: add pyUSD and USD1 to tracked stablecoins table, document event families and chain coverage
- Update `docs/blacklist-tracker-timeline.md`: add v3.3 entry
- Update about page per CLAUDE.md convention

## Excluded chains

- **pyUSD** on Solana, Stellar, Flow: excluded because the blacklist tracker only supports EVM and Tron event sources. These chains would require new source implementations.
- **USD1** on Solana, Plume, Monad, Mantle, Aptos, Abcore: excluded for the same reason (non-EVM or nascent chains without mature indexing infrastructure).

## Files changed

| File | Change |
|---|---|
| `shared/types/market.ts` | Add PYUSD, USD1 to BLACKLIST_STABLECOINS; make BlacklistChartPointSchema dynamic |
| `shared/lib/blacklist-aggregates.ts` | Make BlacklistChartPoint dynamic; fix computeBlacklistSummaryStats routing to add otherAddresses bucket |
| `shared/lib/classification.ts` | Add PYUSD, USD1 entries to BLACKLIST_CHART_COLORS |
| `worker/src/lib/blacklist-contracts.ts` | Add addressTopicIndex/tronResultKey to interface, new event families, new config specs |
| `worker/src/cron/blacklist/evm-source.ts` | Use configurable addressTopicIndex in parseEvmLogs |
| `worker/src/cron/blacklist/tron-source.ts` | Extend TRON_EVENT_NAME_MAP, extend address extraction |
| `worker/src/api/blacklist-summary.ts` | Use BlacklistStablecoin type for SummaryRow |
| `src/components/blacklist-chart.tsx` | Update STABLECOINS_ORDER, fix stacked bar radius logic |
| `shared/lib/blacklist-tracker-version.ts` | Add v3.3 entry |
| `docs/blacklist-tracker.md` | Document new coverage |
| `docs/blacklist-tracker-timeline.md` | Add v3.3 changelog |
| `src/app/about/page.tsx` | Mention pyUSD/USD1 blacklist tracking |

## Files NOT changed

| File | Reason |
|---|---|
| `worker/src/cron/sync-blacklist.ts` | Backfill/enrichment logic works generically |
| `worker/src/cron/blacklist/balance-providers.ts` | Historical balance lookup works for all EVM chains |
| `worker/src/api/blacklist.ts` | Filter validation driven by shared types |
| `src/components/blacklist-stats.tsx` | No dedicated cards for new stablecoins |
| `src/components/blacklist-table.tsx` | Renders API response generically |

## Testing

- Unit test `parseEvmLogs` with a synthetic USD1 log where address is in `topics[2]`, verify correct extraction
- Unit test existing stablecoin logs still parse correctly with default addressTopicIndex (regression)
- Unit test `parseTronEvent` with USD1 event result containing `account` key via `tronResultKey`
- Unit test `TRON_EVENT_NAME_MAP` resolves `Freeze`/`Unfreeze` correctly
- Unit test `buildBlacklistChartData` includes PYUSD/USD1 in chart data and total
- Unit test `computeBlacklistSummaryStats` routes PYUSD/USD1 to `otherAddresses`, not `usdtAddresses`
- Verify `BLACKLIST_STABLECOINS` type change propagates without type errors (`npm run build`)
- Integration: deploy to staging, verify new configs appear in sync state, verify API returns new stablecoin filter options
