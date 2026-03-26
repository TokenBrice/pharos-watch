# /admin and /status review

Date: 2026-03-26

Scope:
- `src/app/admin/*`
- `src/app/status/*`
- supporting status/health hooks, shared dashboard model, Pages Functions proxy/gate, and worker status/health endpoints

Validation run:
- `npm run lint` -> passed with existing warnings only
- `npm run build` -> passed
- `npm test` -> failed in unrelated yield tests:
  - `worker/src/cron/__tests__/yield-bima-source.test.ts`
  - `worker/src/cron/__tests__/yield-helpers.test.ts`
- `cd worker && npx tsc --noEmit` -> failed in unrelated yield files:
  - `worker/src/cron/__tests__/yield-ondo-source.test.ts`
  - `worker/src/cron/yield-sync/resolve.ts`
- Targeted status/admin tests passed:
  - `src/app/admin/__tests__/client.test.tsx`
  - `worker/src/api/__tests__/status.test.ts`
  - `worker/src/api/__tests__/health.test.ts`
  - `worker/src/api/__tests__/status-history.test.ts`
  - `functions/__tests__/ops-admin-proxy.test.ts`
  - `functions/__tests__/admin-host-gate.test.ts`

Live checks:
- `https://pharos.watch/status/` -> 200
- `https://pharos.watch/admin/` -> 404
- `https://ops.pharos.watch/admin/` -> Cloudflare Access redirect
- `https://api.pharos.watch/api/health` -> currently `degraded`

Findings:
1. Public `/status` mint/burn presentation ignores `criticalLaneHealthy`.
   - The worker marks mint/burn degraded when the critical lane last run is `error` or `degraded`, even if the last successful sync is still fresh.
   - The public page derives tone and impacted-surface copy only from `freshnessStatus`, so it can render the mint/burn card as healthy and omit impacted public surfaces while `/api/health` is already degraded for that lane.

2. Public `/status` hero cache summary is not computed from the same cache-health logic as `/api/health`.
   - The hero’s `getWorstCacheRatio()` skips `ageSeconds == null`, and its tone is based only on cache age/max-age ratio.
   - Backend health uses missing cache rows as stale and also degrades/stales the FX lane from source freshness / cached-fallback state.
   - Result: the hero can show a healthy “Worst Cache Lane” tile while the backend health status is degraded or stale for cache-related reasons.

3. Admin reserve-drift watch threshold is inconsistent with the rest of the application.
   - `/api/status` reserve drift currently includes coins at `delta > 5`.
   - The live-reserve drift alerting path and the safety-score methodology both define the drift threshold as `>15` points.
   - The admin page copy also says `>5pt`, so the page is internally consistent with its payload, but it is not consistent with the broader application’s alerting/methodology contract.
