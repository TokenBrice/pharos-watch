---
title: "Fix worker error propagation and admin response headers"
agent: "codex"
model: "gpt-5.3-codex-spark"
reasoning_effort: "high"
done: false
---

## Goal

Fix 4 worker-side error handling findings: wrap feedback handler, add no-store headers to admin GETs, propagate depeg sub-stage failures to cron status, and trigger alerts on error-status cron returns.

## Task

### Step 1: API-002 — Wrap feedback handler with `withErrorHandler`

In `worker/src/router.ts`, the feedback endpoint handler (around line 137, calling `worker/src/api/feedback.ts:320`) is not wrapped with `withErrorHandler`.

1. Find how the feedback route is registered.
2. Wrap it with `withErrorHandler` the same way other API handlers are wrapped.
3. This ensures any thrown error returns a structured JSON `{ error: "..." }` response instead of a bare 500.

### Step 2: API-005 — Add `no-store` headers to admin GET endpoints

In `worker/src/router.ts` (around line 208) and any admin/diagnostic GET handlers:

1. Find all admin GET endpoints (e.g., `GET /api/debug-sync-state`, `GET /api/status`, `GET /api/status-history`).
2. For each that doesn't already set `Cache-Control`, add:
```typescript
headers.set("Cache-Control", "no-store");
```
3. Check `worker/src/api/backfill-dews.ts` (line ~172) and `worker/src/api/audit-depeg-history.ts` (line ~299) — these are admin GET endpoints that may also need the header.

If there's a centralized place to set headers for admin routes, add it there instead of per-handler.

### Step 3: CRON-006 — Propagate depeg sub-stage failures

In `worker/src/cron/sync-stablecoins.ts`, around lines 563 and 596:

Currently depeg detection/confirmation errors are caught and added to metadata but don't change the overall job status. Fix:

1. Track depeg errors in a counter/flag:
```typescript
let depegErrors = 0;
// in the catch block around line 563/596:
depegErrors++;
```

2. At the end of the function, when building the return status, check:
```typescript
if (depegErrors > 0) {
  status = status === "error" ? "error" : "degraded";
  // or if status was "ok", set to "degraded"
}
```

3. Include `depegErrors` in the returned metadata.

### Step 4: CRON-008 — Alert on `status: "error"` cron returns

In `worker/src/lib/db.ts`, the `logCronRun()` function (around line 374) currently only triggers alerts on thrown exceptions (via the catch block).

1. After the cron run completes and the result is logged, check if the returned status is `"error"`:
```typescript
// After logging the cron run result:
if (result.status === "error" && alertFn) {
  await alertFn(`Cron ${job} returned error status`, result.metadata);
}
```

2. Also check `worker/src/cron/sync-mint-burn.ts` (lines 608-667) — this is the primary consumer that returns `status: "error"`. Verify the alert path works for this flow.

3. In `worker/src/handlers/scheduled.ts`, check how `logCronRun` is called. The alert function is likely passed as a parameter. Make sure the error-status alert uses the same transport.

## Acceptance Criteria

1. `cd worker && npx tsc --noEmit` passes
2. `npm test` passes
3. `npm run lint` passes
4. Feedback handler is wrapped with `withErrorHandler` (verify in router.ts)
5. Admin GET endpoints return `Cache-Control: no-store` header
6. Depeg errors in sync-stablecoins influence the returned status (verify by reading the code)
7. `logCronRun` triggers alerts when result status is "error", not just on exceptions
