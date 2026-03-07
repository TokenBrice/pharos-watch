---
title: "Extract matchDynamicRoute helper to deduplicate dynamic route matching"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "medium"
done: false
---

## Goal

Extract a `matchDynamicRoute` helper function in the router to eliminate the near-identical dynamic route matching blocks for `/api/stablecoin-summary/:id` and `/api/stablecoin/:id`.

## Prerequisites

This ticket assumes Phase 1 has been merged to main and the worktree was created from the post-Phase-1 state. Phase 1 TICKET-002 converts the inline error responses in `router.ts` to use `errorResponse()` and adds the import. If for some reason Phase 1 was not applied, the dynamic route blocks will still use `new Response(JSON.stringify({error: "Malformed URI"}), ...)` instead of `errorResponse(400, "Malformed URI")` — the refactor still applies identically, just wrap the inline construction instead.

## Task

1. **`worker/src/router.ts`**:

   Ensure `errorResponse` is in the import from `./lib/api-utils` (Phase 1 should have added it):
   ```typescript
   import { resolveOrReject, withErrorHandler, errorResponse } from "./lib/api-utils";
   ```

   Add a new helper function **above** the `route()` function (around line 235):

   ```typescript
   function matchDynamicRoute(
     path: string,
     pattern: RegExp,
     handler: (db: D1Database, canonicalId: string, ctx: ExecutionContext) => Promise<Response>,
     db: D1Database,
     ctx: ExecutionContext,
   ): Promise<Response> | null {
     const match = path.match(pattern);
     if (!match) return null;
     let id: string;
     try {
       id = decodeURIComponent(match[1]);
     } catch {
       return Promise.resolve(errorResponse(400, "Malformed URI"));
     }
     const resolved = resolveOrReject(id, `path=${path}`);
     if (resolved instanceof Response) {
       return Promise.resolve(resolved);
     }
     return handler(db, resolved.canonicalId, ctx);
   }
   ```

2. **Replace the two dynamic route blocks** at the bottom of the `route()` function (currently lines ~281-323).

   Before (two separate blocks):
   ```typescript
   // /api/stablecoin-summary/:id — resolve to canonical ID before handler lookup
   const summaryMatch = path.match(/^\/api\/stablecoin-summary\/(.+)$/);
   if (summaryMatch) {
     let id: string;
     try {
       id = decodeURIComponent(summaryMatch[1]);
     } catch {
       return Promise.resolve(
         errorResponse(400, "Malformed URI"),  // or inline new Response(...)
       );
     }
     const resolved = resolveOrReject(id, `path=${url.pathname}`);
     if (resolved instanceof Response) {
       return Promise.resolve(resolved);
     }
     const canonicalId = resolved.canonicalId;
     return handleStablecoinSummary(db, canonicalId);
   }

   // /api/stablecoin/:id — resolve to canonical ID before handler lookup
   const detailMatch = path.match(/^\/api\/stablecoin\/(.+)$/);
   if (detailMatch) {
     // ... identical pattern ...
   }
   ```

   After (two one-liners):
   ```typescript
   const summaryResult = matchDynamicRoute(
     path,
     /^\/api\/stablecoin-summary\/(.+)$/,
     (db, id) => handleStablecoinSummary(db, id),
     db,
     ctx,
   );
   if (summaryResult) return summaryResult;

   const detailResult = matchDynamicRoute(
     path,
     /^\/api\/stablecoin\/(.+)$/,
     (db, id, ctx) => handleStablecoinDetail(db, id, ctx),
     db,
     ctx,
   );
   if (detailResult) return detailResult;

   return null;
   ```

   Note: `handleStablecoinSummary` takes `(db, id)` — it does NOT use `ctx`. `handleStablecoinDetail` takes `(db, id, ctx)`.

## Acceptance Criteria

- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
- `grep -c "matchDynamicRoute" worker/src/router.ts` returns at least 3 (1 definition + 2 calls)
- `grep -c "decodeURIComponent" worker/src/router.ts` returns 1 (only inside `matchDynamicRoute`)
- The existing router contract tests pass: `npx vitest run worker/src/api/__tests__/router-contract.test.ts`
