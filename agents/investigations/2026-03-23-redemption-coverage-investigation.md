# Redemption Coverage Investigation

Date: 2026-03-23

## Symptom

The `/coverage/` feature snapshot shows the `Redemption Backstop` row at `6/161`, which looks like a large coverage drop.

## Findings

- Live `GET /api/redemption-backstops` still returns `137` configured coin rows.
- All `137` current rows are `resolutionState = "resolved"`.
- `131` of those rows are now `modelConfidence = "low"`.
- Those `131` low-confidence rows are all heuristic supply-based models:
  - `provider = "supply-full-model"`: `100`
  - `provider = "supply-ratio-model"`: `31`
  - `sourceMode = "estimated"`: `131`
- The coverage page maps `modelConfidence = "low"` to status `modeled-heuristic` with `available = false`.
- The redemption feature summary breakdown does not include `modeled-heuristic`, so the snapshot hides those `131` routes entirely.

## Root Cause

The redemption module gained a new low-confidence heuristic state, but the `/coverage/` snapshot row was not updated to surface that state in its headline/breakdown language. The worker dataset is present; the summary representation is stale.

## Intended Fix

- Keep strong-count coverage strict.
- Make the snapshot explicit that the headline count is strong coverage, not total modeled routes.
- Add heuristic-route counts to the redemption breakdown so the row reflects the real post-methodology distribution.

