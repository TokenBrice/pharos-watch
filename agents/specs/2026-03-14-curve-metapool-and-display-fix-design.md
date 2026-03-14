# Curve Metapool Support, Two-Hop Pricing, and Display Fix

**Date:** 2026-03-14
**Status:** Approved

## Problem

1. **Missing metapool support**: Stablecoins with Curve liquidity via 3Crv metapools (LUSD, MIM, etc.) have no Curve on-chain price because `curve-onchain.ts` only supports `get_dy()`, not `get_dy_underlying()`.
2. **Missing two-hop support**: Stablecoins paired with crvUSD (GHO, frxUSD) have no Curve on-chain price because pricing them requires chaining two `get_dy` calls.
3. **Display bug**: The Price Transparency card never shows "Used" (green) for Curve or most other sources. The frontend parses condensed `priceSource` labels like `"binance+6more"` to determine status, but only the first alphabetical source matches.

## Solution Overview

Three changes:
- Extend `CurvePoolConfig` with `useUnderlying` and `hop` fields
- Transmit `agreeSources` separately from `consensusSources` to fix the display bug
- Add pool configs for metapool and two-hop stablecoins

## 1. CurvePoolConfig Type Extension

Add two optional fields to the existing interface:

```ts
export interface CurvePoolConfig {
  stablecoinId: string;
  poolAddress: string;
  inputIndex: number;
  outputIndex: number;
  inputDecimals: number;
  outputDecimals: number;
  chain: string;
  useUnderlying?: boolean;           // use get_dy_underlying selector
  hop?: { viaStablecoinId: string }; // intermediate token for two-hop pricing
}
```

**`useUnderlying`**: Switches the RPC call from `get_dy` (selector `0x5e0d443f`) to `get_dy_underlying` (selector `0x07211ef7`). Encoding, decoding, and price math are identical. For 3Crv-based metapools, underlying indices are: 0=metapool token, 1=DAI(18), 2=USDC(6), 3=USDT(6).

**`hop`**: Marks the raw implied price as denominated in an intermediate token rather than USD. After all RPC calls complete, a second pass multiplies by the intermediate token's resolved USD price.

## 2. fetchCurveOnchainPrices Logic Changes

Two-phase processing:

**Phase 1 (RPC calls):** The existing loop, with one change: selector chosen based on `config.useUnderlying`. All configs (including hops) execute their RPC calls. Results stored in a `rawPrices` map.

**Phase 2 (Hop resolution):** New post-loop pass. For each config with `hop`, multiply its raw price by `rawPrices.get(hop.viaStablecoinId)`. If the dependency is missing (RPC failed), exclude the hop coin from results.

**Constraints:**
- No chained hops (hop referencing another hop). Enforced by a startup assertion.
- Final price must pass the existing `(0, 100)` sanity check.
- Hop dependencies must be non-hop configs in the same batch.

## 3. Display Bug Fix: agreeSources Pipeline

### Root Cause

`computePriceConsensus()` returns `agreeSources` (sources in the winning cluster) but this is never transmitted to the frontend. The frontend reverse-engineers the condensed `priceSource` label to determine "Used" status, which only works for the first alphabetical source.

### Fix

Transmit `agreeSources` as a separate field alongside `consensusSources`:

| Field | Meaning | Example (USDT) |
|---|---|---|
| `consensusSources` | All sources that returned a price | `["coingecko","defillama","pyth","binance","coinbase","redstone","curve-onchain"]` |
| `agreeSources` | Sources in the winning consensus cluster | `["coingecko","defillama","pyth","binance","coinbase","redstone","curve-onchain"]` |
| `priceSource` | Human-readable label (unchanged) | `"binance+6more"` |

### Changes Required

1. **`PrimaryPriceResult`** in `enrich-prices.ts`: Add `agreeSources: string[]`, populated from `consensus.agreeSources`.

2. **`PeggedAsset`** in `enrich-prices.ts`: Add `agreeSources?: string[]` field.

3. **`stampPriceMetadata`** in `sync-stablecoins/shared.ts`: Accept optional `agreeSources` param, stamp onto asset.

