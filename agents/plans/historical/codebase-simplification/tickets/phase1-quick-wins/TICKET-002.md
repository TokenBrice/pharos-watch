---
title: "Replace inline error responses with errorResponse() and remove dead code"
agent: "codex"
model: "gpt-5.3-codex-spark"
reasoning_effort: "medium"
done: false
---

## Goal

Replace all inline `new Response(JSON.stringify({ error: ... }))` constructions with the existing `errorResponse()` utility, and remove the dead `isValidStablecoinId()` function.

## Context

The codebase has a well-designed `errorResponse(status, message)` utility in `worker/src/lib/api-utils.ts` (line 167):

```typescript
export function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
```

12 places bypass this utility and construct error responses inline (6 in router, 2 in auth, 2 in http, 1 in rate-limit, 1 in audit-depeg-history). This ticket converts 10 of them; the maintenance mode response (uses non-standard `error: "maintenance"` key) and `audit-depeg-history.ts:95` (uses non-standard `{ error, requestedIds }` shape) are intentionally left as-is.

Additionally, `isValidStablecoinId()` (line 142 of the same file) is never called by any production code — the codebase uses `resolveOrReject()` instead.

## Task

### Part A: Replace inline error responses in router.ts

1. **`worker/src/router.ts`** (line 44):
   - Add `errorResponse` to the existing import:
   - Before: `import { resolveOrReject, withErrorHandler } from "./lib/api-utils";`
   - After: `import { resolveOrReject, withErrorHandler, errorResponse } from "./lib/api-utils";`

2. **`worker/src/router.ts`** (lines 253-261, method validation response):
   - Before:
     ```typescript
     return Promise.resolve(
       new Response(JSON.stringify({ error: methodValidation.message }), {
         status: 405,
         headers: {
           "Content-Type": "application/json",
           "Allow": methodValidation.allowedMethods.join(", "),
         },
       }),
     );
     ```
   - After:
     ```typescript
     const resp = errorResponse(405, methodValidation.message);
     resp.headers.set("Allow", methodValidation.allowedMethods.join(", "));
     return Promise.resolve(resp);
     ```

3. **`worker/src/router.ts`** (lines 139-143, feedback handler):
   - Before:
     ```typescript
     return Promise.resolve(new Response(JSON.stringify({ error: "Bad request" }), {
       status: 400,
       headers: { "Content-Type": "application/json" },
     }));
     ```
   - After:
     ```typescript
     return Promise.resolve(errorResponse(400, "Bad request"));
     ```

4. **`worker/src/router.ts`** (lines 150-153, trigger-digest handler):
   - Before:
     ```typescript
     return new Response(JSON.stringify({ error: "Bad request" }), {
       status: 400,
       headers: { "Content-Type": "application/json" },
     });
     ```
   - After:
     ```typescript
     return errorResponse(400, "Bad request");
     ```

5. **`worker/src/router.ts`** (lines 177-180, reset-blacklist-sync handler):
   - Same pattern as step 4. Replace with `return errorResponse(400, "Bad request");`

6. **`worker/src/router.ts`** (lines 288-293, stablecoin-summary malformed URI):
   - Before:
     ```typescript
     return Promise.resolve(
       new Response(JSON.stringify({ error: "Malformed URI" }), {
         status: 400,
         headers: { "Content-Type": "application/json" },
       }),
     );
     ```
   - After:
     ```typescript
     return Promise.resolve(errorResponse(400, "Malformed URI"));
     ```

7. **`worker/src/router.ts`** (lines 309-314, stablecoin detail malformed URI):
   - Same pattern as step 6. Replace with `return Promise.resolve(errorResponse(400, "Malformed URI"));`

### Part B: Replace inline error responses in auth.ts

8. **`worker/src/lib/auth.ts`**:
   - Add import at the top: `import { errorResponse } from "./api-utils";`
   - Lines 20-23 (invalid Authorization header):
     - Before:
       ```typescript
       return new Response(JSON.stringify({ error: "Unauthorized" }), {
         status: 401,
         headers: { "Content-Type": "application/json" },
       });
       ```
     - After: `return errorResponse(401, "Unauthorized");`
   - Lines 29-32 (missing/invalid credentials):
     - Same replacement: `return errorResponse(401, "Unauthorized");`

### Part C: Replace inline error responses in http.ts

9. **`worker/src/handlers/http.ts`**:
   - Add import at the top: `import { errorResponse } from "../lib/api-utils";`
   - Lines 91-94 (maintenance mode): **DO NOT CHANGE.** The maintenance response uses `error: "maintenance"` (a fixed key, not the message text), which differs from `errorResponse()`'s `error: message` pattern. Leave this line exactly as-is.
   - Lines 137-139 (404 not found):
     - Before:
       ```typescript
       new Response(JSON.stringify({ error: "Not found" }), {
         status: 404,
         headers: { "Content-Type": "application/json" },
       }),
       ```
     - After: `errorResponse(404, "Not found"),`

### Part D: Replace inline error response in rate-limit.ts

10. **`worker/src/lib/rate-limit.ts`** (lines 37-42):
    - Add import at the top: `import { errorResponse } from "./api-utils";`
    - Before:
      ```typescript
      return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000))),
        },
      });
      ```
    - After:
      ```typescript
      const resp = errorResponse(429, "Rate limit exceeded");
      resp.headers.set("Retry-After", String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000))));
      return resp;
      ```

### Part E: Remove dead code

11. **`worker/src/lib/api-utils.ts`** (line 142):
    - Delete the `isValidStablecoinId` function entirely (lines 142-145: JSDoc comment + 3-line function body). It is never called — the codebase uses `resolveOrReject()` for stablecoin ID validation.
    - Verify with grep that no production file imports or calls it.

## Acceptance Criteria

- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
- `grep -rn "new Response(JSON.stringify" worker/src/router.ts | wc -l` returns at most 3 (the success responses like `JSON.stringify({ ok: true, ... })` remain)
- `grep -rn "new Response(JSON.stringify.*error" worker/src/lib/auth.ts | wc -l` returns 0
- `grep -rn "new Response(JSON.stringify.*Not found" worker/src/handlers/http.ts | wc -l` returns 0
- `grep -c "isValidStablecoinId" worker/src/lib/api-utils.ts` returns 0
- `grep -rn "isValidStablecoinId" worker/src/ --include="*.ts" | grep -v __tests__ | wc -l` returns 0
