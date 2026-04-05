# API Key Gating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate external API access behind admin-provisioned API keys, hard-blocking unauthenticated external requests while leaving website traffic unaffected.

**Architecture:** Add a key validation + per-key rate limiting step to the existing `evaluateAccessGate()` in `gates.ts`. Keys are stored in D1 with an in-memory cache (5min TTL, 60s negative cache). Admin CRUD endpoints manage keys. The existing first-party detection (Origin/Referer/Accept marker) continues to let website traffic through without a key.

**Tech Stack:** Cloudflare Workers, D1, TypeScript

**Spec:** `agents/plans/2026-04-03-api-key-gating-design.md`

---

### File Map

| File | Action | Responsibility |
|---|---|---|
| `worker/migrations/0083_api_keys.sql` | Create | D1 schema for `api_keys` and `api_key_usage` tables |
| `worker/src/lib/api-keys.ts` | Create | Key lookup with in-memory cache, per-key rate limiting, key generation |
| `worker/src/lib/__tests__/api-keys.test.ts` | Create | Tests for key lookup, caching, rate limiting |
| `worker/src/handlers/http/gates.ts` | Modify | Insert API key validation into `evaluateAccessGate()` |
| `worker/src/handlers/http/__tests__/gates.test.ts` | Create or modify | Tests for the updated gate logic |
| `worker/src/handlers/http/cors.ts` | Modify | Add `Authorization` to allowed headers |
| `worker/src/handlers/http/request-dispatch.ts` | Modify | Attach rate-limit headers to keyed responses |
| `worker/src/api/admin-api-keys.ts` | Create | Admin CRUD handler for API keys |
| `worker/src/api/__tests__/admin-api-keys.test.ts` | Create | Tests for admin key CRUD endpoints |
| `shared/lib/api-endpoints.ts` | Modify | Register admin API key endpoints in `ENDPOINT_DEFINITIONS` |
| `worker/src/route-registry.ts` | Modify | Wire admin API key handler into static routes |
| `shared/types/request-source.ts` | Modify | Add `"api-key"` to `PublicApiRequestSource` |
| `worker/src/lib/request-source-attribution.ts` | Modify | Classify keyed requests as `"api-key"` source |
| `worker/src/handlers/http/request-source.ts` | Modify | Pass key info for source classification |

---

### Task 1: D1 Migration

**Files:**
- Create: `worker/migrations/0083_api_keys.sql`
- Modify: `worker/migrations/MANIFEST.md`

- [ ] **Step 1: Write migration SQL**

Create `worker/migrations/0083_api_keys.sql`:

```sql
-- rollout-safety: backward-compatible

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_email TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'free',
  rate_limit_per_sec INTEGER NOT NULL DEFAULT 5,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(is_active);

CREATE TABLE IF NOT EXISTS api_key_usage (
  key_id TEXT NOT NULL,
  bucket_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, bucket_start)
);

CREATE INDEX IF NOT EXISTS idx_api_key_usage_bucket ON api_key_usage(bucket_start);
```

- [ ] **Step 2: Update migration manifest**

Add entry for `0083_api_keys.sql` to `worker/migrations/MANIFEST.md` following the existing format.

- [ ] **Step 3: Apply migration locally**

Run:
```bash
cd worker && npx wrangler d1 migrations apply pharos-db --local
```

Expected: Migration applied successfully.

- [ ] **Step 4: Commit**

```bash
git add worker/migrations/0083_api_keys.sql worker/migrations/MANIFEST.md
git commit -m "feat: add api_keys and api_key_usage D1 tables"
```

---

### Task 2: API Key Lookup and Rate Limiting Module

**Files:**
- Create: `worker/src/lib/api-keys.ts`
- Create: `worker/src/lib/__tests__/api-keys.test.ts`

- [ ] **Step 1: Write tests for key lookup and caching**