4. **`sync-stablecoins.ts` call sites**: Pass `primary.agreeSources` to `stampPriceMetadata`. For non-consensus paths (enrichment fallbacks, cached fallbacks, protocol overrides), `agreeSources` equals `consensusSources` (single-element arrays).

5. **`peg-summary.ts`**: Serve `agreeSources: asset?.agreeSources`.

6. **`shared/types/market.ts`**: Add `agreeSources?: string[]` to `PegSummaryCoin`.

7. **Frontend `resolveSourceStatus`**: Replace `priceSource` parsing with:
   - `agreeSources.includes(key)` -> "used"
   - `consensusSources.includes(key)` -> "available"
   - else -> "no-data"

## 4. Extended Pool Configs

### New Metapool Configs (useUnderlying: true)

For 3Crv metapools: query USDC(index 2) -> target(index 0).

| Stablecoin | Pool Address | TVL | Output Decimals |
|---|---|---|---|
| lusd-liquity | `0xEd279fDD11cA84bEef15AF5D39BB4d4bEE23F0cA` | ~$5M | 18 |
| mim-abracadabra | `0x5a6A4D54456819380173272A5E8E9B9904BdF41B` | ~$2M | 18 |

Additional 3Crv metapool candidates (TUSD, GUSD, aLUSD, DOLA, sUSD) need TVL verification during implementation. Only add pools above $1M TVL.

### New Two-Hop Configs (hop via crvUSD)

| Stablecoin | Pool | Hop Via | Notes |
|---|---|---|---|
| gho-aave | GHO/crvUSD pool | crvusd-curve | Address + TVL need verification |
| frxusd-frax | frxUSD/crvUSD pool | crvusd-curve | Address + TVL need verification |

### crvUSD Special Case

crvUSD is configured as a direct pool AND gets overridden by `protocol-redeem` in the sync pipeline. The Curve RPC call still executes (so hop dependencies resolve from `rawPrices`), but crvUSD's own `consensusSources` shows `["protocol-redeem"]` due to the override. This is correct behavior.

## 5. Testing

### Unit Tests (curve-onchain.test.ts)

- `useUnderlying` selector: verify RPC call uses `0x07211ef7` when flag is true
- Hop resolution: two configs (crvUSD non-hop + GHO hop), verify GHO price = raw * crvUSD price
- Missing hop dependency: via-token RPC fails, verify hop coin excluded from results
- Hop-references-hop guard: assertion fires when hop references another hop config

### Unit Tests (pipeline)

- `enrich-prices.test.ts`: verify `agreeSources` populated on `PrimaryPriceResult`
- `sync-stablecoins.test.ts`: verify `stampPriceMetadata` stores `agreeSources`

### Integration Verification

- Build + type-check: `npm run build && cd worker && npx tsc --noEmit`
- All existing tests green: `npm test`
- Manual spot-check on staging: USDT shows Curve as "Used" (green), LUSD shows "Available" (blue)

## Files Modified

| File | Change |
|---|---|
| `worker/src/lib/curve-onchain.ts` | Add `GET_DY_UNDERLYING_SELECTOR`, two-phase processing, hop resolution, hop validation |
| `worker/src/lib/curve-pool-configs.ts` | Add metapool and two-hop configs |
| `worker/src/lib/__tests__/curve-onchain.test.ts` | Tests for underlying, hops, edge cases |
| `worker/src/cron/enrich-prices.ts` | Add `agreeSources` to `PrimaryPriceResult` and `PeggedAsset`, populate from consensus |
| `worker/src/cron/sync-stablecoins/shared.ts` | `stampPriceMetadata` accepts `agreeSources` |
| `worker/src/cron/sync-stablecoins.ts` | Pass `agreeSources` at all call sites |
| `worker/src/api/peg-summary.ts` | Serve `agreeSources` |
| `shared/types/market.ts` | Add `agreeSources` to `PegSummaryCoin` |
| `src/components/stablecoin-detail/price-transparency-card.tsx` | Use `agreeSources` for "Used" status |
| `src/lib/stablecoin-detail-view-model.ts` | Plumb `agreeSources` to component |
| `src/hooks/use-stablecoin-detail-view-model.ts` | Extract `agreeSources` from API response |
