# Runbook: Stablecoins Cache

Triggered by `StatusCause.code`:
- `stablecoins_cache_unavailable`
- `stablecoins_cache_degraded`
- `stablecoin_publication_incomplete`
- `stablecoin_publication_unknown`
- `active_price_coverage_incomplete`
- `active_price_coverage_breadth_degraded`
- `active_price_coverage_unknown`

## Symptom

The cached `/api/stablecoins` payload is missing, malformed, has the wrong object shape, or is still in a legacy array shape that strict readers reject. Depending on mode, `/api/stablecoins` may return `503` rather than serving a payload. Age-only incidents are handled by cache freshness / public-health causes such as `cache_ratio_degraded`, `cache_ratio_stale`, and `cache_freshness_query_failed`; those cause codes do not currently attach this runbook link.

## First checks

1. **`sync-stablecoins` cron:** Admin page → Crons section. Is the cron healthy? Last successful run recent (< 2× expected interval)?
2. **Publication completeness:** for `stablecoin_publication_*`, inspect `/api/status.dataQuality.stablecoinPublication`: missing IDs, active-ID waivers, expected/present/waived counts, expired waivers, and the `observedAt` timestamp of the publication evidence. A schema-valid cache can still be incomplete.
   Publication omissions are not all service incidents: named omissions below the shared breadth threshold (`getActiveAssetServiceBreadthThreshold`: 5% of the expected active cohort, 20 of 396) are an info `stablecoin_publication_incomplete` cause (Watch) with an operational listings component, whatever the asset's market cap (the single-asset $1B rule was retired on 2026-10-21). Unknown coverage, an unnamed count mismatch, or reaching the breadth threshold remains actionable and degrades overall. `/api/health.activePriceCoverage.missingActiveAssets[]` shows current `marketCapUsd` versus diagnostic `lastKnownMarketCapUsd`, original `lastKnownMarketCapObservedAt`, and `lastKnownMarketCapSource` to help prioritise follow-up; they do not change severity. Repeated missing generations never renew a retained snapshot date. Do not acknowledge a price gap or waive a row to conceal unknown evidence. See [proportionate impact](../status-dashboard.md#proportionate-impact-and-triage-rationale) for history and triage semantics.
3. **Active current-price coverage:** for `active_price_coverage_*`, inspect `/api/health.activePriceCoverage` (it is not exposed on `/api/status`): missing IDs, eligibility/streak evidence, and per-gap source and rejection detail. This is distinct from historical chart price coverage. For reviewed Mento market hours, inspect `scheduledClosureGapIds` and per-gap `scheduledClosure` (`market-closed`), plus `invalidMarketHoursCalendarIds` / `expiredMarketHoursCalendarIds`. Closure gaps stay missing; after reopen, alert eligibility waits two sync-stablecoins producer intervals before the ordinary persistence gate applies. Missing/Markets tiles use the last sync's stored counts. See [ADR-43](../architecture.md#adr-43). A gap covered by a valid, unexpired price-gap review still appears in `missingActiveIds` but is never alert-eligible: `acknowledgedGapIds` and the per-asset `acknowledgedGap` carry the review owner, reason, sources, and expiry, while `expiredGapReviewIds` and `invalidGapReviewIds` name entries that acknowledge nothing. Follow [review renewal](./review-renewal.md) to renew with fresh evidence or freeze/delist the asset before expiry; never lower price floors or substitute a quote to close the gap. `active_price_coverage_breadth_degraded` means unavailable live prices (reviewed and short gaps included) reached the same shared breadth threshold as listings (5% of the expected active cohort, 20 of 396): treat it as a provider or pipeline incident, not a per-asset catalog follow-up.
4. **Pricing provider diagnostics:** inspect the `sync-stablecoins` cron's latest-run metadata in Admin → Crons (the `providerDiagnostics` block in `cron_runs.metadata`). It is no longer projected as `/api/status.priceProviderDiagnostics`; check source, stage, status, and error details for sustained Binance, CoinGecko, or DefiLlama failures.

## Remediation

- **Historical price backfill:** `backfill-cg-prices` repairs historical `supply_history` price rows only. It does not republish the exact stablecoin publication or repair current-price coverage, so use it only when historical CoinGecko gaps are independently implicated.
- **Republish cache:** inspect `sync-stablecoins`, clear a stuck lease or provider breaker when applicable, then let the next quarter-hourly run publish the cache. Use `backfill-cg-prices` only when the incident also points at missing historical CoinGecko prices.
- **Circuit breaker:** if a provider breaker is open, clear it per [`lease-and-breaker-recovery.md`](./lease-and-breaker-recovery.md); the pricing sources here are ordinary `circuit:<source>` rows, and scoped live-reserve breakers use `circuit:live-reserves:<scope>`.
- **Address-price provider headroom:** production pins `ADDRESS_PRICE_PROVIDERS_ENABLED=coingecko-onchain-address` in `worker/wrangler.toml`, retaining only the authenticated exact-address lane while the public GeckoTerminal corroboration pass stays outside the quarter-hour invocation. Do not widen that allowlist as part of cache remediation unless a fresh Worker headroom audit proves the scheduled run can complete with the added provider. Reset provider breakers only after confirming the next sync will not immediately consume the same disabled or exhausted lane.
- **Cron lease:** if `sync-stablecoins` shows consecutive `skipped_locked` runs, clear the stale lease per [`lease-and-breaker-recovery.md`](./lease-and-breaker-recovery.md), job `sync-stablecoins`.

## Prevention

- Cache freshness budgets are owned by `shared/lib/api-freshness.ts` and the status thresholds in `shared/lib/status-thresholds.ts`; publication/fallback behavior is owned by `worker/src/cron/sync-stablecoins/`. The stablecoins cache is not deleted by an expiring cron TTL.
- Primary recovery is to diagnose `sync-stablecoins` provider and publication state, clear a relevant lease or breaker only when its exact safety condition holds, and verify the next safe quarter-hourly publication. Do not treat historical price backfill as a generic repair for exact-publication or live-price failures.
