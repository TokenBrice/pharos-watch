# Direct CEX orderbook telemetry plan

Date: 2026-04-16

## Goal

Implement Phase 2 from the CEX/orderbook liquidity roadmap: fetch direct public exchange orderbook snapshots for USDC/USDT and publish comparison telemetry in the DEX liquidity cron metadata without changing scoring.

## Scope

- Add public unauthenticated orderbook clients for:
  - Binance `GET /api/v3/depth`
  - Coinbase Exchange `GET /products/{product_id}/book?level=2`
  - Kraken `GET /0/public/Depth`
- Limit the initial universe to USDC and USDT.
- Compute 2% downside/upside USD depth, mid price, spread bps, and venue counts.
- Thread a compact summary into `sync-dex-liquidity` metadata.
- Do not alter DEX Liquidity Score, Report Cards, or persisted `dex_liquidity` rows.

## Review loop

### Review round 1

Findings:

1. Major: Direct CEX polling could add latency and connection pressure to an already fetch-heavy DEX liquidity run.
   - Fix: keep a tiny allowlist, fetch sequentially with short timeouts, catch failures as non-fatal, and only publish metadata.
2. Major: If direct orderbook depth immediately feeds scoring, centralized books could dominate the current DEX-first score.
   - Fix: no scoring integration in this phase.
3. Minor: Coinbase may not expose a USDC-USD product in the existing provider config.
   - Fix: use only configured Coinbase products; USDT gets Coinbase coverage, USDC can still have Binance/Kraken coverage.
4. Minor: Venue-specific response shapes can make the parser brittle.
   - Fix: normalize all books through one shared `computeOrderbookDepth()` helper and unit-test each provider parser.

### Review round 2

Findings:

1. Minor: Metadata naming should be explicit that the values are direct public CEX reads and not score inputs.
   - Fix: use `directCexOrderbookDepth` in cron metadata.

Open issues above minor: none. This satisfies the implementation gate.

## Implementation steps

1. Add `worker/src/lib/cex-orderbooks.ts`.
2. Export:
   - `computeOrderbookDepth()`
   - `fetchBinanceOrderbookDepths()`
   - `fetchCoinbaseOrderbookDepths()`
   - `fetchKrakenOrderbookDepths()`
   - `fetchMajorStablecoinOrderbookDepthSummary()`
3. Integrate summary into `runFallbackCrawlerPhase()` after existing fallbacks.
4. Add the summary to DEX liquidity metadata under `sourceCoverage.directCexOrderbookDepth`.
5. Add focused tests in `worker/src/lib/__tests__/cex-orderbooks.test.ts`.
6. Update docs/research notes to describe Phase 2 telemetry status.

## Validation

Run:

- `npm test -- worker/src/lib/__tests__/cex-orderbooks.test.ts worker/src/cron/__tests__/sync-dex-liquidity.test.ts`
- `npm run typecheck`
- `npm run lint`
- `npm run check:cron-connections`

Full `npm run test:merge-gate` should be attempted, but current unrelated live-reserve adapter changes may still block it.

