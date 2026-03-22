# PGOLD Redemption Backstop Investigation

Date: 2026-03-22

## Symptom

`sync-redemption-backstops` reported `degraded` with:

- `configured: 137`
- `resolved: 136`
- `unresolved: 1`
- `missingFromCache: ["pgold-pleasing"]`

Live `/api/redemption-backstops` showed `pgold-pleasing` persisted as:

- `resolutionState: "missing-cache"`
- note: `Stablecoins cache missing current supply; route retained as configured but unrated`

## Live upstream evidence

- `https://api.pharos.watch/api/stablecoins` did not contain `pgold-pleasing`
- `https://stablecoins.llama.fi/stablecoins?includePrices=true` did not contain `pgold-pleasing`
- `https://coins.llama.fi/prices/current/coingecko:pleasing-gold` returned an empty `coins` map
- `https://api.llama.fi/protocol/pleasing-gold` returned `mcap: null`
- `https://api.coingecko.com/api/v3/simple/price?ids=pleasing-gold&vs_currencies=usd&include_market_cap=true` still returned both `usd` and `usd_market_cap`

## Root cause

`worker/src/cron/sync-stablecoins/supplemental-assets.ts` excluded commodity tokens with a `protocolSlug` from the CoinGecko market-data batch.

That meant `pgold-pleasing` could only survive supplemental ingestion if at least one DefiLlama path still worked:

1. `coins.llama.fi` had to return a spot price, or
2. `api.llama.fi/protocol/pleasing-gold` had to return a usable `mcap`

Once both DefiLlama paths failed at the same time, `pgold-pleasing` dropped out of the cached `stablecoins` payload entirely even though CoinGecko still had a valid price and market cap.

## Fix

Include all tracked commodity tokens in the CoinGecko supplemental market-data batch, not just those without a `protocolSlug`.

Also added a regression test that simulates the live failure mode:

- no DefiLlama spot for `pleasing-gold`
- no DefiLlama protocol `mcap`
- CoinGecko still has valid `usd` + `usd_market_cap`

Expected outcome: `pgold-pleasing` remains present in the stablecoins cache and redemption backstops can resolve it again.
