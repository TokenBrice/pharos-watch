# Binance and Jupiter Circuit Follow-up

Date: 2026-04-14
Investigator: Codex

## Scope

Follow up on `agents/investigations/2026-04-14-binance-jupiter-circuits.md` after both `binance-prices` and `jupiter-prices` remained open for multiple probe cycles.

## Assumptions

- Production circuit state in D1 is authoritative.
- Recent simplification commits in the current checkout are the relevant code-change window.
- The goal is root-cause identification and a durable fix path, not a manual circuit reset.

## Evidence

- Current deployed Worker version was uploaded from commit `beecf8755a9f5ebf06cf4d48857559a92ba0003e` at `2026-04-14T12:47:38Z`.
- Binance still contributed after that deployment:
  - `2026-04-14 15:31:14 UTC` sync had `binance_count = 2`.
  - Circuit `lastSuccessAt` stayed `2026-04-14 15:35:36 UTC`.
  - Failures began later, so this does not look like an immediate bad deploy.
- Recent commits touching pricing/circuit-adjacent files:
  - `2ca5a8f3` centralized price application helpers.
  - `bc2d6b9d` replaced duplicated supply summing helper usage.
  - `6b56e67a` refactored primary pricing source plumbing.
  - None changed `worker/src/lib/cex-tickers.ts`, `worker/src/cron/sync-stablecoins/enrich-prices-jupiter-pass.ts`, `worker/src/lib/circuit-breaker.ts`, `worker/src/lib/fetch-retry.ts`, or `shared/lib/pricing-provider-config.ts`.
- Local provider checks still pass:
  - `npm run audit:pricing-providers`: Binance, Kraken, Bitstamp, Coinbase, and RedStone OK.
  - Local Binance `api.binance.com/api/v3/ticker/price` and `data-api.binance.vision/api/v3/ticker/price` both returned HTTP 200 with `USDTUSD` / `USDCUSD`.
  - Local Jupiter Lite V3 request for the production failing batch returned HTTP 200 but no usable USD price for the M0 extension tokens.
- Production tail captured the Jupiter half-open probe at the `2026-04-14 22:30 UTC` sync:
  - `jupiter-prices: open -> half-open`
  - `https://lite-api.jup.ag/price/v3?ids=usdkbee86pkLyRmxfFCdkyySpxRb5ndCxVsK2BkRXwX,xoUSDq85Rjsb6SbUwJyreFgeWQvxdkT7R3c3g7s6p5Y` returned HTTP 403 from the Worker.
  - The pass recorded the source failure and reopened the breaker.
- The same sync later applied protocol-backed overrides successfully, so `usdk-kast` and `xo-exodus` were known authoritative-inheritance assets but still hit Jupiter before the `protocol-redeem` override stage.
- The `2026-04-14 23:01 UTC` sync advanced:
  - `binance-prices` to 15 consecutive failures at `2026-04-14 23:01:24 UTC`.
  - `jupiter-prices` to 13 consecutive failures at `2026-04-14 23:01:31 UTC`.
  - The sync still completed `ok`, wrote cache, and kept `binance_count = 0`, `jupiter_count = 0`.

## Assessment

- Jupiter has a concrete root cause path:
  - Worker-side Jupiter Lite API requests for `usdk-kast` and `xo-exodus` are returning HTTP 403.
  - Those assets are M0 extension assets that should be priced through the authoritative `wm-m0` inheritance path, not through Jupiter fallback.
  - Current stage ordering applies authoritative protocol overrides after fallback enrichment and GT probing, so known inherited-price assets can still poison the Jupiter source-wide circuit before the authoritative price is applied.
- Binance is still under-instrumented:
  - The circuit failure is real and repeated from production.
  - Local endpoint checks are healthy.
  - The current client records failure when the parsed tracked price map is empty, but does not persist or always log the response status/body shape that led to the empty map.
  - This leaves Binance unresolved between Worker egress/provider edge behavior and a response-shape/parser issue.
- A rollback is not supported by the evidence:
  - Current deployment was live hours before the first repeated failures.
  - Binance succeeded after the deployment.
  - Direct provider and circuit code were not changed by the recent simplification commits.

## Recommended Path

1. Do not manually reset the breakers and do not rollback.
2. Add durable provider-attempt diagnostics before changing provider behavior:
   - Persist per-attempt status in `sync-stablecoins` metadata for Binance and Jupiter.
   - Include source, URL host/path, status, candidate count, parsed row count, matched symbol count, error class, and a short sanitized response snippet for non-JSON/non-OK responses.
   - Consume or cancel response bodies before later fetches.
3. Fix Jupiter fallback eligibility:
   - Prevent assets with available authoritative live overrides from entering fallback enrichment, or apply authoritative overrides before fallback enrichment and re-apply them after GT to preserve final-authority semantics.
   - Add a regression test that `usdk-kast` / `xo-exodus` do not call Jupiter when `wm-m0` has a valid parent price.
4. Refine source-wide circuit accounting after diagnostics:
   - Jupiter should not record a source-wide failure for known unsupported/no-price candidate batches if the provider itself is reachable.
   - Binance should distinguish transport/non-OK failure from successful response with zero matched tracked pairs.
5. If Binance diagnostics show Worker-side 403/timeout on `data-api.binance.vision`, add a verified official-host fallback or failover order for Binance ticker fetches.

