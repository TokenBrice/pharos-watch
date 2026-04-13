# Public `/status/` False Report Remediation Plan

Date: 2026-04-13

Companion investigation: `agents/investigations/2026-04-13-public-status-false-report-investigation.md`

## Root Cause Summary

Two separate semantic mismatches make the public `/status/` page over-report:

1. The public hero and reliability section count every open circuit breaker, while `/api/health.status` only counts public-impact breakers. Live reserve breakers such as `live-reserves:ousg-ondo` and `live-reserves:mtbill-midas` are intentionally excluded from public circuit impact by `shared/lib/public-health.ts`, but the page still renders them as `2 open / Stale`.

2. `/api/public-status-history` filters transitions row-by-row. It keeps public-impact degradation rows, but drops matching recovery rows when those recovery rows only contain info-level causes. `UptimeBar` then receives a non-coherent state-machine stream and paints stale days after the public status has already recovered.

## Success Criteria

- Public circuit badges and hero circuit tile match the existing public-health circuit impact semantics.
- Admin reliability circuit display remains unchanged.
- Public transition history includes the recovery path for retained public-impact incidents.
- Admin-only degradation/recovery pairs still do not appear in public history.
- `/api/public-status-history.currentStatus` continues to match `/api/health.status`.
- Targeted backend and frontend tests cover the two regressions.

## Implementation Plan

1. Export `isPublicImpactCircuitKey()` from `shared/lib/public-health.ts`.

2. Update `src/app/status/client.tsx`.
   - Derive `publicImpactCircuits` from `healthData.circuits`.
   - Use public-impact open and half-open counts for the public hero and public reliability summary badges.
   - Pass `publicImpactCircuits` to the public `CircuitBreakerTable`.
   - Do not change the admin reliability section.

3. Add coherent public transition filtering to `worker/src/api/public-status-history.ts`.
   - Walk the fetched transitions chronologically.
   - Include transitions with public-impact causes.
   - After including a public-impact non-healthy transition, include subsequent transitions until the incident path reaches `healthy`, even if those later rows have only info-level causes.
   - Keep unrelated admin-only incidents excluded.
   - Return transitions newest-first, matching the current API shape.

4. Add tests.
   - Backend: public-impact `healthy -> stale` plus info-only `stale -> healthy` returns both rows.
   - Backend: admin-only `healthy -> degraded -> healthy` returns no rows.
   - Frontend/shared: `live-reserves:*` open breakers are not public-impact circuits.
   - Uptime bar: a coherent degrade/recover pair renders a recovered 30-day summary instead of carrying stale forward.

5. Update docs.
   - `docs/status-dashboard.md`
   - `docs/api-reference.md`

6. Validate.
   - `npm test -- worker/src/api/__tests__/public-status-history.test.ts`
   - `npm test -- src/lib/__tests__/public-status.test.ts src/components/status/__tests__/uptime-bar.test.tsx`
   - `npm run lint`

## Review Loop

### Round 1

Medium issues found:

1. The circuit-display plan originally risked hiding reserve-only circuit information everywhere. Fixed by limiting the filtered display to the public page and stating that admin reliability remains unchanged.

2. The transition-filtering plan originally did not state how output ordering remains compatible with the existing API. Fixed by requiring chronological processing plus newest-first output.

Minor issues fixed:

- Added a component-level `UptimeBar` test so the backend stream coherence assumption is covered near the rendering behavior.

### Round 2

Medium issues found: none.

Remaining notes:

- The helper will not infer incidents whose initial public-impact transition is outside the requested window. That is acceptable for this scoped fix because the observed bug is caused by recovery rows inside the 30-day window being filtered out.
- No schema migration is required.

Final Medium issue count: 0.
