# USR Resolv Price Investigation - 2026-04-15

## Assumptions

- USR can be severely depegged and still should publish a market price when independent feeds report it.
- The fix should preserve the existing severe-downside guardrail for genuinely single-source prices.

## Success Criteria

- Identify why `usr-resolv` has supply but no price in the live `/api/stablecoins` cache.
- Confirm whether the registry metadata is correct.
- Patch only the root cause if it is in the repo.
- Add a regression test that covers the USR-like failure mode.

## Findings

- Live Pharos `/stablecoins` and `/stablecoin-summary/usr-resolv` have supply and chain data, but `price` is `null` / `priceSource="missing"`.
- DefiLlama stablecoin list still returns USR id `197` with supply and price around `$0.154`.
- CoinGecko simple price for `resolv-usr`, DefiLlama `coingecko:resolv-usr`, tracked contract lookups, Pyth, and GeckoTerminal all returned fresh prices around `$0.15` at `2026-04-15T14:41Z`.
- The `coingecko-id-verif` checker reports `OUR_CORRECT` for `usr-resolv`: our `geckoId` is `resolv-usr`, matching DefiLlama and CoinGecko contract resolution.
- Production `price_cache` has a recent USR row from `2026-04-15T13:15:47Z` at `$0.153996`, with `source="coingecko+defillama-list"` and `consensus_sources_json=["coingecko","defillama-list","pyth"]`.

## Root Cause

Primary pricing can accept a severe downside price when the selected source is low confidence but at least two candidate source prices independently confirm severe downside. The accepted evidence is stored in the primary result's `allPrices`.

Later validation passes re-run publication validation using only the selected asset price/source/confidence and lose `allPrices`. That turns an accepted multi-feed severe depeg into an apparent single-source severe downside, so the price is cleared before cache write.

## Plan

- Thread primary candidate-price evidence through the later prevalidation and post-enrichment validation stages.
- Use that evidence only when the current asset price/source still matches the primary result, so stale or rejected primary candidates cannot bless unrelated fallback prices.
- Add regression coverage for a low-confidence Pyth-selected severe depeg corroborated by CoinGecko and DefiLlama candidate prices.
