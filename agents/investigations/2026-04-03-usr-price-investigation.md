# USR Price Investigation — 2026-04-03

## Question

Why did the stablecoin detail page show `USR` price as `N/A` while some external sources appeared to show a live price?

## Repo findings

- The stablecoin detail page hero does **not** use `/api/stablecoin/:id` for the hero price.
- It hydrates from the shared `/api/stablecoins` list cache via `useStablecoins()` and `buildStablecoinDetailViewModel()`.
- The list cache applies publication policy guards before a price is allowed onto the canonical payload.
- The per-coin detail endpoint is a separate raw-upstream detail surface and can disagree with the canonical list cache.

## Key code references

- `src/hooks/use-stablecoin-detail-view-model.ts`
- `src/lib/stablecoin-detail-view-model.ts`
- `worker/src/lib/price-publish-policy.ts`
- `worker/src/api/stablecoin-summary.ts`
- `worker/src/api/stablecoin-detail.ts`
- `shared/lib/pricing-pipeline-version.ts`

## Verified live API behavior during investigation

Initial fetch:

- `/api/stablecoins` returned `usr-resolv` with `price: null`, `priceSource: "missing"`.
- `/api/stablecoin/usr-resolv` returned raw DefiLlama detail data with `price: 0.10842420829615443`, `priceSource: "defillama"`.

Subsequent live fetches a few minutes later:

- `/api/stablecoins` returned `price: 0.9992983305`, `priceSource: "pool-tvl-weighted"`, `priceConfidence: "low"`.
- `/api/stablecoin-summary/usr-resolv` matched the canonical cache and returned the same `0.9992983305`.
- `/api/peg-summary` still exposed `price: null` for `usr-resolv` but showed `dexPriceCheck.dexPrice: 0.999298` and `agreeSources: ["pool-tvl-weighted"]`.

This indicates a transient cache/state transition rather than a permanent frontend rendering bug.

## Verified external source snapshots during investigation

All fetched on 2026-04-03 UTC:

- DefiLlama stablecoins list: `0.10842420829615443`
- CoinGecko simple price (`resolv-usr`): `0.521465`
- Pyth Hermes feed (`0x10b013adec14c0fe839ca0fe54cec9e4d0b6c1585ac6d7e70010dac015e57f9c`): `0.53719586`
- DexScreener pools for the canonical Ethereum token address were mostly around `0.49` to `0.62`

Conclusion: the investigation did **not** confirm a trustworthy multi-source cluster near `$0.09`.

## Root-cause summary

The `N/A` state came from the canonical `/api/stablecoins` cache, not from the UI inventing a blank value. That cache can intentionally clear a fixed-peg price when publication policy rejects it, especially for severe downside or weak-source temporal-jump cases. The raw `/api/stablecoin/:id` detail endpoint bypasses that canonical publish step and can still show the upstream DefiLlama detail quote.

## Most likely explanation for the screenshot

At the time of the screenshot, `usr-resolv` was in a transient state where:

- the canonical list cache had cleared the price or had not yet republished a replacement mark, and
- the separate raw detail endpoint still exposed the upstream DefiLlama quote.

Later on the same day, the canonical cache republished `USR` at `0.9992983305` from `pool-tvl-weighted` with low confidence.
