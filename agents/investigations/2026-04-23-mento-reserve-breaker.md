# Mento Reserve Breaker Investigation

Date: 2026-04-23

## Summary

- Incident: `live-reserves:mento-reserve` circuit breaker open in production
- Affected coins: `cusd-celo`, `ceur-celo`
- Last successful breaker recovery before incident: 2026-04-22 12:15:40 UTC
- Latest failed/open state observed during investigation: 2026-04-23 12:12:49 UTC

## Findings

1. Production health confirmed the breaker was actively open with `consecutiveFailures = 6`.
2. Production `reserve_sync_state` rows for both Mento-backed coins showed:
   - `last_status = "error"`
   - `last_error = 'primary:http-html: mento: layout-changed: missing "reserveComposition":'`
   - `failureCategory = "parser-drift"`
3. The previous five failed runs before the parser-drift error were not healthy soft failures:
   - multiple `adapter-timeout` failures
   - one `Fetch failed for https://reserve.mento.org/`
4. Fetching `https://reserve.mento.org/` directly showed the old embedded `reserveComposition` payload is gone.
5. Local reproduction against the live page triggered the same adapter failure:
   - `mento: layout-changed: missing "reserveComposition":`
6. Browser inspection of the live Mento site showed the new frontend now requests:
   - `https://mento-analytics-api-12390052758.us-central1.run.app//api/v2/reserve`
   - `https://mento-analytics-api-12390052758.us-central1.run.app//api/v2/stablecoins`
   - `https://mento-analytics-api-12390052758.us-central1.run.app//api/v2/addresses`
7. Those browser requests fail only because of CORS. Server-side `curl`/Worker-style fetches to the same API return `200` with JSON.
8. The new reserve JSON already contains the reserve mix Pharos needs under `collateral.assets[*].percentage`.

## Root Cause

The production breaker opened because the `mento` adapter still scraped an old HTML/Next.js payload on `reserve.mento.org`, but Mento migrated the page to client-side API fetches backed by a separate analytics API. The embedded `reserveComposition` field the adapter expected no longer exists.

## Operational Impact

- The ops/status surface correctly shows an active reserve-sync incident.
- Public reserve detail is not a total outage yet because D1 still holds consistent last-good Mento snapshots from 2026-04-22.
- If failures continue, the public detail surface will keep serving that old authoritative snapshot and eventually mark it `live-stale`; it will not immediately drop to curated fallback unless the stored snapshot becomes inconsistent or unreadable.

## Fix Direction

- Switch the `mento` adapter from `http-html` to the analytics `http-json` reserve endpoint.
- Normalize the new asset symbols (`axlEUROC`, `axlUSDC`, `AUSD`, `WETH`, etc.) into Pharos reserve buckets instead of preserving the obsolete HTML-specific symbol set.
- Keep `display.url = https://reserve.mento.org/` for user-facing provenance.

## Tradeoff

The new JSON endpoint does not expose a trustworthy payload update timestamp. That means the recovered adapter can sync reserves again, but Mento freshness should currently be marked `unverified` instead of `verified` until Mento exposes an explicit disclosure/update timestamp.
