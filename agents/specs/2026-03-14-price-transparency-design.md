# Price Transparency — Design Spec

**Date:** 2026-03-14
**Status:** Approved

## Goal

Surface per-coin price source provenance on the coverage page and stablecoin detail page, using data the pipeline already produces. No consensus algorithm changes, no new tables, no new crons.

## Scope

Two frontend features plus one small pipeline addition:

1. **Pipeline:** Persist `consensusSources: string[]` per coin during sync
2. **Coverage page:** Enrich "Price & Depeg" column with source count and tooltip
3. **Detail page:** New `PriceTransparencyCard` component

---

## 1. Pipeline Change — Persist Source Candidates

### What changes

During `fetchPrimaryPrices()` in `enrich-prices.ts`, after consensus runs, stamp a new field `consensusSources: string[]` on each asset — the list of source names that returned a valid price for that coin during this sync cycle. Names only, not prices.

The field is named `consensusSources` (not `priceSources`) to avoid semantic collision with the existing `DexLiquidityData.priceSources` field which is an array of `{ protocol, chain, price, tvl }` objects.

### Data flow

- `PrimaryPriceResult` gets a new `candidateSources: string[]` field
- `stampPriceMetadata()` in `sync-stablecoins/shared.ts` copies it onto the `PeggedAsset` as `consensusSources`
- Lands in `/api/stablecoins` and `/api/peg-summary` responses as `consensusSources: string[]`
- New field in `StablecoinDataRawSchema` (`shared/types/market.ts`): `consensusSources: z.array(z.string()).optional()` with transform default `[]`
- New field in `PegSummaryCoin` type: `consensusSources?: string[]`

### Backward compatibility

The field must be `.optional()` in all schemas with a default of `[]`. Pre-migration cache payloads without the field must still pass `StablecoinListResponseSchema` validation (the fail-closed schema guard in `syncStablecoins()`).

### Semantics

- Only sources that returned a valid price for this specific coin are included
- Sources queried but returning nothing are excluded
- The winning source from `priceSource` is always present in the list

### Enrichment-pass sources

Assets that miss the primary consensus pass go through `enrichMissingPrices()`. Each enrichment pass that resolves a price sets `priceSource` on the asset directly. When a price is resolved:
- `applyResolvedPrice()` already sets `priceSource` — it will also set `consensusSources: [source]` (single-element array since enrichment is a fallback, not multi-source consensus)
- This ensures no asset has an empty `consensusSources` after sync completes

### Protocol-redeem overrides

When `fetchAuthoritativeLivePriceOverrides()` replaces a market-derived price, the override sets `consensusSources: ["protocol-redeem"]`, replacing the primary consensus sources. This is correct — the protocol quote is authoritative and the market sources were superseded.

### Type changes

| Location | Change |
|----------|--------|
| `PeggedAsset` interface (`enrich-prices.ts`) | Add `consensusSources?: string[]` |
| `PrimaryPriceResult` interface (`enrich-prices.ts`) | Add `candidateSources: string[]` |
| `StablecoinDataRawSchema` (`shared/types/market.ts`) | Add `consensusSources: z.array(z.string()).optional()` |
| `StablecoinDataSchema` transform | Map `consensusSources: asset.consensusSources ?? []` |
| `PegSummaryCoinSchema` (`shared/types/market.ts`) | Add `consensusSources: z.array(z.string()).optional()` |
| `stampPriceMetadata()` (`sync-stablecoins/shared.ts`) | Accept and stamp `consensusSources` |
| `applyResolvedPrice()` (`enrich-prices.ts`) | Set `consensusSources: [source]` |

### Files modified

- `worker/src/cron/enrich-prices.ts` — collect candidate source names during consensus; `applyResolvedPrice()` sets single-element `consensusSources`
- `worker/src/cron/sync-stablecoins/shared.ts` — `stampPriceMetadata()` accepts and stamps `consensusSources`
- `worker/src/cron/sync-stablecoins.ts` — pass candidate sources through; protocol-redeem override sets `consensusSources: ["protocol-redeem"]`
- `shared/types/market.ts` — add `consensusSources` to `StablecoinDataRawSchema`, transform, and `PegSummaryCoinSchema`
- `worker/src/api/peg-summary.ts` — include `consensusSources` in response

---

## 2. Coverage Page — Enriched "Price & Depeg" Column

### Badge changes

- **"Tracked"** label gains source count: `"Tracked (5 sources)"` or `"Tracked (5)"` if compact
- **Tooltip** expands to include confidence level and source names: "High confidence — CoinGecko, DefiLlama, Pyth, Binance, Curve on-chain"
- **"Price only"** (NAV tokens) and **"Missing"** unchanged
- **Tone colors unchanged** — emerald for Tracked stays regardless of source count

### CoverageStatus changes

The `CoverageStatus` type gains an optional `sourceCount?: number` field. The `CoverageBadge` component reads this to append the count to the label. This keeps the `label` field clean and lets the badge decide formatting.

### resolvePriceCoverage() signature

```typescript
export function resolvePriceCoverage(
  coin: StablecoinMeta,
  hasPegCoverage: boolean,
  consensusSources?: string[],   // NEW
  priceConfidence?: string,       // NEW
): CoverageStatus
```

