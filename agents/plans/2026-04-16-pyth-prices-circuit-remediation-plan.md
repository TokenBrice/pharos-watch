# Pyth Prices Circuit Remediation Plan - 2026-04-16

## Scope

Initial investigation of the production `pyth-prices` circuit breaker opening and remediation plan. No runtime code or data changes were made during the investigation phase.

## Implementation Note

The immediate data remediation was applied after this investigation: the stale `pythFeedId` was removed from `usda-anzens` in `shared/data/stablecoins/usd-minor.json`. No Pyth replacement feed was found for Anzens USDA/USD in Hermes metadata during the investigation.

## Findings

- Production `/api/health` reports `pyth-prices` as open with `consecutiveFailures=27`, `lastFailureAt=2026-04-16 07:30:55 UTC`, `lastSuccessAt=2026-04-15 15:30:56 UTC`, and `openedAt=2026-04-16 07:30:55 UTC`.
- `sync-stablecoins` still completes successfully, so this is isolated to Pyth as one pricing input, not the whole stablecoin sync.
- `sync-stablecoins` metadata shows Pyth disappeared from the published price-source distribution after the 2026-04-15 15:30 UTC run:
  - 2026-04-15 15:30 UTC: `pyth_sources=41`
  - 2026-04-15 15:45 UTC and later sampled runs: `pyth_sources=0`
- The Pyth Hermes full-batch request for all configured repo `pythFeedId` values reproduces the failure. Hermes returns HTTP 404:
  - `Price ids not found: 0x3a1050a3c03354c94ed44acf808327f05b7f9d610f38644684f5ce4796cce27b`
- That feed ID belongs to `usda-anzens` in `shared/data/stablecoins/usd-minor.json`.
- Querying each configured Pyth feed individually shows:
  - 45 feeds return HTTP 200.
  - 1 feed returns HTTP 404: `usda-anzens`.
  - 1 of the otherwise valid feeds is stale: `lusd-liquity`, with an old `publish_time`. This does not poison the whole batch because Hermes still returns HTTP 200; the code skips stale feeds locally.
- Querying Hermes feed metadata for `USDA`, `USDA/USD`, and `Anzens` did not find an Anzens USDA/USD replacement feed. The visible `USDA` hits are `USDAI/USD`, `SUSDA/USDA.RR`, and deprecated `USDAF/USD`.

## Root Cause

The curated `pythFeedId` for `usda-anzens` no longer resolves in Pyth Hermes. Because `fetchPythPrices()` sends all configured Pyth feed IDs in one Hermes batch, one invalid ID makes Hermes reject the whole request with 404. `fetchWithRetry()` then returns no response after retrying, `fetchPythPrices()` returns zero usable prices, and `runPrimaryProviderFetch()` records a failed `pyth-prices` circuit outcome. Once the breaker opens, later syncs skip Pyth until the half-open probe window, where the same bad batch fails again.

## Impact

- Current public health remains `healthy`; only one public-impact circuit group is open, and the two live-reserve breakers visible in `/api/health` are not counted against public availability.
- Pricing continues through CoinGecko, DefiLlama list prices, CEX feeds, RedStone, Curve, DEX sources, and fallbacks.
- Pyth is contributing zero current consensus sources, reducing redundancy for the assets that previously had Pyth coverage.
- `usda-anzens` still has a current price through CoinGecko and DefiLlama list inputs.

## Remediation Plan

1. Remove the stale `pythFeedId` from `usda-anzens` unless a verified Anzens USDA/USD replacement feed is found in Pyth metadata.
2. Locally verify the full Pyth batch excluding that feed returns HTTP 200 and yields usable prices. Current check showed 45 requested feeds, 45 parsed rows, 44 usable rows, and one locally skipped stale LUSD feed.
3. Run targeted validation:
   - `npm run check:stablecoin-data`
   - `npm run audit:pricing-providers`
   - `npm test -- worker/src/lib/__tests__/pyth.test.ts worker/src/cron/__tests__/enrich-prices.test.ts`
   - If only data changes are made, run `npm run test:merge-gate` before push as required by repo policy.
4. Deploy the data-only fix.
5. After deploy, either wait for the next 30-minute half-open probe or, if immediate recovery is desired, perform a deliberate ops reset of only `cache.key='circuit:pyth-prices'` after the fixed Worker/Pages artifact is live.
6. Confirm recovery:
   - `/api/health` shows `pyth-prices.state="closed"` and a fresh `lastSuccessAt`.
   - Latest `sync-stablecoins` `cron_runs.metadata.priceSourceHealth.sourceDistribution.pyth` is non-zero again.
   - Spot-check Pyth-backed assets in `/_site-data/stablecoins` include Pyth in `consensusSources` where expected.

## Optional Hardening Follow-Up

After the immediate data fix, consider a separate pricing-pipeline hardening change:

- Make the Pyth fetch path tolerate a bad feed without suppressing all valid feeds, for example by retrying smaller chunks or isolating invalid IDs after a 404.
- Add durable Pyth provider diagnostics to `sync-stablecoins` metadata, similar to Binance/Jupiter diagnostics, so future bad-feed failures identify the offending ID without manual batch bisection.
- Extend `scripts/audit-pricing-provider-config.ts` or add a dedicated check for curated Pyth feed IDs.

This follow-up changes pricing pipeline behavior and should update the pricing methodology/timeline docs if implemented.
