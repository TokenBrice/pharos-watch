# Runbook: Stablecoins Cache

Triggered by `StatusCause.code`:
- `stablecoins_cache_unavailable`
- `stablecoins_cache_degraded`

## Symptom

The cached `/api/stablecoins` payload is either missing or older than its configured max-age. Depending on mode, `/api/stablecoins` may be serving a stale snapshot or a 503.

## First checks

1. **`sync-stablecoins` cron:** Admin page → Crons section. Is the cron healthy? Last successful run recent (< 2× expected interval)?
2. **Data-quality signal:** `/admin` → Overview → Blockers. `missing_prices_degraded` or `missing_prices_stale` usually accompanies a degraded cache.
3. **Pricing provider diagnostics:** `/api/status` response → `priceProviderDiagnostics`. Any upstream (Binance, CoinGecko, DefiLlama) reporting sustained failures?

## Remediation

- **Backfill prices:** Admin page → Recommended actions → `backfill-cg-prices`. Idempotent; reruns the pricing pipeline and writes the cache.
- **Circuit breaker:** if a specific provider breaker is open, use the "Reset circuit breaker" button (Reliability section) to re-probe immediately.
- **Cron lease:** if `sync-stablecoins` shows consecutive `skipped_locked` runs, use the "Reset lease" button on the cron card.

## Prevention

- The cache TTL and fallback mode are configured in the sync-stablecoins cron. Do not tune these without understanding the `status-thresholds` coupling.
- The recommended-actions panel surfaces `backfill-cg-prices` automatically when a degraded/unavailable cause is active; prefer that over manual curl.