Create `worker/src/lib/__tests__/api-keys.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  lookupApiKey,
  checkApiKeyRateLimit,
  generateApiKeyId,
  resetApiKeyCacheForTests,
  type ApiKeyRow,
} from "../api-keys";

function createMockDb(rows: ApiKeyRow[] = []) {
  const firstFn = vi.fn().mockImplementation(async () => {
    return rows.length > 0 ? rows[0] : null;
  });
  const bindFn = vi.fn().mockReturnValue({ first: firstFn, run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }) });
  return {
    prepare: vi.fn().mockReturnValue({ bind: bindFn, first: firstFn, run: vi.fn() }),
    _bind: bindFn,
    _first: firstFn,
  };
}

const ACTIVE_KEY: ApiKeyRow = {
  id: "ph_test-key-123",
  name: "Test Key",
  owner_email: "test@example.com",
  tier: "free",
  rate_limit_per_sec: 5,
  is_active: 1,
  created_at: 1700000000,
  last_used_at: null,
};

describe("generateApiKeyId", () => {
  it("generates a key with ph_ prefix", () => {
    const key = generateApiKeyId();
    expect(key).toMatch(/^ph_[a-f0-9]{32}$/);
  });

  it("generates unique keys", () => {
    const keys = new Set(Array.from({ length: 100 }, () => generateApiKeyId()));
    expect(keys.size).toBe(100);
  });
});

describe("lookupApiKey", () => {
  beforeEach(() => resetApiKeyCacheForTests());
  afterEach(() => resetApiKeyCacheForTests());

  it("returns null for missing key", async () => {
    const db = createMockDb([]);
    const result = await lookupApiKey(db as any, "ph_nonexistent");
    expect(result).toBeNull();
  });

  it("returns key row for active key", async () => {
    const db = createMockDb([ACTIVE_KEY]);
    const result = await lookupApiKey(db as any, ACTIVE_KEY.id);
    expect(result).toEqual(ACTIVE_KEY);
  });

  it("returns null for inactive key", async () => {
    const db = createMockDb([{ ...ACTIVE_KEY, is_active: 0 }]);
    const result = await lookupApiKey(db as any, ACTIVE_KEY.id);
    expect(result).toBeNull();
  });

  it("caches key lookups", async () => {
    const db = createMockDb([ACTIVE_KEY]);
    await lookupApiKey(db as any, ACTIVE_KEY.id);
    await lookupApiKey(db as any, ACTIVE_KEY.id);
    expect(db.prepare).toHaveBeenCalledTimes(1);
  });

  it("negative-caches missing keys", async () => {
    const db = createMockDb([]);
    await lookupApiKey(db as any, "ph_missing");
    await lookupApiKey(db as any, "ph_missing");
    expect(db.prepare).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd worker && npx vitest run src/lib/__tests__/api-keys.test.ts`
Expected: FAIL — module `../api-keys` not found.

- [ ] **Step 3: Implement api-keys module**

Create `worker/src/lib/api-keys.ts`:

