# 2026-03-23 Stablecoins Cache Price Source Incident

## Symptom

- Public `GET /api/health` was `stale` because the `stablecoins` cache aged past its 600s freshness budget.
- Public `/status/` showed the freshness incident in production.

## Production Findings

- `cron_runs.job = "sync-stablecoins"` had five consecutive `degraded` runs after `2026-03-23 14:40 UTC`.
- Each failing run reported:
  - `validationFailures = 1`
  - `cacheWriteMode = "blocked-invalid-payload"`
  - `downstreamSafe = false`
- `cache.stablecoins:invalid-last` recorded schema failures like:
  - `peggedAssets.<index>.priceSource: Invalid input: expected string, received undefined`
- The affected assets had `price = null`, so the pipeline was serializing valid missing-price states with no `priceSource`.

## Root Cause

The cache-normalization path preserved `price = null` but did not guarantee a serialized `priceSource` string. The shared `StablecoinListResponseSchema` requires `priceSource`, so a handful of missing-price assets caused the entire `stablecoins` cache publication to be blocked.

## Remediation

- Normalize missing serialized `priceSource` values to the sentinel `"missing"` during stablecoins cache publication.
- Add a regression test that exercises a missing-price asset without an upstream `priceSource` and verifies the cache still writes.
- Update the API/pricing docs to describe the sentinel.
