# Runbook: Stablecoins Cache

Triggered by `StatusCause.code`:
- `stablecoins_cache_unavailable`
- `stablecoins_cache_degraded`

## Symptom

The cached `/api/stablecoins` payload is missing, malformed, has the wrong object shape, or is still in a legacy array shape that strict readers reject. Depending on mode, `/api/stablecoins` may return `503` rather than serving a payload. Age-only incidents are handled by cache freshness / public-health causes, not by `stablecoins_cache_unavailable` or `stablecoins_cache_degraded`.

## First checks

1. **`sync-stablecoins` cron:** Admin page → Crons section. Is the cron healthy? Last successful run recent (< 2× expected interval)?
2. **Data-quality signal:** `/admin` → Overview → Blockers. `missing_prices_degraded` or `missing_prices_stale` usually accompanies a degraded cache.
3. **Pricing provider diagnostics:** `/api/status` response → `priceProviderDiagnostics`. Any upstream (Binance, CoinGecko, DefiLlama) reporting sustained failures?

## Remediation

- **Historical price backfill:** `backfill-cg-prices` repairs historical `supply_history` price rows; it does not republish the `stablecoins` cache.
- **Republish cache:** inspect `sync-stablecoins`, clear a stuck lease or provider breaker when applicable, then let the next quarter-hourly run publish the cache. Use `backfill-cg-prices` only when the incident also points at missing historical CoinGecko prices.
- **Circuit breaker:** if a provider breaker is open, call `POST https://ops-api.pharos.watch/api/reset-circuit-breaker?circuit=<source>` with `CF-Access-Client-Id`, `CF-Access-Client-Secret`, `X-Pharos-Admin: 1`, and an `Idempotency-Key`.
- **Cron lease:** if `sync-stablecoins` shows consecutive `skipped_locked` runs, call `POST https://ops-api.pharos.watch/api/reset-cron-lease?job=sync-stablecoins` with the same Access service-token + `X-Pharos-Admin` + `Idempotency-Key` pattern.

## Prevention

- The cache TTL and fallback mode are configured in the sync-stablecoins cron. Do not tune these without understanding the `status-thresholds` coupling.
- For stablecoins-cache incidents, do not prefer the current recommended action unless missing historical CoinGecko prices are also implicated. Primary recovery is to inspect `sync-stablecoins`, clear a relevant lease or breaker when applicable, and let the next quarter-hourly publish run rebuild the cache.
