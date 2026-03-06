---
title: "Harden API input validation and security boundaries"
agent: "codex"
model: "o4-mini"
reasoning_effort: "high"
done: false
---

## Goal

Fix 9 API/security findings: wrap admin routes with error handlers, validate inputs strictly, add rate limiting, guard URI decoding, harden feedback endpoint, cap unbounded queries, and chunk large batch operations.

## Task

### Step 1: API-001 — Wrap inline admin handlers with `withErrorHandler`

In `worker/src/router.ts`, around line 146, there are inline admin route handlers (for `POST /api/trigger-digest`, `POST /api/reset-blacklist-sync`, `GET /api/debug-sync-state`, etc.) that are NOT wrapped with `withErrorHandler`.

1. Find the `withErrorHandler` function (likely in `worker/src/lib/api-utils.ts` or nearby).
2. Wrap each inline admin handler. For example, if the current pattern is:
   ```typescript
   router.post("/api/trigger-digest", async (req, env) => { ... });
   ```
   Change to:
   ```typescript
   router.post("/api/trigger-digest", withErrorHandler(async (req, env) => { ... }));
   ```
3. Do this for ALL inline handlers in `router.ts` that are not already wrapped.

### Step 2: API-003 — Validate calendar dates properly

In `worker/src/api/digest-snapshot.ts`, around line 28, the date regex accepts syntactically valid but semantically invalid dates (e.g., `2025-02-30`).

After the regex match, add a `Date` validity check:
```typescript
const parsed = new Date(`${match[1]}T00:00:00Z`);
if (isNaN(parsed.getTime())) {
  return new Response(JSON.stringify({ error: "Invalid date" }), { status: 400 });
}
```

### Step 3: API-004 — Strict numeric param parsing

In `worker/src/lib/api-utils.ts`, around line 152, the `parseNumericParam` (or similar) function silently clamps/defaults malformed values.

Change it to return 400 on malformed input instead of clamping:
```typescript
export function parseNumericParam(
  url: URL,
  name: string,
  defaultValue: number,
  min?: number,
  max?: number,
): number | Response {
  const raw = url.searchParams.get(name);
  if (raw === null) return defaultValue;
  const num = Number(raw);
  if (!Number.isFinite(num)) {
    return new Response(JSON.stringify({ error: `Invalid ${name}: must be a number` }), { status: 400 });
  }
  if (min !== undefined && num < min) return min;
  if (max !== undefined && num > max) return max;
  return num;
}
```

Then update all callers to check for `Response` return type before using the value. If a caller receives a `Response`, return it immediately.

**Important:** Check all callers of this function. Each must handle the new `Response` return type. This is a breaking signature change — update each call site.

### Step 4: SEC-011 — Guard `decodeURIComponent`

In `worker/src/router.ts`, around lines 275 and 287, `decodeURIComponent` is called without try/catch.

Wrap each call:
```typescript
let decoded: string;
try {
  decoded = decodeURIComponent(rawPath);
} catch {
  return new Response(JSON.stringify({ error: "Malformed URI" }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}
```

### Step 5: SCHEMA-002 — Cap public blacklist endpoint reads

In `worker/src/api/blacklist.ts`, around line 33, the default `limit=0` can disable the SQL `LIMIT` clause entirely.

1. Change the default limit to `1000` (or a sensible max).
2. Enforce a hard cap: if `limit` exceeds 1000, clamp to 1000.
3. If `limit=0` was intended to mean "no limit", change it to mean "use default" instead.

### Step 6: SCHEMA-006 — Chunk `db.batch()` in backfill-depegs

In `worker/src/api/backfill-depegs.ts`, around line 387, a single `db.batch()` call can contain an unbounded number of statements.

Chunk the batch into groups of 100 statements:
```typescript
const BATCH_CHUNK_SIZE = 100;
for (let i = 0; i < statements.length; i += BATCH_CHUNK_SIZE) {
  const chunk = statements.slice(i, i + BATCH_CHUNK_SIZE);
  await db.batch(chunk);
}
```

### Step 7: SEC-008 — Fix feedback rate-limit race

In `worker/src/api/feedback.ts`, around line 50, the rate limit uses a check-then-insert pattern (read count, then insert if under limit). This is race-prone under concurrent requests.

Replace with an atomic approach. Since D1 doesn't support transactions, use an INSERT-and-count approach:
1. Always INSERT the feedback row first.
2. Then COUNT rows for this IP hash in the time window.
3. If count exceeds limit, DELETE the just-inserted row and return 429.

Or, simpler: use `INSERT INTO ... SELECT ... WHERE (SELECT COUNT(*) ...) < limit` to make it atomic in a single statement.

### Step 8: SEC-009 — Remove hardcoded fallback salt

In `worker/src/api/feedback.ts`, around line 319, there's a hardcoded fallback salt for IP hashing.

1. Remove the fallback — require the env variable.
2. If `env.FEEDBACK_SALT` (or whatever the binding is called) is undefined, return 503 with a clear error:
```typescript
if (!env.FEEDBACK_SALT) {
  return new Response(JSON.stringify({ error: "Service misconfigured" }), { status: 503 });
}
```

### Step 9: SEC-010 — Add basic rate limiting middleware

In `worker/src/router.ts` or a new `worker/src/lib/rate-limit.ts`, add a lightweight per-IP rate limiter for public API endpoints.

**Approach:** Use Cloudflare Workers' in-memory state (understanding it's per-isolate, not global — this is best-effort, not bulletproof):

```typescript
const ipCounts = new Map<string, { count: number; resetAt: number }>();

export function checkRateLimit(ip: string, limit = 60, windowMs = 60_000): Response | null {
  const now = Date.now();
  const entry = ipCounts.get(ip);
  if (!entry || now > entry.resetAt) {
    ipCounts.set(ip, { count: 1, resetAt: now + windowMs });
    return null;
  }
  entry.count++;
  if (entry.count > limit) {
    return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
      status: 429,
      headers: { "Retry-After": String(Math.ceil((entry.resetAt - now) / 1000)) },
    });
  }
  return null;
}
```

Add the check early in the HTTP handler (in `worker/src/handlers/http.ts` or the router), before route dispatch, for non-admin requests only. Periodically prune the map (every 1000 requests, delete entries past their `resetAt`).

## Acceptance Criteria

1. `cd worker && npx tsc --noEmit` passes
2. `npm test` passes
3. `npm run lint` passes
4. Manually verify: `curl -s https://api.pharos.watch/api/blacklist?limit=999999` should be capped (won't return unbounded rows)
5. `decodeURIComponent` calls in `router.ts` are wrapped in try/catch
6. All inline admin handlers in `router.ts` use `withErrorHandler`
7. `parseNumericParam` returns 400 on non-numeric input (check callers handle the Response type)
