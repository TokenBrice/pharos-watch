# USR DEX Implied Price Investigation

Date: 2026-04-03

## Scope

Investigate why `usr-resolv` was still showing a near-peg DEX implied price even though the retained DEX pool surface remained deeply below peg.

## Live Findings

- `GET /api/peg-summary` showed `dexPriceCheck.dexPrice ~= 0.999298` for `usr-resolv`.
- `GET /api/stablecoins` showed the primary market price near `$0.104`.
- `GET /api/dex-liquidity` showed the published `priceSources` were dominated by a near-peg `bunni-ethereum` aggregate, while visible retained pools and challenger-style evidence still clustered closer to `$0.10-$0.12`.
- The retained/top-pool surface did not match the aggregate DEX price surface.

## Root Cause

`dex_prices` was being computed from the early raw `priceObservations` stream rather than from the final retained pool set.

That raw observation stream is intentionally populated before later liquidity-pipeline admission logic finishes:

- some discovery/fallback paths append price observations before dedupe against known pools
- those observations can survive even when the corresponding pools are later skipped as duplicates
- retained-pool quality filters and protocol caps are applied after those early observations already exist

As a result, `dex_prices` could still be influenced by pools that never survived into:

- retained liquidity detail
- challenger publication
- the UI top-pool surface

This was the real mismatch behind USR: the DEX implied price was not coming from the same pool surface the rest of the product considered valid.

## Implemented Fix

Changed `computeDexPrices()` to rebuild its inputs from the final retained pool set (`retainedPoolsByStablecoin`) after dedupe, retention filters, and protocol-level TVL caps.

Effectively:

- raw discovery observations no longer write directly into `dex_prices`
- skipped duplicate pools cannot keep influencing `dexPriceUsd`
- pools dropped by retained-pool quality filters cannot leak into `price_sources_json`
- the DEX price bridge, challenger publication, and liquidity UI detail now all derive from the same retained pool surface

## Regression Coverage

Added a regression in `worker/src/cron/__tests__/dex-liquidity-scoring.test.ts` that mirrors the USR failure mode:

- retained pools remain around `$0.115`
- the expected DEX implied price stays near `$0.115`
- no omitted near-peg discovery row is allowed to dominate the published aggregate
