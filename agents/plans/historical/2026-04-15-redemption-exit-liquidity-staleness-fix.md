# Redemption Exit Liquidity Staleness Fix

## Assumptions

- The intended Report Card behavior is that resolved, non-low-confidence, immediate-bounded redemption backstops contribute to Liquidity / Exit.
- Stale redemption snapshots should still fail closed, but "stale" should allow normal hourly cron jitter and the reserve-sync lane running before redemption sync.
- Existing per-coin gates for low confidence, impaired routes, eventual-only capacity, queue caps, and severe active depegs should not change.

## Success Criteria

- Report Cards keep redemption rows when the latest redemption snapshot is older than one hour but still within the expected hourly freshness runway.
- Report Cards suppress redemption rows only when the snapshot is materially stale or missing.
- LUSD/ZCHF-style high-confidence live-direct rows would feed `effectiveExitScore` when the snapshot is within the runway.
- Focused report-card tests cover both the tolerated hourly-lag case and the fail-closed stale case.

## Plan

1. Inspect recent report-card and redemption-backstop changes.
2. Reproduce the global suppression condition in the snapshot tests.
3. Change the report-card redemption freshness budget to use the cron interval with a 2x tolerance instead of an exact 1-hour cutoff.
4. Update docs/methodology version notes for the corrected scoring behavior.
5. Run focused tests and type checks relevant to the changed code.
