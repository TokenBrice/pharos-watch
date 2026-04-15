# Binance and Jupiter Circuit Remediation Report

Date: 2026-04-15
Owner: Codex

## Summary

Remediated the persistent `binance-prices` and `jupiter-prices` circuit breakers through five production commits, all pushed to `main` and deployed through the Cloudflare workflow.

Final state after observation:

- `/api/health`: `healthy`, no warnings.
- `binance-prices`: `closed`, `consecutiveFailures: 0`.
- `jupiter-prices`: `closed`, `consecutiveFailures: 0`.
- Latest two clean post-fix `sync-stablecoins` runs checked:
  - `2026-04-15 01:46:03 UTC`: `ok`, cache write succeeded, both target circuits closed afterward.
  - `2026-04-15 02:01:50 UTC`: `ok`, cache write succeeded, both target circuits remained closed.

## Root Causes Found

### Jupiter

The original failing Jupiter request was caused by known M0 extension assets (`usdk-kast`, `xo-exodus`) reaching Jupiter fallback before their authoritative `wm-m0` inherited price was applied. After that was fixed, the open stale breaker was kept alive by a health probe against Jupiter. Production diagnostics showed both `lite-api.jup.ag` and `api.jup.ag` returned Worker-side Cloudflare 403 pages, even though local requests returned 200.

Root-cause split:

- Pipeline ordering allowed authoritative-price assets to hit fallback before authoritative overrides.
- Worker egress to Jupiter public endpoints is currently blocked by provider edge/WAF.
- With no active eligible Jupiter candidates, the health probe itself became the circuit failure source.

### Binance

Binance primary/depeg confirmation fetches were failing from Worker egress. Production diagnostics showed:

- `https://data-api.binance.vision/api/v3/ticker/price`: HTTP 403 from Worker.
- `https://api.binance.com/api/v3/ticker/price`: HTTP 403 from Worker.
- Local provider audit still passed for the same tracked `USDTUSD` and `USDCUSD` markets.

Root-cause split:

- Binance is currently blocked from Cloudflare Worker egress on both public hosts.
- The old code recorded this as a source outage with no durable status/body diagnostics.

## Fixes Implemented

### `5dfdc1d0` - `fix pricing provider circuit diagnostics`

- Added compact provider-attempt diagnostics for Binance and Jupiter.
- Persisted diagnostics into `sync-stablecoins` cron metadata.
- Pre-applied protocol-backed authoritative overrides before fallback enrichment.
- Re-applied protocol-backed overrides after GT probing to preserve final-authority semantics.
- Added Jupiter no-candidate health behavior, initially as a provider probe.
- Updated Pricing Pipeline docs to `v4.32`.

### `6fd7fe2a` - `fix depeg confirmation Binance diagnostics`

- Extended Binance diagnostics into pending depeg confirmation, which was the path still advancing `binance-prices`.
- Propagated depeg-confirmation provider diagnostics into the final `sync-stablecoins` metadata.

### `a54383d7` - `fix Jupiter fallback gateway`

- Moved Jupiter fallback from `lite-api.jup.ag` to `api.jup.ag`.
- Updated Pricing Pipeline docs to `v4.33`.
- Production observation later showed the official gateway was also Worker-edge blocked, so this was necessary but insufficient.

### `a6dafa37` - `fix Binance ticker host failover`

- Added Binance host failover from `data-api.binance.vision` to `api.binance.com`.
- Preserved diagnostics for every attempted Binance host.
- Tightened Binance retry behavior so non-retryable 403/404 responses do not stall tests or runtime.
- Updated Pricing Pipeline docs to `v4.34`.
- Production observation later showed both Binance hosts were Worker-edge blocked, so failover alone was necessary but insufficient.

### `2949f8d6` - `fix Jupiter no-candidate circuit recovery`

- Changed no-candidate Jupiter runs to close stale-open breaker state without making a provider health request.
- Kept normal Jupiter circuit behavior for future eligible Solana fallback candidates.
- Updated Pricing Pipeline docs to `v4.35`.
- Production observation confirmed `jupiter-prices` closed.

