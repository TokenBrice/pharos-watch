# 2026-03-29 Status Degraded FX Overlay Fix

## Incident

- Live `/api/health` is `degraded`.
- Sole warning: `fx-rates: peggedSILVER intraday reference is 11h old`.
- Cache age is healthy; degradation comes from `fx-rates.sourceStatus = degraded`.

## Root Cause Hypothesis

- `sync-fx-rates` resolves fresh metals first (`gold-api.com` with peer-median/cached fallback).
- After that, the Chainlink overlay can still overwrite `peggedSILVER` with an older but not-yet-rejected quote (`staleAfterSec = 12h`).
- Public health degrades intraday sources after 6h, so the older Chainlink timestamp becomes the reported source freshness even though a fresher metal reference was already available in the same run.

## Fix Scope

- Keep the existing source stack and cadence model.
- Narrow fix to FX overlay precedence:
  - do not let an older Chainlink quote replace a fresher existing source timestamp for the same peg
  - preserve current behavior when Chainlink is newer or when no current source exists

## Validation

- Add a regression test covering fresh metal resolution followed by older Chainlink silver.
- Run targeted FX tests.
- Run deploy-impacting validation: `npm run lint`, `npm test`, `npm run build`, `cd worker && npx tsc --noEmit`, `npm run test:merge-gate`.
