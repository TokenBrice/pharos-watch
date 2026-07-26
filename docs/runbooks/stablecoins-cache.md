# Runbook: Stablecoins Cache

Triggered by `StatusCause.code`:
- `stablecoins_cache_unavailable`
- `stablecoins_cache_degraded`

## Symptom

The cached `/api/stablecoins` payload is missing, malformed, has the wrong object shape, or is still in a legacy array shape that strict readers reject. Depending on mode, `/api/stablecoins` may return `503` rather than serving a payload. Age-only incidents are handled by cache freshness / public-health causes such as `cache_ratio_degraded`, `cache_ratio_stale`, and `cache_freshness_query_failed`; those cause codes do not currently attach this runbook link.

## First checks

1. **`sync-stablecoins` cron:** Admin page → Crons section. Is the cron healthy? Last successful run recent (< 2× expected interval)?
2. **Data-quality signal:** `/admin` → Triage → Blockers. `missing_prices_degraded` or `missing_prices_stale` usually accompanies a degraded cache.
3. **Pricing provider diagnostics:** `/api/status` response → `priceProviderDiagnostics`. Any upstream (Binance, CoinGecko, DefiLlama) reporting sustained failures?

## Remediation

- **Recommended historical price backfill:** the status page currently recommends `backfill-cg-prices` for `stablecoins_cache_unavailable`, `stablecoins_cache_degraded`, and missing-price causes. It repairs historical `supply_history` price rows; it does not directly republish the `stablecoins` cache, so treat it as the right action when missing historical CoinGecko prices are implicated.
- **Republish cache:** inspect `sync-stablecoins`, clear a stuck lease or provider breaker when applicable, then let the next quarter-hourly run publish the cache. Use `backfill-cg-prices` only when the incident also points at missing historical CoinGecko prices.
- **Circuit breaker:** if a provider breaker is open, call `POST https://ops-api.pharos.watch/api/reset-circuit-breaker?circuit=<source>` with `CF-Access-Client-Id`, `CF-Access-Client-Secret`, `X-Pharos-Admin: 1`, and an `Idempotency-Key`. Scoped live-reserve breakers use the same endpoint with `circuit=live-reserves:<scope>`.
- **Address-price provider headroom:** production pins `ADDRESS_PRICE_PROVIDERS_ENABLED=coingecko-onchain-address` in `worker/wrangler.toml`, retaining only the authenticated exact-address lane while the public GeckoTerminal corroboration pass stays outside the quarter-hour invocation. Do not widen that allowlist as part of cache remediation unless a fresh Worker headroom audit proves the scheduled run can complete with the added provider. Reset provider breakers only after confirming the next sync will not immediately consume the same disabled or exhausted lane.
- **Cron lease:** if `sync-stablecoins` shows consecutive `skipped_locked` runs, call `POST https://ops-api.pharos.watch/api/reset-cron-lease?job=sync-stablecoins` with the same Access service-token + `X-Pharos-Admin` + `Idempotency-Key` pattern.

## Prevention

- The cache TTL and fallback mode are configured in the sync-stablecoins cron. Do not tune these without understanding the `status-thresholds` coupling.
- For stablecoins-cache incidents, remember that the current recommended action is historical price backfill rather than direct cache publication. Primary recovery for a malformed or missing cache is still to inspect `sync-stablecoins`, clear a relevant lease or breaker when applicable, and let the next quarter-hourly publish run rebuild the cache.
