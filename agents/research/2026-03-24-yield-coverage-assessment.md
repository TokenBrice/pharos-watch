# Yield Coverage Assessment

Date: 2026-03-24
Scope: Overall Yield feature coverage on the coverage matrix, native yield-bearing coverage, and realistic next-step expansion paths that preserve current methodology quality.

## Snapshot

- Active tracked stablecoins: 161
- Active Yield feature coverage: 94
- Active uncovered on Yield feature: 67
- Active yield-bearing stablecoins: 44
- Active yield-bearing coins with live Yield coverage: 43
- Missing active yield-bearing coverage: `usbd-bima`
- Live `/api/yield-rankings` rows observed: 95 total, which includes one inactive/non-coverage-row delta relative to the coverage page

## What The Numbers Mean

The Yield feature is effectively two products under one coverage tile:

1. Native yield-bearing stablecoin coverage
2. Curated lending-opportunity coverage for selected non-yield-bearing coins

Those behave very differently.

### Native Yield-Bearing Coverage

This part is already close to saturated:

- 43 / 44 active yield-bearing coins covered
- 97.7% native yield-bearing coverage

The one remaining gap is `usbd-bima`.

### Total Coverage Tile

The tile sits at 94 / 161 because the remaining uncovered set is mostly:

- plain fiat-backed stablecoins with no credible native yield surface
- assets without a protocol-native or high-confidence lending market
- assets where available lending pools would require ambiguous symbol matching or methodology stretch

So the tile under-rates how complete the native Yield Intelligence product already is.

## Current Constraints

The existing pipeline is already fairly permissive where it is safe to be:

- multi-source DeFiLlama matching
- wrapper preservation for non-`stablecoin` upstream pools
- price-derived fallbacks for selected NAV assets
- rate-derived Treasury proxies
- curated auto-lending discovery down to `$100k` TVL and `0.10%` APY
- explicit deterministic overrides for edge-case lending markets

I checked the remaining uncovered surface against the current allowlist and thresholds. There is no large batch of clean, high-confidence additions still blocked only by configuration.

The small residual candidate set is not attractive:

- `paxg-paxos` / `xaut-tether`: only surfaced through a `multipli.fi` RWA pool (`RWAUSDI`), which is not a clean stablecoin-yield mapping for the underlying gold token
- `dusd-standx` / `dusd-alto`: Pendle exact-symbol matches exist, but the symbol is ambiguous across multiple unrelated assets and would need coin-specific adjudication to avoid false attribution

Those do not look like good “free coverage” wins.

## Biggest Win

The best reasonable-effort win is to close `usbd-bima` with a protocol-specific deterministic source.

Why this is the best target:

- It is the only remaining uncovered active coin that is explicitly marked yield-bearing in tracked metadata.
- BIMA’s official docs explicitly describe `sUSBD` as the yield-bearing path for USBD holders.
- DeFiLlama Yields does not currently expose a usable `USBD` / `sUSBD` pool, so waiting for upstream discovery will not reliably solve it.
- Adding a deterministic adapter keeps methodology quality high instead of broadening the feature with weaker lending-opportunity matches.
- It would take native yield-bearing coverage from 43 / 44 to 44 / 44 and move the Yield tile from 94 to 95 active covered coins.

## Why Not “Add More Sources” Broadly

At this point, a generic new source family is more likely to create noisy or overstated coverage than meaningful clean gains.

Broad source expansion would likely force one or more compromises:

- weaker symbol matching
- looser pool-shape requirements
- lower confidence on whether the yield belongs to the tracked asset versus a wrapper or unrelated market
- more non-native “lending opportunity” rows that blur the feature’s meaning

That would increase the count, but it would reduce trust.

## Recommended Order

1. Add `usbd-bima` deterministic coverage first.
2. Only after that, review a very short list of explicit per-coin overrides where attribution is exact and protocol-native.
3. Do not introduce a broad new yield source family unless it can preserve current confidence standards.

## Source Notes

- Live Pharos APIs checked on 2026-03-24:
  - `https://api.pharos.watch/api/yield-rankings`
  - `https://api.pharos.watch/api/report-cards`
- Upstream DeFiLlama Yields checked on 2026-03-24:
  - `https://yields.llama.fi/pools`
- BIMA docs checked on 2026-03-24:
  - `https://docs.bima.money/`
  - `https://docs.bima.money/yield-with-usbd-+-susbd`
  - `https://docs.bima.money/security/mainnet-addresses`
