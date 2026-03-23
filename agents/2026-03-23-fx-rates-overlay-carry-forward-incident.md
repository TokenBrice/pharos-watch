## Incident

- Time: 2026-03-23
- Surface: public `/status/` and `/api/health`
- Symptom: `fx-rates` stayed `degraded` with `using cached fallback FX rates` plus `peggedEUR intraday reference is 11h old`

## Production state

- `sync-fx-rates` was in `cached-fallback` for 34 consecutive runs.
- Upstream FX providers were healthy from outside the worker, but production `fx-rates-meta` had already lost all daily provenance:
  - every fiat peg had `sourceCadenceByPeg = "intraday"`
  - every fiat peg had `sourceDateByPeg = null`
  - `ecbDate = null`
- Cached FX values were still numerically aligned with current daily providers, so the remaining degradation was metadata/provenance drift, not obviously bad reference prices.

## Root cause

- OXR / Chainlink realtime overlays were overwriting per-peg source cadence/date with intraday metadata even when they were only refining an already-fresh daily fiat reference.
- Once all live FX fetches later failed, carry-forward logic only saw stale intraday metadata and could no longer recognize those same-day fiat references as cadence-valid daily inputs.
- Result: the job kept publishing a fresh `fx-rates` cache in `cached-fallback` mode and the status surface aged the fiat references as intraday instead of daily.

## Fix

- Preserve fresh daily fiat cadence/date metadata when realtime overlays update a peg that is already anchored to a fresh daily source.
- During carry-forward, reconstruct missing daily fiat `sourceDateByPeg` from the last live per-peg timestamp and normalize cadence back to the peg’s natural daily schedule.
- This lets the next production FX run heal corrupted metadata and return to `mode = "live"` when the carried-forward fiat references are still within daily cadence.
