# 2026-03-23 sync-fx-rates ground-up investigation

## Scope

Investigate the prolonged `sync-fx-rates` degraded window that was showing:

- `fallbackMode = cached-fx-rates`
- `mode = cached-fallback`
- `consecutiveFallbackRuns = 27`
- admin blocker copy like `using cached fallback FX rates ...; peggedEUR intraday reference is 10h old`

## Live production evidence

Queried remote D1 via Wrangler on `2026-03-23`.

- Recent `cron_runs` confirmed a continuous cached-fallback streak from `2026-03-23 07:03:54 UTC` through `2026-03-23 14:04:04 UTC`.
- The last clearly healthy recovery run before the long streak was `2026-03-23 05:02:22 UTC`:
  - `mode = live`
  - `fallbackMode = secondary-live-fallback`
  - `sources.fawazahmed0 = ok`
  - `sources.openExchangeRates = ok`
  - `sources.chainlink = ok`
- The job stayed temporarily recoverable through `2026-03-23 06:48:46 UTC` with `fallbackMode = cadence-valid-carry-forward`.
- At `2026-03-23 07:03:54 UTC`, the job crossed into `cached-fallback` and then never escaped.
- Current cache state at the time of investigation:
  - `fx-rates-meta.mode = cached-fallback`
  - `consecutiveFallbackRuns = 27`
  - most per-peg `sourceUpdatedAtByPeg` values were around `1774242142` (`2026-03-23 05:02:22 UTC`)
  - `peggedJPY` was even older (`1774227383`)
  - all `sourceCadenceByPeg` entries were `intraday`
- Breaker/cache evidence:
  - `circuit:fx-frankfurter` was still `open`
  - `circuit:chainlink-feeds` was stale-open from much earlier and had not been probed again
  - `fx-oxr-last-attempt` and `fx-oxr-last-success` were both still around `05:02 UTC`

## External validation from this machine

The upstream endpoints were reachable from outside the deployed worker during investigation:

- Frankfurter: `200`
- jsDelivr `@fawazahmed0/currency-api`: `200`
- `latest.currency-api.pages.dev`: `200`
- ExchangeRate-API: `200`
- gold-api XAU/XAG: `200`

This did not prove the worker-side Frankfurter failure root cause, but it ruled out a simple global upstream outage.

## Root cause

The main structural problem was inside `worker/src/cron/sync-fx-rates.ts`.

1. The job decided `mode = cached-fallback` immediately after the full-set fiat stack failed:
   - Frankfurter
   - secondary mirror full-set fallback
   - ExchangeRate-API
   - cadence-valid carry-forward
2. Once `mode` became `cached-fallback`, the implementation skipped the entire independent recovery block:
   - Open Exchange Rates
   - gold-api.com
   - Chainlink reference overlays
3. That meant the exact sources most capable of refreshing the stale intraday subset never ran again during the incident.
4. Because those probes never ran:
   - the OXR cooldown keys stopped moving
   - the Chainlink breaker stayed open without re-probes
   - per-peg intraday timestamps stayed frozen
   - the cached-fallback streak kept growing even though the independent recovery paths could have recovered at least part, and potentially all, of the FX set

In other words: `cached-fallback` had become a dead-end state.

The live data strongly suggests that this is what trapped the lane after `07:03 UTC`:

- the last good run at `05:02 UTC` had already promoted OXR / Chainlink data into the per-peg FX metadata
- one or more intraday pegs then aged past the freshness threshold
- that forced `cached-fallback`
- the code stopped running the very probes that could refresh those pegs and clear the condition

## Fix implemented

Updated `worker/src/cron/sync-fx-rates.ts` so that:

- cached fallback now seeds previous per-peg source metadata immediately, instead of re-inheriting it at the very end
- OXR, gold-api, and Chainlink probes still run even when the run has already fallen back to cached FX rates
- if those independent probes restore fresh coverage for the full expected fiat set, the run promotes itself back to `live`
- the fallback streak resets instead of continuing to accumulate on already-recovered rates

Added regression coverage in `worker/src/cron/__tests__/sync-fx-rates.test.ts` for:

- full recovery from cached fallback via OXR
- partial recovery where refreshed per-peg metadata must not be overwritten back to stale cached timestamps

## Remaining unknown

This change fixes the incident-amplifying logic bug. It does not, by itself, explain the original worker-side Frankfurter / secondary / ExchangeRate-API failure that first pushed the job into cached fallback.

If the upstream transport failures continue after this patch deploys, the next step is to capture the exact worker-side fetch error from a live Frankfurter probe and inspect whether the failure is:

- transport/DNS/TLS from the deployed worker runtime
- provider-side blocking of worker egress
- a request-shape issue specific to the deployed worker path

## Validation run locally

- `npm test -- --run worker/src/cron/__tests__/sync-fx-rates.test.ts`
