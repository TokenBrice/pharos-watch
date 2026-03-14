# Curve Metapool Support, Two-Hop Pricing, and Display Fix

**Date:** 2026-03-14
**Status:** Approved

## Problem

1. **Missing metapool support**: Stablecoins with Curve liquidity via 3Crv metapools (LUSD, MIM, etc.) have no Curve on-chain price because `curve-onchain.ts` only supports `get_dy()`, not `get_dy_underlying()`.
2. **Missing two-hop support**: Stablecoins paired with crvUSD (GHO, frxUSD) have no Curve on-chain price because pricing them requires chaining two `get_dy` calls.
3. **Display bug**: The Price Transparency card never shows "Used" (green) for Curve or most other sources. `buildSourceLabel()` in `price-consensus.ts` produces condensed labels like `"binance+6more"`. The frontend's `resolveSourceStatus` splits on `"+"` producing `["binance", "6more"]` and checks `winners.includes(sourceKey)` -- only `"binance"` matches; `"6more"` is not a valid source key, so all other sources fall through to "Available".

## Solution Overview

Three changes:
- Extend `CurvePoolConfig` with `useUnderlying` and `hop` fields
- Transmit `agreeSources` (from `consensus.agreeSources`) as a new field alongside existing `consensusSources` to fix the display bug
- Add pool configs for metapool and two-hop stablecoins

## 1. CurvePoolConfig Type Extension

Add two optional fields to the existing interface in `worker/src/lib/curve-onchain.ts`:

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

**`useUnderlying`**: Switches the RPC call from `get_dy` (selector `0x5e0d443f`) to `get_dy_underlying` (selector `0x07211ef7`). Encoding, decoding, and price math are identical.

Selector verification: `get_dy_underlying(int128,int128,uint256)` -- Keccak-256 of this signature yields `0x07211ef7`. Verify at 4byte.directory or Etherscan before implementation.

For 3Crv-based metapools, the `get_dy_underlying` indices differ from 3pool's `get_dy` indices because the metapool token occupies index 0:
- 0 = metapool token (e.g., LUSD, 18 decimals)
- 1 = DAI (18 decimals)
- 2 = USDC (6 decimals)
- 3 = USDT (6 decimals)

This is distinct from 3pool's own `get_dy` indices (0=DAI, 1=USDC, 2=USDT).

**`hop`**: Marks the raw implied price as denominated in an intermediate token rather than USD. After all RPC calls complete, a second pass multiplies by the intermediate token's resolved USD price.

**Implementation note**: Not all Curve metapool contracts expose `get_dy_underlying` -- some newer factory pools may only have `exchange_underlying`. Verify each pool has the view function before adding to configs.

## 2. fetchCurveOnchainPrices Logic Changes

Two-phase processing with explicit separation:

**Phase 1 (RPC calls):** Loop over ALL configs (non-hop and hop alike). Select the RPC function selector based on `config.useUnderlying`. Execute `fetchEvmCallHexAtBlock`, compute `impliedPrice = inputFloat / outputFloat`, store in `rawPrices` map. This phase does NOT write to the final `results` map.

**Phase 2 (Resolve and output):** Iterate configs again:
- Non-hop configs: copy raw price directly to `results` (subject to `(0, 100)` sanity check)
- Hop configs: multiply `rawPrices.get(stablecoinId) * rawPrices.get(hop.viaStablecoinId)`, write to `results` (subject to `(0, 100)` sanity check). If either raw price is missing (RPC failed), skip the coin.

This two-pass structure makes ordering within the config array irrelevant -- all RPC calls complete before any hop resolution happens.

**Constraints:**
- No chained hops (hop referencing another hop). Enforced by a startup validation that throws if any `hop.viaStablecoinId` matches a config that also has `hop`.
- Final price must pass the existing `(0, 100)` sanity check.

## 3. Display Bug Fix: agreeSources Pipeline

### Root Cause