```typescript
export interface ApiKeyRow {
  id: string;
  name: string;
  owner_email: string;
  tier: string;
  rate_limit_per_sec: number;
  is_active: number;
  created_at: number;
  last_used_at: number | null;
}

interface CachedKey {
  key: ApiKeyRow | null;
  cachedAt: number;
}

const KEY_CACHE = new Map<string, CachedKey>();
const POSITIVE_CACHE_TTL_MS = 5 * 60 * 1000;
const NEGATIVE_CACHE_TTL_MS = 60 * 1000;
const USAGE_PRUNE_WINDOW_MULTIPLIER = 10;

let lastUsagePruneBucket: number | null = null;
let pendingUsagePrune: Promise<void> | null = null;

export function resetApiKeyCacheForTests(): void {
  KEY_CACHE.clear();
  lastUsagePruneBucket = null;
  pendingUsagePrune = null;
}

export function flushPendingApiKeyPrunes(): Promise<void> {
  if (pendingUsagePrune) {
    const p = pendingUsagePrune;
    pendingUsagePrune = null;
    return p;
  }
  return Promise.resolve();
}

export function generateApiKeyId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `ph_${hex}`;
}

export async function lookupApiKey(
  db: D1Database,
  keyId: string,
): Promise<ApiKeyRow | null> {
  const now = Date.now();
  const cached = KEY_CACHE.get(keyId);
  if (cached) {
    const ttl = cached.key ? POSITIVE_CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS;
    if (now - cached.cachedAt < ttl) {
      return cached.key;
    }
    KEY_CACHE.delete(keyId);
  }

  const row = await db
    .prepare("SELECT * FROM api_keys WHERE id = ?")
    .bind(keyId)
    .first<ApiKeyRow>();

  const activeKey = row && row.is_active === 1 ? row : null;
  KEY_CACHE.set(keyId, { key: activeKey, cachedAt: now });
  return activeKey;
}

export interface ApiKeyRateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
}

export async function checkApiKeyRateLimit(
  db: D1Database,
  keyId: string,
  rateLimitPerSec: number,
): Promise<ApiKeyRateLimitResult> {
  const nowSec = Math.floor(Date.now() / 1000);
  const bucketStart = nowSec;

  const row = await db
    .prepare(
      `INSERT INTO api_key_usage (key_id, bucket_start, count)
       VALUES (?, ?, 1)
       ON CONFLICT(key_id, bucket_start)
       DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(keyId, bucketStart)
    .first<{ count: number | null }>();

  // Prune old buckets periodically
  if (lastUsagePruneBucket !== bucketStart) {
    lastUsagePruneBucket = bucketStart;
    pendingUsagePrune = db
      .prepare("DELETE FROM api_key_usage WHERE bucket_start < ?")
      .bind(bucketStart - USAGE_PRUNE_WINDOW_MULTIPLIER)
      .run()
      .then(() => {})
      .catch((e) => {
        console.warn("[api-keys] usage prune failed:", e);
      });
  }

  const count = row?.count ?? 0;
  const remaining = Math.max(0, rateLimitPerSec - count);
  return {
    allowed: count <= rateLimitPerSec,
    limit: rateLimitPerSec,
    remaining,
    resetAt: bucketStart + 1,
  };
}

