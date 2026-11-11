# Runbook: Stablecoins Cache

Triggered by `StatusCause.code`:
- `stablecoins_cache_unavailable`
- `stablecoins_cache_degraded`
- `stablecoin_publication_incomplete`
- `stablecoin_publication_unknown`
- `active_price_coverage_incomplete`
- `active_price_coverage_breadth_degraded`
- `active_price_coverage_unknown`
- `supply_carry_stale`
- `supply_value_drift`

## Symptom

The cached `/api/stablecoins` payload is missing, malformed, has the wrong object shape, or is still in a legacy array shape that strict readers reject. Depending on mode, `/api/stablecoins` may return `503` rather than serving a payload. Age-only incidents are handled by cache freshness / public-health causes such as `cache_ratio_degraded`, `cache_ratio_stale`, and `cache_freshness_query_failed`; those cause codes do not currently attach this runbook link.

## First checks

1. **`sync-stablecoins` cron:** Admin page → Crons section. Is the cron healthy? Last successful run recent (< 2× expected interval)?
2. **Publication completeness:** for `stablecoin_publication_*`, inspect `/api/status.dataQuality.stablecoinPublication`: missing IDs, active-ID waivers, expected/present/waived counts, expired waivers, and the `observedAt` timestamp of the publication evidence. A schema-valid cache can still be incomplete.
   Publication omissions are not all service incidents: named omissions below the shared breadth threshold (`getActiveAssetServiceBreadthThreshold`: ⌈5% × expected active⌉) are an info `stablecoin_publication_incomplete` cause (Watch) with an operational listings component, whatever the asset's market cap (the single-asset $1B rule was retired on 2026-10-21). Unknown coverage, an unnamed count mismatch, or reaching the breadth threshold remains actionable and degrades overall. `/api/health.activePriceCoverage.missingActiveAssets[]` shows current `marketCapUsd` versus diagnostic `lastKnownMarketCapUsd`, original `lastKnownMarketCapObservedAt`, and `lastKnownMarketCapSource` to help prioritise follow-up; they do not change severity. Repeated missing generations never renew a retained snapshot date. Do not acknowledge a price gap or waive a row to conceal unknown evidence. See [proportionate impact](../status-dashboard.md#proportionate-impact-and-triage-rationale) for history and triage semantics.
3. **Active current-price coverage:** for `active_price_coverage_*`, inspect `/api/health.activePriceCoverage` (it is not exposed on `/api/status`): missing IDs, eligibility/streak evidence, and per-gap source and rejection detail. This is distinct from historical chart price coverage. Mento closures appear in `scheduledClosureGapIds` (still missing, not alert-eligible); `invalidMarketHoursCalendarIds`/`expiredMarketHoursCalendarIds` name calendars that suppress nothing ([ADR-43](../architecture.md#adr-43)). A gap covered by a valid, unexpired price-gap review still appears in `missingActiveIds` but is never alert-eligible: `acknowledgedGapIds` and the per-asset `acknowledgedGap` carry the review owner, reason, sources, and expiry, while `expiredGapReviewIds` and `invalidGapReviewIds` name entries that acknowledge nothing. Follow [review renewal](./review-renewal.md) to renew with fresh evidence or freeze/delist the asset before expiry; never lower price floors or substitute a quote to close the gap. `active_price_coverage_breadth_degraded` means unavailable live prices that persisted `STATUS_ACTIVE_PRICE_BREADTH_MIN_GENERATIONS` (2) generations (reviewed or not; unknown streaks count fail-closed; publication-missing IDs excluded) reached the same shared breadth threshold as listings (⌈5% × expected active⌉): treat it as a provider or pipeline incident, not a per-asset catalog follow-up.
4. **Supply carry:** for `supply_carry_stale`, inspect the named assets in `/api/stablecoins`, their original `supplyObservedAt`, `supplyRestored` and `supplyChainGuard`. Only unacknowledged carried values count toward the unchanged 1%-of-active or oldest >48h gate and watchdog. Active `REVIEWED_SUPPLY_CARRIES` entries in `worker/src/lib/supply-integrity.ts` produce a standing notice with expiries; the final 48-hour reminder and an expired review whose asset still carries remain Watches. Follow [review renewal](./review-renewal.md#supply-carry-reviews); expiry immediately re-arms ordinary thresholds. A review changes no supply value, availability, quarantine or carry ceiling.
5. **Supply value drift:** for `supply_value_drift`, compare the named cache generation and source provenance with the previous daily `supply_history` row and any held pre-move baseline. Re-read public supply evidence to distinguish a real redemption from a provider perimeter regression. `REVIEWED_SUPPLY_VALUE_REBASELINES` in `worker/src/lib/supply-integrity.ts` accepts only evidenced real moves within its dated 2% band; follow [value re-baseline review](./review-renewal.md#supply-value-re-baselines), never bless an unverified upstream value to clear the warning.
6. **Pricing provider diagnostics:** inspect the `sync-stablecoins` cron's latest-run metadata in Admin → Crons (the `providerDiagnostics` block in `cron_runs.metadata`). It is no longer projected as `/api/status.priceProviderDiagnostics`; check source, stage, status, and error details for sustained Binance, CoinGecko, or DefiLlama failures.

## Remediation

- **Historical price backfill:** `backfill-cg-prices` repairs historical `supply_history` price rows only. It does not republish the exact stablecoin publication or repair current-price coverage, so use it only when historical CoinGecko gaps are independently implicated.
- **Republish cache:** inspect `sync-stablecoins`, clear a stuck lease or provider breaker when applicable, then let the next quarter-hourly run publish the cache. Use `backfill-cg-prices` only when the incident also points at missing historical CoinGecko prices.
- **Circuit breaker:** if a provider breaker is open, clear it per [`lease-and-breaker-recovery.md`](./lease-and-breaker-recovery.md); the pricing sources here are ordinary `circuit:<source>` rows, and scoped live-reserve breakers use `circuit:live-reserves:<scope>`.
- **Address-price provider headroom:** production pins `ADDRESS_PRICE_PROVIDERS_ENABLED=coingecko-onchain-address` in `worker/wrangler.toml`, retaining only the authenticated exact-address lane while the public GeckoTerminal corroboration pass stays outside the quarter-hour invocation. Do not widen that allowlist as part of cache remediation unless a fresh Worker headroom audit proves the scheduled run can complete with the added provider. Reset provider breakers only after confirming the next sync will not immediately consume the same disabled or exhausted lane.
- **Cron lease:** if `sync-stablecoins` shows consecutive `skipped_locked` runs, clear the stale lease per [`lease-and-breaker-recovery.md`](./lease-and-breaker-recovery.md), job `sync-stablecoins`.

## Prevention

- Cache freshness budgets are owned by `shared/lib/api-freshness.ts` and the status thresholds in `shared/lib/status-thresholds.ts`; publication/fallback behavior is owned by `worker/src/cron/sync-stablecoins/`. The stablecoins cache is not deleted by an expiring cron TTL.
- Primary recovery is to diagnose `sync-stablecoins` provider and publication state, clear a relevant lease or breaker only when its exact safety condition holds, and verify the next safe quarter-hourly publication. Do not treat historical price backfill as a generic repair for exact-publication or live-price failures.
