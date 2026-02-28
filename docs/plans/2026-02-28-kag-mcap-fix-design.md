# KAG Market Cap Fix Design

**Date:** 2026-02-28
**Status:** Approved

## Problem

DefiLlama removed KAG (Kinesis Silver) from their stablecoin tracking around Feb 16–17, 2026. In the days before removal, DL's data for KAG became corrupted:

- Feb 16: native supply spiked from ~3.7M to 65.6M troy oz (17× spike, clearly wrong)
- Feb 17+: `totalCirculatingUSD` frozen at $16,405,596 (should be ~$364M)
- Feb 17+: `stablecoins.llama.fi/stablecoin/silver-kag` returns `null`
- KAG no longer appears in the DL stablecoins list

The Pharos sync (`fetchSilverTokens`) derives KAG's market cap from CoinGecko's `usd_market_cap` field (via `/simple/price?include_market_cap=true`). CG's `usd_market_cap` reflects the same corrupted value ($16.4M). However, CG's `circulating_supply` field is correct (3,721,963 oz) and `current_price` is correct (~$97.95/oz), giving a correct computed mcap of ~$364M.

The corrupt value has been snapshotted daily into `supply_history` since Feb 17, causing the mcap chart on the KAG detail page to show a cliff-drop to near-zero.

## Root Cause

`fetchSilverTokens` in `sync-stablecoins.ts` uses `cgData[geckoId].usd_market_cap` which CoinGecko appears to source (at least partially) from DefiLlama. When DL's data broke, CG's market cap field picked up the corrupt value. CG's `circulating_supply` is an independent field that remained correct.

## Approach: Fix B — Targeted fix inside fetchSilverTokens

Add a parallel CoinGecko `/coins/markets` call inside `fetchSilverTokens` only. No changes to the shared `CoinGeckoMcapData` type or any other consumer (`fetchGoldTokens`, `fetchFiatCoinGeckoTokens`, `fallbackToCgSupply`).

### Why not Fix A (switch fetchCoinGeckoMarketData to /coins/markets)?

Fix A would cascade field-name renames across four consumers including `fallbackToCgSupply` (the full-system DL fallback path). The risk surface is unnecessary — the problem is isolated to silver tokens.

## Design

### Part 1: Ongoing sync fix

**File:** `worker/src/cron/sync-stablecoins.ts` → `fetchSilverTokens`

Add a parallel fetch of CG `/coins/markets?vs_currency=usd&ids=<geckoIds>` alongside the existing DL coins API price fetch. Extract `circulating_supply` and `market_cap` per token.

For each silver token, apply a sanity check:

```
price    = priceInfo.price           (DL coins API, already fetched)
supply   = cgMarkets[id].circulating_supply
computed = supply × price
cg_mcap  = cgData[id].usd_market_cap (existing simple/price value)

if supply > 0 AND abs(cg_mcap - computed) / computed > 0.20:
    mcap = computed   # log warning
else:
    mcap = cg_mcap    # existing behaviour, unchanged
```

If the `/coins/markets` fetch fails, fall through to the existing `cg_mcap` behaviour unchanged (no regression on API failure).

### Part 2: Historical data repair

**File:** `worker/src/api/backfill-supply-history.ts` → `backfillCommodity`

The existing `backfillCommodity` function uses CG's `market_caps` array from `/coins/{id}/market_chart`. For KAG, those values are also corrupted from Feb 17 onwards.

Fix: add a fetch of `/coins/{geckoId}?market_data=true&localization=false` to get `circulating_supply`. For each historical point, apply the same sanity check: if the historical `market_cap` diverges >20% from `historical_price × circulating_supply`, use the computed value.

After deploying, trigger repair via the existing admin endpoint:

```
POST /api/backfill-supply-history?stablecoin=silver-kag
```

This uses `INSERT OR REPLACE` and will overwrite the corrupt Feb 17–28 rows with correct values.

## Scope

- `worker/src/cron/sync-stablecoins.ts` — add parallel `/coins/markets` fetch + sanity check in `fetchSilverTokens`
- `worker/src/api/backfill-supply-history.ts` — extend `backfillCommodity` with supply×price sanity check
- No frontend changes required
- No type changes to `CoinGeckoMcapData`
- No changes to `fetchGoldTokens`, `fetchFiatCoinGeckoTokens`, `fallbackToCgSupply`

## Success Criteria

- Next sync run publishes KAG circulating as ~$364M (not $16.4M)
- After backfill, `supply_history` for `silver-kag` shows correct values for Feb 17–28
- KAG mcap chart no longer shows a cliff-drop
- No regression for other silver/gold/fiat-cg tokens
