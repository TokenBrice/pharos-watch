# DEX Liquidity Production Stale Investigation

Date: 2026-03-23

## Summary

The DEX Liquidity page stale warning was real when observed, but the production backend had already recovered by the time this investigation completed.

Two separate behaviors were involved:

1. The `2026-03-23 12:10 UTC` `halfHourlyOffset` scheduled slot died mid-slot after `sync-stablecoin-charts` completed and before `sync-dex-liquidity` started logging.
2. After the later `2026-03-23 12:40 UTC` liquidity run succeeded, Cloudflare still served a cached stale `/api/dex-liquidity` response for a few more minutes because the stale response was cacheable for `300` seconds.

## Production Evidence

- Initial live request at `2026-03-23 12:45:21 UTC`:
  - `cf-cache-status: HIT`
  - `age: 250`
  - `x-data-age: 3655`
  - `warning: 110 - "Response is stale (3655s old, max 3600s)"`
- Live D1 `cron_runs` later showed:
  - `sync-dex-liquidity` `status=ok`, `started_at=1774269620` (`2026-03-23 12:40:20 UTC`)
  - downstream `compute-dews`, `stability-index`, and `sync-yield-data` also succeeded
- Live D1 `cron_slot_executions` showed:
  - `halfHourlyOffset`, `slot_started_at=1774267800` (`2026-03-23 12:10:00 UTC`) still `state=running`
  - last heartbeat/update at `1774267999` (`2026-03-23 12:13:19 UTC`)
- Querying `/api/dex-liquidity?cb=...` at `2026-03-23 12:46:44 UTC` bypassed the stale edge object and returned:
  - `x-data-age: 384`
  - no stale `Warning`

## Interpretation

- The stale banner in the screenshot was not a frontend false positive.
- The underlying dataset had become fresh again by the time of the later API and D1 checks.
- The user-visible lag after recovery came from edge caching of a stale API response, not from the page code itself.

## Fix Applied

- Updated the shared freshness-header helper so stale cache-backed responses are returned with `Cache-Control: no-store`.
- This prevents edge/browser caches from continuing to serve a stale response after the next successful cron refresh lands.
