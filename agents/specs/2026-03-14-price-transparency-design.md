# Price Transparency — Design Spec

**Date:** 2026-03-14
**Status:** Approved

## Goal

Surface per-coin price source provenance on the coverage page and stablecoin detail page, using data the pipeline already produces. No consensus algorithm changes, no new tables, no new crons.

## Scope

Two frontend features plus one small pipeline addition:

1. **Pipeline:** Persist `priceSources: string[]` per coin during sync
2. **Coverage page:** Enrich "Price & Depeg" column with source count and tooltip
3. **Detail page:** New `PriceTransparencyCard` component

---

## 1. Pipeline Change — Persist Source Candidates

### What changes

During `fetchPrimaryPrices()` in `enrich-prices.ts`, after consensus runs, stamp a new field `priceSources: string[]` on each asset — the list of source names that returned a valid price for that coin during this sync cycle. Names only, not prices.

### Data flow

- `PrimaryPriceResult` gets a new `candidateSources: string[]` field
- `stampPriceMetadata()` in `sync-stablecoins/shared.ts` copies it onto the `PeggedAsset`
- Lands in `/api/stablecoins` and `/api/peg-summary` responses as `priceSources: string[]`
- New field in `StablecoinData` schema (`shared/types/market.ts`): `priceSources` (string array, optional, defaults to empty)
- New field in `PegSummaryCoin` type: `priceSources` (string array, optional)

### Semantics

- Only sources that returned a valid price for this specific coin are included
- Sources queried but returning nothing are excluded
- The winning source from `priceSource` is always present in the list
- Enrichment-pass sources (defillama-contract, coinmarketcap, dexscreener) are included when they resolve a price

### Files modified

- `worker/src/cron/enrich-prices.ts` — collect candidate source names during consensus
- `worker/src/cron/sync-stablecoins/shared.ts` — `stampPriceMetadata()` accepts and stamps `priceSources`
- `worker/src/cron/sync-stablecoins.ts` — pass candidate sources through
- `shared/types/market.ts` — add `priceSources` to `StablecoinDataSchema` and `PegSummaryCoin`
- `worker/src/api/peg-summary.ts` — include `priceSources` in response

---

## 2. Coverage Page — Enriched "Price & Depeg" Column

### Badge changes

- **"Tracked"** label gains source count: `"Tracked (5 sources)"` or `"Tracked (5)"` if compact
- **Tooltip** expands to include confidence level and source names: "High confidence — CoinGecko, DefiLlama, Pyth, Binance, Curve on-chain"
- **"Price only"** (NAV tokens) and **"Missing"** unchanged
- **Tone colors unchanged** — emerald for Tracked stays regardless of source count

### Feature snapshot breakdown

The "Price & Depeg" summary row adds a sub-breakdown mirroring existing patterns:
- `5+ sources: 42 · 3-4 sources: 68 · 1-2 sources: 40`

### Mobile cards

Same treatment — badge shows count, expand reveals full source list.

### Files modified

- `src/lib/coverage.ts` — `resolvePriceCoverage()` reads `priceSources` and `priceConfidence`
- `src/app/coverage/client.tsx` — tooltip rendering for enriched Price & Depeg badges
- `src/hooks/use-coverage-matrix-model.ts` — pass peg-summary `priceSources` into `buildCoverageRow()`

---

## 3. Stablecoin Detail Page — Price Transparency Card

### Component

New `PriceTransparencyCard` in `src/components/stablecoin-detail/price-transparency-card.tsx`.

### Placement

After `KeyInfoCard`, before `YieldDetailSection` in `src/app/stablecoin/[id]/client.tsx`.

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
- **"Available"** (blue/sky dot) — in `priceSources` but not the winner
- **"No data"** (gray dot) — not in `priceSources`
- **"Protocol"** — special label when `priceSource === "protocol-redeem"`, shown as Used

### Source list

Hardcoded known sources in display order: CoinGecko, DefiLlama, Pyth Network, Binance, Coinbase, RedStone, Curve on-chain, DEX prices. Compare against `priceSources` array to determine status per source.

### Confidence badge

Color-coded: green for "high", amber for "single-source", red for "low", gray for "fallback".

### DEX Price Check section

Renders only when `dexPriceCheck` data exists in peg-summary. Shows DEX price, agreement status (agrees/disagrees badge), pool count, TVL, deviation in bps. No pipeline change — data already exists.

### Conditional rendering

Card hidden when `coinData.price == null`. For coins with no price data at all, nothing renders.

### Data sources (no new API calls)

- `coinData.price`, `coinData.priceSource`, `coinData.priceConfidence`, `coinData.priceUpdatedAt` from `useStablecoins()`
- `pegSummaryCoin.priceSources` from `usePegSummary()`
- `pegSummaryCoin.dexPriceCheck` from `usePegSummary()`

### Files modified

- `src/components/stablecoin-detail/price-transparency-card.tsx` — new component
- `src/app/stablecoin/[id]/client.tsx` — add card to section list
- `src/hooks/use-stablecoin-detail-view-model.ts` — expose `priceSources` and `dexPriceCheck`
- `docs/stablecoin-detail-page.md` — add section to contract

---

## Testing

- Unit tests for `resolvePriceCoverage()` with source count variations
- Unit test for `stampPriceMetadata()` passing `priceSources` through
- Existing `enrich-prices.test.ts` and `sync-stablecoins.test.ts` updated for new field
- Build + type-check + lint pass

## Documentation updates

- `docs/stablecoin-detail-page.md` — new section in composition list
- `docs/coverage-page.md` — updated "Price & Depeg" column description
- `docs/data-pipeline.md` — mention `priceSources` field
- `docs/api-reference.md` — add `priceSources` to response schemas
