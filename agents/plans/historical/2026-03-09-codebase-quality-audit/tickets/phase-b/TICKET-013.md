---
title: "Extract shared fetchWithRetry helper for admin endpoints"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "high"
done: true
---

## Goal

Extract duplicated fetch-with-retry logic from admin endpoints into a shared helper.

## Context

**Research findings addressed:**
- R2-I3: `worker/src/api/audit-depeg-history.ts` has hand-coded 429 retry with duplicated fetch calls (~lines 207-214)
- R2-I4: `worker/src/api/backfill-supply-history.ts` has three separate `Promise.all(fetch[...])` patterns with no retry strategy

## Task

### 1. Create fetchWithRetry helper

Create `worker/src/lib/fetch-retry.ts` with a helper that:
- Accepts a `Request | string` and optional `RequestInit`
- On 429 response, reads `Retry-After` header (default 10s), waits, and retries once
- Returns the `Response`
- Logs warnings on retry

```typescript
export async function fetchWithRetry(
  input: string | Request,
  init?: RequestInit,
  options?: { maxRetries?: number },
): Promise<Response> {
  const maxRetries = options?.maxRetries ?? 1;
  let res = await fetch(input, init);
  for (let i = 0; i < maxRetries && res.status === 429; i++) {
    const retryAfter = parseInt(res.headers.get("Retry-After") ?? "10", 10);
    console.warn(`[fetchWithRetry] 429, waiting ${retryAfter}s before retry ${i + 1}`);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    res = await fetch(input, init);
  }
  return res;
}
```

### 2. Use in audit-depeg-history.ts

In `worker/src/api/audit-depeg-history.ts` (~lines 207-214), replace the manual retry pattern:
```typescript
let cgRes = await fetch(cgEndpoint, { headers: cgFetchHeaders });
if (cgRes.status === 429) {
  const retryAfter = parseInt(cgRes.headers.get("Retry-After") ?? "10", 10);
  console.warn(...);
  await new Promise((r) => setTimeout(r, retryAfter * 1000));
  cgRes = await fetch(cgEndpoint, { headers: cgFetchHeaders });
}
```

With:
```typescript
const cgRes = await fetchWithRetry(cgEndpoint, { headers: cgFetchHeaders });
```

### 3. Use in backfill-supply-history.ts

In `worker/src/api/backfill-supply-history.ts`, replace direct `fetch()` calls in the three `Promise.all` patterns (~lines 33-42, 107-114, 231-243) with `fetchWithRetry()`. Keep the `Promise.all` structure but swap `fetch` → `fetchWithRetry`.

## Files Modified

- `worker/src/lib/fetch-retry.ts` (new)
- `worker/src/api/audit-depeg-history.ts`
- `worker/src/api/backfill-supply-history.ts`

## Acceptance Criteria

- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
- `grep 'fetchWithRetry' worker/src/api/audit-depeg-history.ts` shows usage
- `grep 'fetchWithRetry' worker/src/api/backfill-supply-history.ts` shows usage
- No manual 429 retry loops remain in either file
