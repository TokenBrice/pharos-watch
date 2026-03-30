# DefiLlama Supply Gap Audit

Date: 2026-03-30

## EURCV Finding

- SG-FORGE official CoinVertible page showed `93 221 301,34 EUR` in circulation on 2026-03-30.
- CoinGecko reported `circulating_supply = 93,221,301.34` and `market_cap = 106,720,303` USD on 2026-03-30.
- DefiLlama `stablecoins?includePrices=true` exposed EURCV with only:
  - `Ethereum = 65,558,870.06`
  - `Solana = 11,400,409.22`
  - total `76,959,279.29`
- Pharos was passing DefiLlama through directly for EURCV, so the dashboard inherited the undercount.

Root cause:

- the supply pipeline had no reconciliation step for tracked DefiLlama-backed assets when metadata-known deployments were missing from DefiLlama `chainCirculating`
- EURCV metadata includes `ethereum`, `xrpl`, `stellar`, and `solana`, but DefiLlama only published `Ethereum` and `Solana`
- because total supply was treated as authoritative from DefiLlama, missing XRPL / Stellar supply depressed the reported market cap

## Broader Audit

I compared tracked `detailProvider = "defillama"` assets with CoinGecko current market cap and metadata chain coverage. The clearest undercount cohort was:

- `usdu-unitas`
- `feusd-felix`
- `veur-vnx`
- `frax-frax`
- `eurcv-societe-generale-forge`
- `ausd-agora`
- `usdf-falcon`

These all had:

- one or more metadata deployments absent from DefiLlama `chainCirculating`
- CoinGecko market cap materially above the DefiLlama total

I also found DL/CG divergences without missing-deployment evidence (for example `eurs-stasis`, `usds-sky`, `mim-abracadabra`). Those were not auto-overridden because the pipeline lacked strong proof that the issue was missing tracked chain coverage rather than a source-definition mismatch.

## Fix

Added a targeted reconciliation pass in `sync-stablecoins`:

- only considers tracked assets with `detailProvider = "defillama"` and a `geckoId`
- requires at least one metadata deployment missing from DefiLlama chain coverage
- requires CoinGecko current market cap to be materially higher than the DefiLlama total
- requires recent CoinGecko market-cap history so current plus `1d/7d/30d` buckets can be repaired coherently

Behavior:

- total `circulating` and `circulatingPrevDay/Week/Month` are repaired from CoinGecko history
- `supplySource` is tagged as `coingecko-gap-fill`
- `chains` becomes the union of the live DefiLlama list and tracked metadata deployments
- `chainCirculating` is only backfilled when exactly one tracked chain is missing; otherwise it remains the DefiLlama lower-bound view

## Residual Limitation

When more than one tracked chain is missing, total market cap becomes correct but per-chain totals remain incomplete because the missing remainder cannot be allocated safely without a chain-specific source.