`BuildCoverageRowInput` gains `consensusSources?: string[]` and `priceConfidence?: string` fields, plumbed from the peg-summary data via `use-coverage-matrix-model.ts`.

### Feature snapshot breakdown

The "Price & Depeg" summary row adds a source-count sub-breakdown that **augments** (not replaces) the existing `tracked / price-only` breakdown. The existing `buildCoverageBreakdown()` continues to use `kind` for the primary breakdown. A secondary line below it shows source-depth distribution: `5+ sources: 42 · 3-4: 68 · 1-2: 40`. This is rendered as additional text in the feature snapshot, not as a change to the `kind`-based breakdown mechanism.

### Mobile cards

Same treatment — badge shows count, expand reveals full source list in tooltip.

### Files modified

- `src/lib/coverage.ts` — `resolvePriceCoverage()` extended signature; `CoverageStatus` gets `sourceCount`; `BuildCoverageRowInput` gains new fields
- `src/app/coverage/client.tsx` — badge rendering for source count; feature snapshot secondary breakdown
- `src/hooks/use-coverage-matrix-model.ts` — pass peg-summary `consensusSources` and `priceConfidence` into `buildCoverageRow()`

---

## 3. Stablecoin Detail Page — Price Transparency Card

### Component

New `PriceTransparencyCard` in `src/components/stablecoin-detail/price-transparency-card.tsx`.

### Placement

After `KeyInfoCard`, before `YieldDetailSection` in `src/app/stablecoin/[id]/client.tsx`. Add a new entry to `DETAIL_SECTIONS` for scrollspy navigation (id: `"price-transparency"`, label: `"Price Sources"`).

### Layout

```
┌──────────────────────────────────────────────┐
│  Price Transparency                          │
│                                              │
│  Current price: $0.9996                      │
│  Source: CoinGecko + DefiLlama               │
│  Confidence: High           Updated: 2m ago  │
│                                              │
│  ┌──────────────────────────────────────────┐│
│  │ Source           │ Status                ││
│  │ CoinGecko       │ ● Used                ││
│  │ DefiLlama       │ ● Used                ││
│  │ Pyth Network    │ ● Available            ││
│  │ Binance         │ ● Available            ││
│  │ Coinbase        │ ○ No data              ││
│  │ RedStone        │ ○ No data              ││
│  │ Curve on-chain  │ ○ No data              ││
│  │ DEX prices      │ ○ No data              ││
│  └──────────────────────────────────────────┘│
│                                              │
│  DEX Price Check                             │
│  DEX price: $0.9998 · Agrees · 4 pools      │
│  · $2.4M TVL · 1.2 bps deviation            │
│                                              │
└──────────────────────────────────────────────┘
```

### Status semantics

- **"Used"** (green dot) — the `priceSource` winner. "coingecko+defillama" maps to both CoinGecko and DefiLlama as Used.
- **"Available"** (blue/sky dot) — in `consensusSources` but not the winner
- **"No data"** (gray dot) — not in `consensusSources`
- When `priceSource === "protocol-redeem"`, show "Protocol Redemption" as Used, all others as "Not applicable" (the protocol quote superseded market sources)

### Source list

Hardcoded known sources in display order: CoinGecko, DefiLlama, Pyth Network, Binance, Coinbase, RedStone, Curve on-chain, DEX prices. Compare against `consensusSources` array to determine status per source.

### Confidence badge

Color-coded: green for "high", amber for "single-source", red for "low", gray for "fallback".

### DEX Price Check section

Renders only when `dexPriceCheck` data exists in peg-summary. Shows DEX price, agreement status (agrees/disagrees badge), pool count, TVL, deviation in bps. No pipeline change — data already exists.

### Conditional rendering

Card hidden when `coinData.price == null`. For coins with no price data at all, nothing renders.

### Data sources (no new API calls)

- `coinData.price`, `coinData.priceSource`, `coinData.priceConfidence`, `coinData.priceUpdatedAt` from `useStablecoins()`
- `pegSummaryCoin.consensusSources` from `usePegSummary()`
- `pegSummaryCoin.dexPriceCheck` from `usePegSummary()`

### Files modified

- `src/components/stablecoin-detail/price-transparency-card.tsx` — new component
- `src/app/stablecoin/[id]/client.tsx` — add card to section list + `DETAIL_SECTIONS` entry
- `src/hooks/use-stablecoin-detail-view-model.ts` — expose `consensusSources` and `dexPriceCheck`
- `src/lib/stablecoin-detail-view-model.ts` — add `consensusSources` and `dexPriceCheck` to `StablecoinDetailReadyViewModel` interface and `buildStablecoinDetailViewModel()` builder

---

## Testing

- Unit tests for `resolvePriceCoverage()` with source count variations
- Unit test for `stampPriceMetadata()` passing `consensusSources` through
- Existing `enrich-prices.test.ts` and `sync-stablecoins.test.ts` updated for new field
- Build + type-check + lint pass

## Documentation updates

- `docs/stablecoin-detail-page.md` — new section in composition list
- `docs/coverage-page.md` — updated "Price & Depeg" column description
- `docs/data-pipeline.md` — mention `consensusSources` field
- `docs/api-reference.md` — add `consensusSources` to response schemas
- `docs/data-flow-map.md` — note `consensusSources` in stablecoins flow
