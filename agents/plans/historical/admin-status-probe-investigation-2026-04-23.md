# Admin Status Probe Investigation

Date: 2026-04-23

Scope:
- `/admin` endpoint-health incident path
- Public endpoints called out by the user:
  - `/api/blacklist-summary`
  - `/api/dex-liquidity`
  - `/api/health`
  - `/api/peg-summary`

Key conclusion:
- The red/yellow per-endpoint badges in `/admin` are driven by the browser probe loop, not by persisted `status_probe_runs`.
- The persisted status pipeline (`status-self-check` -> `status_state` / `status_probe_runs` -> `/api/status`) and the browser probe loop can disagree by design.

Main code path:
1. Probe target registration:
   - `shared/lib/api-endpoints/definitions.ts`
2. Persisted worker probe producer:
   - `worker/src/cron/status-self-check.ts`
   - writes `status_probe_runs`
   - evaluates and persists `status_state`
3. Persisted admin status reader:
   - `worker/src/api/status.ts`
4. Browser probe producer used by `/admin`:
   - `src/hooks/use-endpoint-probes.ts`
   - routed via `src/lib/api.ts`
   - on `ops.pharos.watch`, public routes go through `/_site-data/*`
5. Pages proxy for public browser probes:
   - `functions/_site-data/[[path]].ts`
   - forwards to `site-api`
   - caches successful responses
6. Admin UI consumer:
   - `src/hooks/use-status-dashboard-model.ts`
   - `src/app/admin/sections/reliability-section.tsx`
   - `src/components/status/endpoint-health-grid.tsx`

Likely failure modes:
- Browser-only timeout:
  - public browser probes abort after 5s
  - can mark a route `unreachable` even if the worker path would have completed later
- Site-data proxy issue:
  - missing `SITE_API_ORIGIN`
  - missing or mismatched `SITE_API_SHARED_SECRET`
  - upstream `site-api` timeout/fetch failure
  - all of these can hit multiple public routes at once
- Freshness-warning stale:
  - browser probes interpret `Warning: 110 ... Response is stale/degraded` as semantic route failure
  - persisted `status-self-check` does not parse these warnings for non-health routes
- Cached stale health:
  - `/api/health` returns `Cache-Control: no-store`
  - `functions/_site-data/[[path]].ts` still caches any 2xx/no-cookie response
  - admin may keep seeing an older degraded/stale health payload

Endpoint-specific freshness sources:
- `/api/peg-summary`
  - freshness comes from `stablecoins` cache `updatedAt`
  - missing/corrupt cache returns 503
- `/api/dex-liquidity`
  - freshness comes from latest successful `sync-dex-liquidity` run, with row timestamp fallback only when no successful run exists
  - degraded/error cron metadata adds `199` warning, which browser probes ignore
- `/api/blacklist-summary`
  - freshness comes from latest successful `sync-blacklist` run, with event timestamp fallback only when no successful run exists
- `/api/health`
  - semantic status comes from `assessPublicHealth()`
  - affected by cache freshness, mint/burn freshness, circuit state, blacklist query health, and DB health

Important mismatch:
- `/api/status-probe-history` reads only failed-path entries from `status_probe_runs.details_json.failed`.
- Because `status-self-check` treats non-health 2xx responses as success and ignores freshness warnings, freshness-induced stale on `/api/blacklist-summary`, `/api/dex-liquidity`, or `/api/peg-summary` will not show up there.