`computePriceConsensus()` in `worker/src/lib/price-consensus.ts` returns a `ConsensusResult` containing `agreeSources: string[]` (the sources in the winning consensus cluster). However, `fetchPrimaryPrices()` in `enrich-prices.ts` only extracts `candidateSources: sources.map(s => s.source)` (ALL sources that returned a price). This `candidateSources` array is passed through `stampPriceMetadata` and stored as `asset.consensusSources`.

So currently:
- `asset.consensusSources` = all sources that returned any price (the candidate set)
- `consensus.agreeSources` = sources that agreed within threshold (the winning cluster)
- The winning cluster info is lost -- never transmitted to the frontend

The frontend then tries to reconstruct "which sources were used" by parsing the condensed `priceSource` label, which fails because `buildSourceLabel` produces `"binance+6more"` and splitting on `"+"` yields `["binance", "6more"]`.

### Fix

Add `agreeSources` as a NEW field alongside the existing `consensusSources`. Naming convention:
- `consensusSources` = all sources that returned a price (existing meaning, unchanged)
- `agreeSources` = sources in the winning consensus cluster (new)

### Changes Required

1. **`PrimaryPriceResult`** in `enrich-prices.ts`: Add `agreeSources: string[]` as a NEW field alongside existing `candidateSources`. Populated from `consensus.agreeSources`.

2. **`PeggedAsset`** in `enrich-prices.ts`: Add `agreeSources?: string[]` field.

3. **`StablecoinDataRawSchema`** in `shared/types/market.ts`: Add `agreeSources: z.array(z.string()).optional()` to the Zod schema.

4. **`StablecoinDataSchema` transform** in `shared/types/market.ts`: Add `agreeSources: asset.agreeSources ?? []` to the transform output object. Without this, the field is silently stripped during `validatePayloadWithSchema()` and never persisted to cache.

5. **`stampPriceMetadata`** in `sync-stablecoins/shared.ts`: Add `agreeSources?: string[]` as the 6th optional parameter (after existing `consensusSources?`). Stamp onto asset when provided. Signature becomes: `stampPriceMetadata(asset, source, confidence, updatedAt, consensusSources?, agreeSources?)`.

6. **`sync-stablecoins.ts` call sites**: At the primary consensus path (line ~570), pass `primary.agreeSources` as the 6th arg. At protocol/authoritative override paths, pass the single-element source array. At degraded paths (pre-rejection at line ~229, enrichment tagging at line ~242/640, cached fallback at line ~701) that currently pass only 4 args, leave `agreeSources` undefined — these represent fallback states where the agree/disagree distinction is not meaningful. The frontend handles `undefined` gracefully via `agreeSources ?? []`.

7. **`PegSummaryCoinSchema`** in `shared/types/market.ts`: Add `agreeSources: z.array(z.string()).optional()` to the Zod schema.

8. **`peg-summary.ts`**: Add `agreeSources: asset?.agreeSources` to the `coins` object literal (alongside existing `consensusSources: asset?.consensusSources` at line ~215). The `asset` object comes from the stablecoins cache which persists `agreeSources` via the Zod transform (items 3-4).

9. **`buildStablecoinDetailViewModel`** in `src/lib/stablecoin-detail-view-model.ts`: Extract `agreeSources` from `pegScoreResult` (same pattern as existing `consensusSources` extraction at line 205). Add to `StablecoinDetailReadyViewModel` interface.

10. **`PriceTransparencyCard`** in `src/components/stablecoin-detail/price-transparency-card.tsx`:
    - Add `agreeSources: string[]` to `PriceTransparencyCardProps`.
    - Update `resolveSourceStatus`: replace `priceSource` parsing with:
      - `agreeSources.includes(key)` -> "used"
      - `consensusSources.includes(key)` -> "available"
      - else -> "no-data"

**Note**: The coverage page (`src/lib/coverage.ts`) uses `consensusSources` for source count display. Its semantics are unchanged (all sources that returned data), so no coverage page changes are needed.

## 4. Extended Pool Configs

### Existing Configs (6, unchanged)

USDT, DAI, crvUSD, PYUSD, FRAX, USDe -- all direct `get_dy` pools on Ethereum.

### New Metapool Configs (useUnderlying: true)