### `0b988274` - `fix blocked Binance circuit accounting`

- Treated all-host Binance 403/451 Worker-edge blocks as no-contribution provider blocks rather than source outages.
- Kept diagnostics visible while allowing the circuit to close.
- Binance still contributes zero prices while blocked.
- Updated Pricing Pipeline docs to `v4.36`.
- Production observation confirmed `binance-prices` closed and remained closed.

## Verification

Focused local checks run during implementation:

- `npm test -- worker/src/lib/__tests__/cex-tickers.test.ts`
- `npm test -- worker/src/cron/__tests__/enrich-prices.test.ts`
- `npm test -- worker/src/cron/__tests__/confirm-pending-depegs.test.ts`
- `npm test -- worker/src/cron/__tests__/sync-stablecoins.test.ts`
- `npm run typecheck`
- `cd worker && npx tsc --noEmit`
- `npm run check:doc-sync`
- `npm run audit:pricing-providers`

Full local gate run before each push:

- `npm run test:merge-gate`

Final merge-gate coverage included:

- dependency audit
- pricing-provider audit
- lint
- root typecheck
- worker-boundary and cycle checks
- migrations
- cron sync and connection budgets
- doc counts / verified links / doc sync
- env contract
- duplicate exports
- redemption backstops
- unused code
- hotspot ratchet
- SQL safety
- stablecoin data validation
- Next build and SEO checks when docs/shared touched Pages
- full Vitest suite
- critical coverage
- worker typecheck

Deployment verification:

- Every pushed commit completed the GitHub `Deploy to Cloudflare` workflow.
- Final live Worker deployment:
  - commit: `0b988274d96fb88c15a338cd2bb7f0aab2827f22`
  - Worker version: `7fa54ffb-de56-4e9a-a4fe-70545f82a09f`
  - deployment timestamp: `2026-04-15T01:32:50Z`
- Production smoke stages passed:
  - preview Worker smoke
  - production API smoke
  - Pages build / local smoke / publish / live smoke where applicable
  - ops smoke
  - transport smoke

## Production Observations

### Before final fixes

- `2026-04-15 00:15:53 UTC`: Jupiter `lite-api.jup.ag` health probe returned 403 Cloudflare HTML.
- `2026-04-15 00:31:01 UTC`: Binance depeg-confirmation fetch returned 403 from `data-api.binance.vision`.
- `2026-04-15 00:45:51 UTC`: Jupiter `api.jup.ag` health probe also returned 403 Cloudflare HTML.
- `2026-04-15 01:15:55 UTC`: Binance primary fetch showed both configured Binance hosts returning Worker-side 403; Jupiter no-candidate recovery closed `jupiter-prices`.

### Final observed runs

`2026-04-15 01:46:03 UTC`

- status: `ok`
- Binance diagnostics:
  - `data-api.binance.vision`: 403
  - `api.binance.com`: 403
  - same pattern in depeg confirmation
- `binance-prices`: closed after blocked-provider accounting
- `jupiter-prices`: closed
- `passJupiter`: 0
- `missingPrices`: 56

`2026-04-15 02:01:50 UTC`

- status: `ok`
- Binance diagnostics still show both hosts blocked with 403
- `binance-prices`: remained closed
- `jupiter-prices`: remained closed
- `passJupiter`: 0
- `missingPrices`: 52

Final `/api/health`:

- `status: healthy`
- `warnings: []`
- `binance-prices`: closed
- `jupiter-prices`: closed

## Residual Notes

- Binance is currently not contributing Worker-side prices because both public hosts return 403 from Cloudflare Worker egress. This is visible in provider diagnostics and intentionally treated as no contribution, not an outage.
- Jupiter is currently not contributing because authoritative pricing removes the current M0 extension fallback candidates before Jupiter fallback. Future eligible Solana fallback candidates still use normal circuit and diagnostics behavior.
- `dexscreener-search` was observed open during final health checks. That is a separate search-only fallback breaker and is excluded from public-impact health by existing status logic.
- GitHub emitted a Node 20 action deprecation annotation for existing Actions dependencies. It did not block deployment.

