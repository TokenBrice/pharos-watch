---
title: "Consolidate minor worker API patterns: use shared helpers consistently"
agent: "codex"
model: "gpt-5.3-codex-spark"
reasoning_effort: "medium"
done: false
---

## Goal

Replace duplicated/bypassed patterns in worker API handlers with existing shared helpers. Removes redundant code and improves consistency.

## Context

**Research findings addressed:**
- R2 Finding I5: Duplicate `clampConfidence` in status modules
- R2 Finding M1: Internal-only exports in stablecoin-detail/shared.ts
- R2 Finding M2: Internal-only exports in api-endpoints.ts
- R2 Finding M3: Manual numeric parsing instead of `parseIntParam` in status-history
- R2 Finding M4: Redundant chain filter in mint-burn-events
- R2 Finding M5: Router bypasses `jsonResponse` helper

## Task

### 1. Deduplicate clampConfidence

In `worker/src/api/status.ts` (~line 48), there's a local `clampConfidence` function. The same utility exists in `worker/src/lib/status-reliability.ts` (~line 75). Remove the local version from `status.ts` and import from `status-reliability.ts`.

### 2. De-export internal helpers in stablecoin-detail/shared.ts

In `worker/src/api/stablecoin-detail/shared.ts` (~line 29, 49), `createJsonResponse` and `createStaleCacheResponse` are exported but only used within the same `stablecoin-detail/` module. Remove the `export` keyword from both.

### 3. De-export internal api-endpoints helpers

In `shared/lib/api-endpoints.ts`, de-export the following that have no external imports: `EndpointMethod` (~line 1), `EndpointDefinition` (~line 12), `EndpointMethodValidationError` (~line 32), `getAllowedEndpointMethods` (~line 465). Verify no external imports exist before removing `export`.

### 4. Use parseIntParam in status-history

In `worker/src/api/status-history.ts` (~line 37-40), replace the manual `parseInt` parsing of the `limit` query param with `parseIntParam` from `worker/src/lib/api-utils.ts`.

### 5. Remove redundant chain filter in mint-burn-events

In `worker/src/api/mint-burn-events.ts` (~line 14, 84, 91), only `ethereum` is allowed, but the code still has a redundant optional chain condition branch. Remove the dead branch that can only repeat the same value.

### 6. Use jsonResponse in router

In `worker/src/router.ts` (~line 178, 203, 215), replace inline `new Response(JSON.stringify(...), { headers: ... })` patterns with the `jsonResponse` helper from `worker/src/lib/api-utils.ts`.

## Files Modified

- `worker/src/api/status.ts`
- `worker/src/api/stablecoin-detail/shared.ts`
- `shared/lib/api-endpoints.ts`
- `worker/src/api/status-history.ts`
- `worker/src/api/mint-burn-events.ts`
- `worker/src/router.ts`

## Acceptance Criteria

- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
- `grep -n 'function clampConfidence' worker/src/api/status.ts` returns nothing (using import instead)
- `grep 'export.*createJsonResponse\|export.*createStaleCacheResponse' worker/src/api/stablecoin-detail/shared.ts` returns nothing
- `grep 'parseIntParam' worker/src/api/status-history.ts` shows it's used
- `grep 'jsonResponse' worker/src/router.ts` shows helper usage