For 3Crv metapools: query USDC(underlying index 2) -> target(underlying index 0).

| Stablecoin | Pool Address | TVL (approx) | Output Decimals |
|---|---|---|---|
| lusd-liquity | `0xEd279fDD11cA84bEef15AF5D39BB4d4bEE23F0cA` | ~$5M | 18 |
| mim-abracadabra | `0x5a6A4D54456819380173272A5E8E9B9904BdF41B` | ~$2M | 18 |

Additional 3Crv metapool candidates (TUSD, GUSD, aLUSD, DOLA, sUSD) need TVL and `get_dy_underlying` availability verification during implementation. Only add pools above $1M TVL that expose the view function.

### New Two-Hop Configs (hop via crvUSD)

| Stablecoin | Pool | Hop Via | Notes |
|---|---|---|---|
| gho-aave | GHO/crvUSD pool | crvusd-curve | Address + TVL + `get_dy_underlying` verification needed |
| frxusd-frax | frxUSD/crvUSD pool | crvusd-curve | Address + TVL verification needed |

### crvUSD Special Case

crvUSD is configured as a direct pool AND gets overridden by `protocol-redeem` in the sync pipeline. The Curve RPC call still executes (so hop dependencies resolve from `rawPrices` in phase 1), but crvUSD's own `consensusSources` shows `["protocol-redeem"]` due to the override. This is correct behavior -- the hop resolution reads from the RPC result map, not the final asset consensus.

## 5. Testing

### Unit Tests (curve-onchain.test.ts)

- **`useUnderlying` selector**: Mock RPC, verify the call uses `0x07211ef7` instead of `0x5e0d443f` when `useUnderlying: true`
- **Hop resolution**: Two configs (crvUSD non-hop at $0.999 + GHO hop via crvUSD), verify GHO price = rawGhoImplied * crvUSD price
- **Missing hop dependency**: via-token RPC fails, verify hop coin excluded from results (not NaN/zero)
- **Hop-references-hop guard**: config with hop referencing another hop config throws at validation

### Unit Tests (pipeline)

- `enrich-prices.test.ts`: verify `agreeSources` populated on `PrimaryPriceResult` from `consensus.agreeSources`
- `sync-stablecoins.test.ts`: verify `stampPriceMetadata` stores `agreeSources` on asset

### Integration Verification

- Build + type-check: `npm run build && cd worker && npx tsc --noEmit`
- All existing tests green: `npm test`
- Manual spot-check on staging: USDT shows Curve as "Used" (green), LUSD shows "Available" (blue)

## Files Modified

| File | Change |
|---|---|
| `worker/src/lib/curve-onchain.ts` | Add `GET_DY_UNDERLYING_SELECTOR`, `useUnderlying`/`hop` to `CurvePoolConfig`, two-phase processing, hop resolution, hop validation |
| `worker/src/lib/curve-pool-configs.ts` | Add metapool and two-hop configs |
| `worker/src/lib/__tests__/curve-onchain.test.ts` | Tests for underlying selector, hop resolution, missing dep, chained hop guard |
| `worker/src/cron/enrich-prices.ts` | Add `agreeSources` to `PrimaryPriceResult` and `PeggedAsset`, populate from `consensus.agreeSources` |
| `worker/src/cron/sync-stablecoins/shared.ts` | `stampPriceMetadata` accepts + stamps `agreeSources` |
| `worker/src/cron/sync-stablecoins.ts` | Pass `agreeSources` at all `stampPriceMetadata` call sites |
| `worker/src/api/peg-summary.ts` | Serve `agreeSources` field |
| `shared/types/market.ts` | Add `agreeSources` to `StablecoinDataRawSchema`, `StablecoinDataSchema` transform, and `PegSummaryCoinSchema` |
| `src/components/stablecoin-detail/price-transparency-card.tsx` | Add `agreeSources` prop, update `resolveSourceStatus` to use it |
| `src/lib/stablecoin-detail-view-model.ts` | Extract `agreeSources` from `pegScoreResult`, add to view model interface and builder output |
