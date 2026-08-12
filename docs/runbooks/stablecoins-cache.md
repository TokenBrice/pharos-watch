# Runbook: Stablecoins Cache

Triggered by `StatusCause.code`:
- `stablecoins_cache_unavailable`
- `stablecoins_cache_degraded`
- `stablecoin_publication_incomplete`
- `stablecoin_publication_unknown`
- `active_price_coverage_incomplete`
- `active_price_coverage_unknown`

## Symptom

The cached `/api/stablecoins` payload is missing, malformed, has the wrong object shape, or is still in a legacy array shape that strict readers reject. Depending on mode, `/api/stablecoins` may return `503` rather than serving a payload. Age-only incidents are handled by cache freshness / public-health causes such as `cache_ratio_degraded`, `cache_ratio_stale`, and `cache_freshness_query_failed`; those cause codes do not currently attach this runbook link.

## First checks

1. **`sync-stablecoins` cron:** Admin page → Crons section. Is the cron healthy? Last successful run recent (< 2× expected interval)?
2. **Publication completeness:** for `stablecoin_publication_*`, inspect `/api/status.dataQuality.stablecoinPublication`: missing IDs, active-ID waivers, expected/published counts, generation, and publication evidence. A schema-valid cache can still be incomplete.
3. **Active current-price coverage:** for `active_price_coverage_*`, inspect `activePriceCoverage`: missing IDs, eligibility/streak evidence, and provider diagnostics. This is distinct from historical chart price coverage.
4. **Pricing provider diagnostics:** inspect `/api/status.priceProviderDiagnostics`. Any upstream (Binance, CoinGecko, DefiLlama) reporting sustained failures?

## Remediation

- **Historical price backfill:** `backfill-cg-prices` repairs historical `supply_history` price rows only. It does not republish the exact stablecoin publication or repair current-price coverage, so use it only when historical CoinGecko gaps are independently implicated.
- **Republish cache:** inspect `sync-stablecoins`, clear a stuck lease or provider breaker when applicable, then let the next quarter-hourly run publish the cache. Use `backfill-cg-prices` only when the incident also points at missing historical CoinGecko prices.
- **Circuit breaker:** if a provider breaker is open, delete its `cache` row. `POST /api/reset-circuit-breaker` was retired on 2026-08-09; this single delete is exactly what it ran, and the next call re-probes closed. Scoped live-reserve breakers use the same key convention, `circuit:live-reserves:<scope>`.

  ```bash
  npx --no-install wrangler d1 execute stablecoin-db --remote --command \
    "DELETE FROM cache WHERE key = 'circuit:<source>';"
  ```
- **Address-price provider headroom:** production pins `ADDRESS_PRICE_PROVIDERS_ENABLED=coingecko-onchain-address` in `worker/wrangler.toml`, retaining only the authenticated exact-address lane while the public GeckoTerminal corroboration pass stays outside the quarter-hour invocation. Do not widen that allowlist as part of cache remediation unless a fresh Worker headroom audit proves the scheduled run can complete with the added provider. Reset provider breakers only after confirming the next sync will not immediately consume the same disabled or exhausted lane.
- **Cron lease:** if `sync-stablecoins` shows consecutive `skipped_locked` runs, delete the lease row. `POST /api/reset-cron-lease` was retired on 2026-08-09 and ran exactly this statement. Do not clear a lease while `/api/status` shows an active, fresh `inFlight` progress row for the same job.

  ```bash
  npx --no-install wrangler d1 execute stablecoin-db --remote --command \
    "DELETE FROM cron_leases WHERE job = 'sync-stablecoins';"
  ```

## Prevention

- The cache TTL and fallback mode are configured in the sync-stablecoins cron. Do not tune these without understanding the `status-thresholds` coupling.
- Primary recovery is to diagnose `sync-stablecoins` provider and publication state, clear a relevant lease or breaker only when its exact safety condition holds, and verify the next safe quarter-hourly publication. Do not treat historical price backfill as a generic repair for exact-publication or live-price failures.