export function debounceLastUsedUpdate(
  db: D1Database,
  keyId: string,
  execCtx: ExecutionContext,
): void {
  const nowSec = Math.floor(Date.now() / 1000);
  execCtx.waitUntil(
    db
      .prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ? - 60)")
      .bind(nowSec, keyId, nowSec)
      .run()
      .catch((e) => console.warn("[api-keys] last_used_at update failed:", e)),
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd worker && npx vitest run src/lib/__tests__/api-keys.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/api-keys.ts worker/src/lib/__tests__/api-keys.test.ts
git commit -m "feat: add API key lookup, caching, and per-key rate limiting module"
```

---

### Task 3: CORS Header Update

**Files:**
- Modify: `worker/src/handlers/http/cors.ts`

- [ ] **Step 1: Add Authorization to allowed headers**

In `worker/src/handlers/http/cors.ts`, change the `corsHeaders` function:

```typescript
// old
"Access-Control-Allow-Headers": "Content-Type, Idempotency-Key",
// new
"Access-Control-Allow-Headers": "Content-Type, Idempotency-Key, Authorization",
```

- [ ] **Step 2: Verify existing CORS tests still pass (if any)**

Run: `cd worker && npx vitest run --reporter=verbose 2>&1 | grep -i cors`

- [ ] **Step 3: Commit**

```bash
git add worker/src/handlers/http/cors.ts
git commit -m "feat: allow Authorization header in CORS"
```

---

### Task 4: Wire API Key Validation into the Access Gate

**Files:**
- Modify: `worker/src/handlers/http/gates.ts`
- Modify: `worker/src/handlers/http/request-dispatch.ts`

This is the core change. The gate flow becomes:
1. Admin check (unchanged)
2. Non-API routes pass through (unchanged)
3. Telegram webhook passes through (unchanged)
4. **New: first-party website check → pass through**
5. **New: API key check → validate + rate limit**
6. **New: no key → 401**

- [ ] **Step 1: Write tests for the updated gate**

Create or extend `worker/src/handlers/http/__tests__/gates.test.ts` with tests for:
- First-party website requests pass without key
- Requests with valid `Authorization: Bearer ph_xxx` pass
- Requests with invalid key get 401
- Requests without any auth header get 401
- Rate-limited keyed requests get 429
- Admin requests bypass key check

Use the existing test patterns from `worker/src/api/__tests__/helpers/auth.ts` and mock D1 patterns from the codebase.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd worker && npx vitest run src/handlers/http/__tests__/gates.test.ts`
Expected: FAIL — new test cases fail.

- [ ] **Step 3: Extract first-party detection into a standalone function**

The first-party detection logic already exists in `classifyPublicApiRequestSource()` in `request-source-attribution.ts`. Reuse it in `gates.ts`:

In `worker/src/handlers/http/gates.ts`, update `evaluateAccessGate`:

```typescript
import { classifyPublicApiRequestSource } from "../../lib/request-source-attribution";
import {
  lookupApiKey,
  checkApiKeyRateLimit,
  debounceLastUsedUpdate,
  flushPendingApiKeyPrunes,
  type ApiKeyRateLimitResult,
} from "../../lib/api-keys";

export interface AccessGateResult {
  isAdmin: boolean;
  response: Response | null;
  apiKeyRateLimit: ApiKeyRateLimitResult | null;
  apiKeyId: string | null;
}

function extractBearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
}

function apiKeyRequiredResponse(): Response {
  return new Response(
    JSON.stringify({
      error: "API key required",
      message: "External API access requires an API key. Pass it via the Authorization: Bearer <key> header.",
      docs: "https://pharos.watch/api-docs",
    }),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": 'Bearer realm="pharos.watch"',
      },
    },
  );
}

function invalidApiKeyResponse(): Response {
  return new Response(
    JSON.stringify({ error: "Invalid API key" }),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": 'Bearer realm="pharos.watch"',
      },
    },
  );
}

function rateLimitExceededResponse(result: ApiKeyRateLimitResult): Response {
  return new Response(
    JSON.stringify({ error: "Rate limit exceeded" }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": "1",
        "X-RateLimit-Limit": String(result.limit),
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": String(result.resetAt),
      },
    },
  );
}

export async function evaluateAccessGate(
  request: Request,
  url: URL,
  env: Env,
  execCtx?: ExecutionContext,
): Promise<AccessGateResult> {
  const isAdmin = await hasValidAdminCredential(request, undefined, env);

  // Non-API routes, telegram webhook, and admin requests pass through
  if (!url.pathname.startsWith("/api/") || url.pathname === "/api/telegram-webhook" || isAdmin) {
    return { isAdmin, response: null, apiKeyRateLimit: null, apiKeyId: null };
  }

  // First-party website requests pass through without a key
  const source = classifyPublicApiRequestSource(request);
  if (source === "web") {
    // Apply existing IP-based rate limit for website requests as a safety net
    const publicApiRateLimit = resolvePublicApiRateLimitSalt(env);
    if (!publicApiRateLimit) {
      return {
        isAdmin,
        response: errorResponse(503, "Public API temporarily unavailable"),
        apiKeyRateLimit: null,
        apiKeyId: null,
      };
    }
    const ipRateLimitResponse = await checkPublicApiRateLimit(
      env.DB,
      resolveClientIp(request),
      publicApiRateLimit.salt,
      PUBLIC_API_RATE_LIMIT_MAX_REQUESTS,
      PUBLIC_API_RATE_LIMIT_WINDOW_SEC * 1000,
    );
    return { isAdmin, response: ipRateLimitResponse, apiKeyRateLimit: null, apiKeyId: null };
  }

  // External request — require API key
  const bearerToken = extractBearerToken(request);
  if (!bearerToken) {
    return { isAdmin, response: apiKeyRequiredResponse(), apiKeyRateLimit: null, apiKeyId: null };
  }

  const apiKey = await lookupApiKey(env.DB, bearerToken);
  if (!apiKey) {
    return { isAdmin, response: invalidApiKeyResponse(), apiKeyRateLimit: null, apiKeyId: null };
  }

  // Per-key rate limiting
  const rateLimitResult = await checkApiKeyRateLimit(env.DB, apiKey.id, apiKey.rate_limit_per_sec);
  if (!rateLimitResult.allowed) {
    return {
      isAdmin,
      response: rateLimitExceededResponse(rateLimitResult),
      apiKeyRateLimit: rateLimitResult,
      apiKeyId: apiKey.id,
    };
  }

  // Debounce last_used_at update
  if (execCtx) {
    debounceLastUsedUpdate(env.DB, apiKey.id, execCtx);
    execCtx.waitUntil(flushPendingApiKeyPrunes());
  }

  return { isAdmin, response: null, apiKeyRateLimit: rateLimitResult, apiKeyId: apiKey.id };
}
```

- [ ] **Step 4: Update request-dispatch to pass execCtx and attach rate-limit headers**

In `worker/src/handlers/http/request-dispatch.ts`, update the `handleHttpRequestImpl` function:

1. Pass `ctx` to `evaluateAccessGate`:
```typescript
const { isAdmin, response: gateResponse, apiKeyRateLimit } = await evaluateAccessGate(request, url, env, ctx);
```

2. Before the final return, if `apiKeyRateLimit` is present, attach headers:
```typescript
function attachRateLimitHeaders(response: Response, rateLimit: ApiKeyRateLimitResult): Response {
  const headers = new Headers(response.headers);
  headers.set("X-RateLimit-Limit", String(rateLimit.limit));
  headers.set("X-RateLimit-Remaining", String(rateLimit.remaining));
  headers.set("X-RateLimit-Reset", String(rateLimit.resetAt));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
```

Apply `attachRateLimitHeaders` to the response before `addCorsHeaders` when `apiKeyRateLimit` is non-null.

Also add `X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset` to `Access-Control-Expose-Headers` in `cors.ts`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd worker && npx vitest run src/handlers/http/__tests__/gates.test.ts`
Expected: All tests PASS.

- [ ] **Step 6: Run full test suite**

Run: `cd worker && npx vitest run`
Expected: No regressions. The existing integration test in `worker/src/__tests__/index.fetch.test.ts` that simulates website requests (with the Pharos Accept marker) should still pass since those are classified as `"web"`.

- [ ] **Step 7: Commit**

```bash
git add worker/src/handlers/http/gates.ts worker/src/handlers/http/request-dispatch.ts worker/src/handlers/http/cors.ts worker/src/handlers/http/__tests__/gates.test.ts
git commit -m "feat: gate external API access behind API keys"
```

---

### Task 5: Admin CRUD Endpoints

**Files:**
- Create: `worker/src/api/admin-api-keys.ts`
- Create: `worker/src/api/__tests__/admin-api-keys.test.ts`
- Modify: `shared/lib/api-endpoints.ts`
- Modify: `worker/src/route-registry.ts`

- [ ] **Step 1: Write tests for admin CRUD**

Create `worker/src/api/__tests__/admin-api-keys.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { handleAdminApiKeys, handleAdminApiKeyById } from "../admin-api-keys";

// Test: POST /api/admin/api-keys creates a key with ph_ prefix
// Test: GET /api/admin/api-keys returns all keys
// Test: PATCH /api/admin/api-keys/:id updates key fields
// Test: PATCH with isActive=false deactivates key
// Test: DELETE /api/admin/api-keys/:id removes key
// Test: POST with missing name returns 400
// Test: POST with missing ownerEmail returns 400
```

Write full test bodies using the existing mock-d1 pattern from `worker/src/api/__tests__/helpers/mock-d1.test.ts`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd worker && npx vitest run src/api/__tests__/admin-api-keys.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement admin CRUD handler**

Create `worker/src/api/admin-api-keys.ts`:

```typescript
import { errorResponse, jsonResponse, withErrorHandler } from "../lib/api-utils";
import { withAdmin } from "../lib/auth";
import { generateApiKeyId, type ApiKeyRow } from "../lib/api-keys";

interface AdminApiKeysContext {
  db: D1Database;
  request: Request;
  trustedAdmin: boolean;
}

export const handleAdminApiKeys = withErrorHandler("admin-api-keys", async (ctx: AdminApiKeysContext) => {
  return withAdmin(ctx.request, async () => {
    if (ctx.request.method === "GET") {
      return listKeys(ctx.db);
    }
    if (ctx.request.method === "POST") {
      return createKey(ctx.db, ctx.request);
    }
    return errorResponse(405, "Method not allowed");
  }, ctx.trustedAdmin);
});

async function listKeys(db: D1Database): Promise<Response> {
  const rows = await db
    .prepare("SELECT * FROM api_keys ORDER BY created_at DESC")
    .all<ApiKeyRow>();
  return jsonResponse(rows.results ?? []);
}

async function createKey(db: D1Database, request: Request): Promise<Response> {
  const body = await request.json<{
    name?: string;
    ownerEmail?: string;
    tier?: string;
    rateLimitPerSec?: number;
  }>();

  if (!body.name?.trim()) return errorResponse(400, "name is required");
  if (!body.ownerEmail?.trim()) return errorResponse(400, "ownerEmail is required");

  const id = generateApiKeyId();
  const nowSec = Math.floor(Date.now() / 1000);
  const tier = body.tier ?? "free";
  const rateLimitPerSec = body.rateLimitPerSec ?? 5;

  await db
    .prepare(
      `INSERT INTO api_keys (id, name, owner_email, tier, rate_limit_per_sec, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
    )
    .bind(id, body.name.trim(), body.ownerEmail.trim(), tier, rateLimitPerSec, nowSec)
    .run();

  return jsonResponse(
    { id, name: body.name.trim(), ownerEmail: body.ownerEmail.trim(), tier, rateLimitPerSec, isActive: true, createdAt: nowSec },
    201,
  );
}

export const handleAdminApiKeyById = withErrorHandler("admin-api-key-by-id", async (
  ctx: AdminApiKeysContext,
  keyId: string,
) => {
  return withAdmin(ctx.request, async () => {
    if (ctx.request.method === "PATCH") {
      return updateKey(ctx.db, ctx.request, keyId);
    }
    if (ctx.request.method === "DELETE") {
      return deleteKey(ctx.db, keyId);
    }
    return errorResponse(405, "Method not allowed");
  }, ctx.trustedAdmin);
});

async function updateKey(db: D1Database, request: Request, keyId: string): Promise<Response> {
  const body = await request.json<{
    name?: string;
    ownerEmail?: string;
    tier?: string;
    rateLimitPerSec?: number;
    isActive?: boolean;
  }>();

  const sets: string[] = [];
  const values: unknown[] = [];

  if (body.name !== undefined) { sets.push("name = ?"); values.push(body.name.trim()); }
  if (body.ownerEmail !== undefined) { sets.push("owner_email = ?"); values.push(body.ownerEmail.trim()); }
  if (body.tier !== undefined) { sets.push("tier = ?"); values.push(body.tier); }
  if (body.rateLimitPerSec !== undefined) { sets.push("rate_limit_per_sec = ?"); values.push(body.rateLimitPerSec); }
  if (body.isActive !== undefined) { sets.push("is_active = ?"); values.push(body.isActive ? 1 : 0); }

  if (sets.length === 0) return errorResponse(400, "No fields to update");

  values.push(keyId);
  const result = await db
    .prepare(`UPDATE api_keys SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();

  if ((result.meta?.changes ?? 0) === 0) return errorResponse(404, "API key not found");

  const updated = await db.prepare("SELECT * FROM api_keys WHERE id = ?").bind(keyId).first<ApiKeyRow>();
  return jsonResponse(updated);
}

async function deleteKey(db: D1Database, keyId: string): Promise<Response> {
  const result = await db.prepare("DELETE FROM api_keys WHERE id = ?").bind(keyId).run();
  if ((result.meta?.changes ?? 0) === 0) return errorResponse(404, "API key not found");
  return new Response(null, { status: 204 });
}
```

- [ ] **Step 4: Register admin endpoints in api-endpoints.ts**

In `shared/lib/api-endpoints.ts`, add to `ENDPOINT_DEFINITIONS`:

```typescript
{
  key: "admin-api-keys",
  path: "/api/admin/api-keys",
  methods: ["GET", "POST"],
  adminRequired: true,
  mutatingAdmin: true,
  cacheBypass: true,
},
```

Also add to `matchDynamicAdminEndpoint` a new pattern for `/api/admin/api-keys/:id`:

```typescript
const ADMIN_API_KEY_PATH_PATTERN = /^\/api\/admin\/api-keys\/(.+)$/;
```

And update `matchDynamicAdminEndpoint` to return a match for this pattern (as a new `DynamicAdminEndpointMatch` variant, or extend the type).

Alternatively, since PATCH/DELETE require a dynamic `:id` segment, register this as a dynamic route in `route-registry.ts` alongside the existing dynamic admin routes.

- [ ] **Step 5: Wire handler into route-registry.ts**

In `worker/src/route-registry.ts`:

1. Import the handler:
```typescript
import { handleAdminApiKeys, handleAdminApiKeyById } from "./api/admin-api-keys";
```

2. Add to `STATIC_ROUTES`:
```typescript
defineStaticRoute("admin-api-keys", makeAdminRoute(
  "admin-api-keys",
  (ctx) => handleAdminApiKeys(ctx),
)),
```

3. Add to `DYNAMIC_ROUTE_DEFINITIONS` for the `:id` variant:
```typescript
{
  pattern: /^\/api\/admin\/api-keys\/(.+)$/,
  handle: (routeCtx, match) => {
    const keyId = decodeURIComponent(match[1]);
    return handleAdminApiKeyById(routeCtx, keyId);
  },
},
```

Note: Since `handleAdminApiKeys` already wraps with `withAdmin`, and `defineStaticRoute` with `makeAdminRoute` also wraps, avoid double-wrapping. Either use `makeAdminRoute` OR handle auth inside the handler — not both. Follow the existing pattern (check how `handleDiscoveryCandidates` is registered vs how it handles auth internally).

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd worker && npx vitest run src/api/__tests__/admin-api-keys.test.ts`
Expected: All tests PASS.

- [ ] **Step 7: Run full test suite**

Run: `cd worker && npx vitest run`
Expected: No regressions. The reverse-check at the bottom of `route-registry.ts` will fail if the endpoint key is not registered in both `ENDPOINT_DEFINITIONS` and `STATIC_ROUTES`.

- [ ] **Step 8: Commit**

```bash
git add worker/src/api/admin-api-keys.ts worker/src/api/__tests__/admin-api-keys.test.ts shared/lib/api-endpoints.ts worker/src/route-registry.ts
git commit -m "feat: add admin CRUD endpoints for API keys"
```

---

### Task 6: Request Source Attribution Update

**Files:**
- Modify: `shared/types/request-source.ts`
- Modify: `worker/src/lib/request-source-attribution.ts`
- Modify: `worker/src/handlers/http/request-source.ts`

- [ ] **Step 1: Add "api-key" to PublicApiRequestSource type**

In `shared/types/request-source.ts`:

```typescript
// old
export type PublicApiRequestSource = "web" | "external";
// new
export type PublicApiRequestSource = "web" | "external" | "api-key";
```

- [ ] **Step 2: Update request-source recorder to accept key info**

In `worker/src/handlers/http/request-source.ts`, update `createRequestSourceRecorder` to accept an optional `apiKeyId` parameter. When present, override the source to `"api-key"`:

```typescript
export function createRequestSourceRecorder(config: {
  request: Request;
  db: D1Database;
  execCtx: ExecutionContext;
  isAdmin: boolean;
  pathname: string;
  apiKeyId?: string;
}): () => void {
  if (config.isAdmin) return () => {};
  const route = resolvePublicApiRouteMetric(config.pathname);
  if (!route) return () => {};
  const source: PublicApiRequestSource = config.apiKeyId ? "api-key" : classifyPublicApiRequestSource(config.request);
  return () => {
    config.execCtx.waitUntil(recordPublicApiRequestSource(config.db, route, source));
  };
}
```

- [ ] **Step 3: Pass apiKeyId from request-dispatch**

In `worker/src/handlers/http/request-dispatch.ts`, after the gate check resolves, extract the key ID (if present — we can derive it from the bearer token when the gate succeeded) and pass it to `createRequestSourceRecorder`.

The cleanest approach: add `apiKeyId` to the `AccessGateResult` returned by `evaluateAccessGate`. When a key passes validation, set `apiKeyId` on the result. Then pass it through.

- [ ] **Step 4: Update request-source-attribution tests**

Add a test case in `worker/src/lib/__tests__/request-source-attribution.test.ts` verifying that the `"api-key"` source value is valid and can be recorded.

- [ ] **Step 5: Run full test suite**

Run: `cd worker && npx vitest run`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add shared/types/request-source.ts worker/src/lib/request-source-attribution.ts worker/src/handlers/http/request-source.ts worker/src/handlers/http/request-dispatch.ts worker/src/lib/__tests__/request-source-attribution.test.ts
git commit -m "feat: track api-key as a distinct request source in attribution"
```

---

### Task 7: Integration Verification

**Files:** None (verification only)

- [ ] **Step 1: Worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: No lint errors.

- [ ] **Step 4: Run merge gate**

Run: `npm run test:merge-gate`
Expected: Gate passes.

- [ ] **Step 5: Local worker smoke test**

Start the worker locally:
```bash
cd worker && npx wrangler dev
```

Test scenarios:
1. **No key, external request:** `curl http://localhost:8787/api/stablecoins` → expect 401 with `"API key required"`
2. **Invalid key:** `curl -H "Authorization: Bearer ph_invalid" http://localhost:8787/api/stablecoins` → expect 401 with `"Invalid API key"`
3. **Create a key via admin** (if admin auth can be bypassed locally, or use wrangler D1 CLI to insert a row)
4. **Valid key:** `curl -H "Authorization: Bearer ph_<real_key>" http://localhost:8787/api/stablecoins` → expect 200 with rate-limit headers

---

### Task 8: Deploy Migration and Go Live

**Files:** None (ops only)

- [ ] **Step 1: Apply migration to production D1**

```bash
cd worker && npx wrangler d1 migrations apply pharos-db --remote
```

- [ ] **Step 2: Deploy worker**

Push to trigger CI/CD, or deploy manually:
```bash
cd worker && npx wrangler deploy
```

- [ ] **Step 3: Create initial API keys**

Use the admin endpoint to create keys for any known consumers who need immediate access.

- [ ] **Step 4: Monitor request-source-stats**

Watch the admin dashboard to verify:
- Website traffic continues unaffected (classified as `"web"`)
- External traffic without keys gets 401'd
- Keyed traffic shows up as `"api-key"` source
