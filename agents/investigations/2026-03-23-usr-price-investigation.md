# USR Price Gap Investigation

Date: 2026-03-23

## Symptom

- `usr-resolv` intermittently published with `price = null` on `/api/stablecoins`, which made the stablecoin detail hero show `N/A`.
- PSI could still show USR as an active contributor because PSI already had a replay-safe `price_cache` fallback for already-open depegs.

## Runtime Evidence

- Live D1 history for recent `sync-stablecoins` runs showed USR alternating between:
  - authoritative/high rows such as `coingecko+pyth`
  - non-authoritative `low` rows such as `pyth`
  - `null` rows with rejected fallback metadata such as `dexscreener`
- Live `price_cache` still held a fresh replay-safe authoritative USR row while some later stablecoins publications were low or null.

## Root Cause

- `buildPreviousTrustedPriceLookup()` only consulted the previous stablecoins payload.
- After a confirmed depeg published a later `low` or unusable row, the next run no longer had a "previous trusted" anchor even though `price_cache` still had a fresh replay-safe authoritative price.
- That caused severe-downside fallback validation, including cached replay, to reject the candidate and publish `N/A`.

## Fix

- Merge fresh replay-safe `price_cache` metadata into the previous-trusted lookup used by sync-time price validation.
- Keep the freshest authoritative candidate between the previous stablecoins payload and `price_cache`.
- Added a regression test covering the exact continuity gap: previous stablecoins row is `low`, replay cache row is fresh+authoritative, and the run must still publish cached replay instead of `N/A`.
