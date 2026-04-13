# Public `/status/` False Report Investigation

Date: 2026-04-13

## Assumptions

- The screenshot is from the live public `/status/` page on 2026-04-13.
- The false-positive signal is not a design-only issue; the UI is faithfully rendering data that no longer matches the intended public-health semantics after the latest status-reporting changes.
- `/api/health.status` is the public top-level status contract. Admin-only data-quality and reserve-specific diagnostics may remain visible to operators, but they should not make the public page report a public outage.

## Success Criteria

- The public hero circuit tile and reliability summary do not mark the public surface stale when only non-public-impact breaker keys such as `live-reserves:*` are open.
- The public 30-day runway is built from a coherent public-status transition stream. Public-impact degradation transitions must include their recovery path even when the recovery row's cause list is info-only.
- `/api/health.status` and `/api/public-status-history.currentStatus` continue to match.
- Existing admin status behavior remains unchanged.

## Evidence

Recent relevant commits:

- `67bbdfe64 fix(status): public history filters admin-only causes + aligns currentStatus`
- `6d929566c feat(status): surface transitionsLast24h in the admin status summary`
- `62607e503 fix(status): scope missingPriceRatio denominator to active canonical coins`
- `4c9bf7210 chore(status): merge-gate cleanups for status stability plan`
- Earlier workstream commits in the same plan: `ca4ab112d`, `604cb4b2e`, `3818f66a2`

Live `/api/health` at 2026-04-13 08:02 UTC returned:

- `status: "healthy"`
- `warnings: []`
- worst core cache ratios were healthy
- mint/burn critical lane was fresh and healthy
- exactly two open breakers:
  - `live-reserves:ousg-ondo`
  - `live-reserves:mtbill-midas`

The public-health helper already excludes `live-reserves:*` from public circuit impact:

- `shared/lib/public-health.ts` has `isPublicImpactCircuitKey(key)` returning `false` for `live-reserves:*`.
- `assessPublicHealth()` uses `countPublicImpactOpenCircuits()` before applying `getCircuitImpactStatus()`.

The public page does not use that same circuit-impact filter. In `src/app/status/client.tsx`, it computes:

- `openCircuits = Object.values(healthData.circuits).filter((circuit) => circuit.state === "open").length`
- `halfOpenCircuits = Object.values(healthData.circuits).filter((circuit) => circuit.state === "half-open").length`

Then `src/components/status/public-status-hero.tsx` marks the circuit tile `stale` whenever `openCircuits > 0`. That is why the screenshot can show `Public surface steady` while the circuit tile says `2 open / Stale`.

Live `/_site-data/public-status-history?window=30d&limit=200` returned:

- `currentStatus: "healthy"`
- 93 filtered transitions
- the current `UptimeBar` summary reproduced the screenshot exactly: `4d healthy`, `7d degraded`, `19d stale`

The filtered transition list contains public-impact degradation rows, for example `healthy -> stale` rows caused by `cron_error_runs` / `unhealthy_crons_present`, but the matching recovery rows often have only info causes such as `watch_unhealthy_crons_present` and `onchain_monitor_low_sample`. Since `transitionHasPublicImpact()` excludes all info-only rows, the recovery rows are dropped.

Example from remote D1:

- id `266`: `healthy -> stale`, `raw-stale-immediate-escalation`, causes include `cron_error_runs` and `unhealthy_crons_present`, so it is retained.
- id `267`: `stale -> healthy`, `raw-healthy-recovery-from-stale`, causes are only info-level watch/on-chain notes, so it is filtered out.

The frontend `UptimeBar` expects a coherent state-machine transition stream. Once the recovery is omitted, it keeps `runningStatus = "stale"` until another retained transition changes it. Repeated retained `healthy -> stale` rows do not repair that state, so later days remain red even while `currentStatus` is healthy.

## Root Cause

There are two root causes:

1. **Circuit count semantic drift:** the public page counts all open circuit records, while the backend public-health contract counts only public-impact circuit keys. Reserve-specific live-reserve breakers are visible in `/api/health.circuits`, but they are intentionally not part of the public top-level circuit impact.

2. **Non-coherent filtered transition stream:** commit `67bbdfe64` filters public history rows one row at a time. That hides admin-only flaps, but it can also drop recovery rows needed to close a retained public-impact incident. The filtered stream is then invalid input for `UptimeBar`'s forward state reconstruction.

## Remediation Plan

1. Export the circuit impact classifier from `shared/lib/public-health.ts`.
   - Keep existing public-health behavior unchanged.
   - Reuse the same classifier in the public status page so UI counts match backend impact semantics.

2. Update `src/app/status/client.tsx`.
   - Derive public-impact circuit entries with `isPublicImpactCircuitKey`.
   - Pass public-impact open and half-open counts to `PublicStatusHero`.
   - Use public-impact counts for the public reliability summary badges.
   - Pass only public-impact circuits into the public `CircuitBreakerTable`, leaving the admin reliability section unchanged.

3. Replace row-local public-history filtering with coherent filtering.
   - Add a small helper in `worker/src/api/public-status-history.ts`.
   - Walk transitions chronologically.
   - Include every transition with a public-impact cause.
   - Once a public-impact degradation/recovery path is active, include subsequent transitions until the path returns to `healthy`, even if those later rows are info-only.
   - Keep admin-only incidents excluded when no active public-impact path exists.
   - Preserve newest-first response ordering.

4. Add targeted tests.
   - `worker/src/api/__tests__/public-status-history.test.ts`: a public-impact `healthy -> stale` row followed by an info-only `stale -> healthy` row should return both rows, and an admin-only `healthy -> degraded -> healthy` pair should return neither row.
   - `src/lib/__tests__/public-status.test.ts` or a small shared test: `live-reserves:*` open breakers should not count as public-impact open circuits.
   - `src/components/status/__tests__/uptime-bar.test.tsx`: the existing forward reconstruction should produce a healthy summary when the API provides the public-impact degradation and its recovery. This guards the integration expectation without moving transition filtering into the component.

5. Update docs where behavior is described.
   - `docs/status-dashboard.md`: public status circuit tiles and public circuit table use public-impact circuit filtering; public transition filtering preserves recovery rows for retained incidents.
   - `docs/api-reference.md`: `/api/public-status-history.transitions` filtering includes recovery rows needed to close public-impact incidents.

6. Validate.
   - `npm test -- worker/src/api/__tests__/public-status-history.test.ts`
   - `npm test -- src/lib/__tests__/public-status.test.ts src/components/status/__tests__/uptime-bar.test.tsx`
   - `npm run lint`
   - Broader validation if touched files or failures suggest it.

## Plan Review Loop

### Round 1 Review

Medium issues found:

1. **Initial circuit plan risked hiding all reserve-only information without saying whether admin stayed unchanged.** Fixed by explicitly limiting filtered circuit display to the public page and leaving the admin reliability section unchanged.

2. **Initial transition plan did not state how response ordering is preserved.** Fixed by saying the helper walks chronologically for correctness, then preserves the endpoint's newest-first response ordering.

Minor issues found:

- The test plan initially relied only on backend endpoint tests; added an `UptimeBar` test to guard the component expectation that the API stream is coherent.

### Round 2 Review

Medium issues found: none.

Remaining notes:

- The coherent filtering helper cannot recover public incidents whose first degradation transition is outside the requested window. That limitation already exists for any windowed state reconstruction and is acceptable for this surgical fix. The current false report is caused by recovery rows inside the same 30-day window being dropped.
- No schema change or migration is needed.

Final assessment:

- Medium-issue count: 0.
- Ready for implementation.
