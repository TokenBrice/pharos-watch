---
title: "Update isValidStablecoinId to use registry resolver"
agent: "codex"
reasoning_effort: "high"
done: false
---

## Goal

Replace the regex-only `isValidStablecoinId()` with a resolver-based validation that works with both legacy and future canonical IDs.

## Task

1. **`worker/src/lib/api-utils.ts` (line ~119):**
   Current implementation:
   ```ts
   export function isValidStablecoinId(id: string): boolean {
     return /^\d+$/.test(id) || /^(?:gold|silver|cg)-/.test(id);
   }
   ```

   Replace with:
   ```ts
   import { resolveStablecoinId } from "@shared/lib/stablecoin-id-registry";

   export function isValidStablecoinId(id: string): boolean {
     return resolveStablecoinId(id, { allowLegacy: true }) !== null;
   }
   ```

2. **`worker/src/router.ts`:**
   In the dynamic route handlers (lines ~276, ~289) that call `isValidStablecoinId(id)`, add canonical ID resolution AFTER validation:
   ```ts
   const resolved = resolveStablecoinId(id, { allowLegacy: true });
   if (!resolved) {
     return errorResponse(404, "Unknown stablecoin");
   }
   const canonicalId = resolved.canonicalId;
   // Pass canonicalId to handler instead of raw id
   ```

   This ensures handlers always receive canonical IDs, even during the legacy transition period.

   **Add legacy ID logging:** When `resolved.matchedBy !== "canonical"`, log a structured message so we can track legacy usage during the 30-day dual-accept window:
   ```ts
   if (resolved.matchedBy !== "canonical") {
     console.log(`[legacy-id] path=${url.pathname} input=${id} resolved=${resolved.canonicalId} matchedBy=${resolved.matchedBy}`);
   }
   ```
   This is critical for Phase 4: the cleanup ticket requires "legacy ID request volume at zero for 7 consecutive days." Without this logging, there is no way to measure that. Cloudflare Workers logs (via `wrangler tail` or Workers Analytics) will capture these.

3. **Check all other callsites** of `isValidStablecoinId`:
   - `worker/src/api/depeg-events.ts` (line ~33)
   - `worker/src/api/mint-burn-events.ts` (line ~47)
   - `worker/src/api/mint-burn-flows.ts` (line ~213)
   - `worker/src/api/feedback.ts` (line ~296) — **Special case:** `feedback.ts` uses `isValidStablecoinId` to validate user-submitted stablecoin IDs. The validation (`allowLegacy: true`) is correct. However, the file also calls `verifyDataCorrection(db, fb.stablecoinId)` at line ~338, which queries D1 using the stablecoin ID. After D1 migration, the DB has canonical IDs, so this query needs the canonical ID. Resolve to canonical for the `verifyDataCorrection` DB query, but preserve the original user-submitted ID in the feedback payload (GitHub issue body) so human reviewers see what the user actually typed.
   - `worker/src/api/stress-signals.ts` (line ~28)
   - `worker/src/lib/api-utils.ts` (line ~198, inside `parseStablecoinHistoryQuery`)

   For each (except feedback.ts): after the `isValidStablecoinId` check passes, resolve to canonical ID before using it in DB queries.

   **Key integration point — `parseStablecoinHistoryQuery`:** This helper in `api-utils.ts` parses `?stablecoin=` from the URL and is used by supply-history, yield-history, dex-liquidity-history, and safety-score-history handlers. Resolve the stablecoin ID to canonical here so all downstream handlers get canonical IDs automatically:
   ```ts
   const resolved = resolveStablecoinId(stablecoinId, { allowLegacy: true });
   if (!resolved) return errorResponse(404, "Unknown stablecoin");
   // Use resolved.canonicalId in the returned query object
   ```

   Add the same `[legacy-id]` log line in `parseStablecoinHistoryQuery` when a legacy ID is resolved.

4. **Centralize resolution in `api-utils.ts`:** Create a `resolveOrReject()` helper that resolves an ID to canonical, logs `[legacy-id]` when matched by legacy, and returns a 404 error response if unknown. This helper should be used by all callsites (router, individual API handlers, `parseStablecoinHistoryQuery`) to ensure consistent logging everywhere:
   ```ts
   export function resolveOrReject(id: string, context: string): { canonicalId: string } | Response {
     const resolved = resolveStablecoinId(id, { allowLegacy: true });
     if (!resolved) return errorResponse(404, "Unknown stablecoin");
     if (resolved.matchedBy !== "canonical") {
       console.log(`[legacy-id] context=${context} input=${id} resolved=${resolved.canonicalId}`);
     }
     return { canonicalId: resolved.canonicalId };
   }
   ```

5. **Add the import** of `resolveStablecoinId` from `@shared/lib/stablecoin-id-registry` in each file that needs it.

   **Important:** The project alias convention is `@shared/*` → `shared/*`. All existing code uses `@shared/lib/...` (e.g., `@shared/lib/stablecoins`). Do NOT use `@shared/stablecoin-id-registry` (missing `/lib/`) — that would resolve to a non-existent path.

## Acceptance Criteria

- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
- `grep -c 'resolveStablecoinId' worker/src/lib/api-utils.ts` returns at least 1
- Old regex pattern is gone: `grep -F '/^\d+$/' worker/src/lib/api-utils.ts` returns 0 matches
- `grep -c '\[legacy-id\]' worker/src/lib/api-utils.ts` returns at least 1 (centralized logging in resolveOrReject)
- `grep -c 'canonicalId' worker/src/router.ts` returns at least 2 (one per dynamic route handler)
- `grep -c 'resolveOrReject\|resolveStablecoinId' worker/src/router.ts` returns at least 1
