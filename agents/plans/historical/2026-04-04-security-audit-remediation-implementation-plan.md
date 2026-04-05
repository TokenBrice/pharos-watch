# Security Audit Remediation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remediate all 7 findings (H1, H2, L1, M1, M2, M3, M4) from the 2026-04-04 security audit.

**Architecture:** Seven independent fixes applied in dependency order. H1 (timing-safe compare) must land before M4 (pepper rotation) since M4 relies on correct constant-time comparison. M2 (enforce auth mode) goes last since it changes default behavior. Everything else is independent.

**Tech Stack:** TypeScript, Cloudflare Workers, D1 (SQLite), Vitest, GitHub Actions YAML.

**Spec:** `agents/plans/2026-04-04-security-audit-remediation-plan.md`

---

## File Map

| File | Action | Task |
|------|--------|------|
| `worker/src/lib/auth.ts` | Modify | T1 |
| `worker/src/lib/__tests__/auth.test.ts` | Modify | T1 |
| `worker/src/lib/api-keys.ts` | Modify | T2, T5, T6, T7 |
| `worker/src/lib/__tests__/api-keys.test.ts` | Modify | T2, T5, T6, T7 |
| `worker/migrations/0088_api_key_audit_log.sql` | Create | T5 |
| `worker/src/api/api-key-audit-log.ts` | Create | T5 |
| `worker/src/api/__tests__/api-key-audit-log.test.ts` | Create | T5 |
| `shared/lib/api-endpoints.ts` | Modify | T5 |
| `worker/src/route-registry.ts` | Modify | T5 |
| `.github/workflows/deploy-cloudflare.yml` | Modify | T3 |
| `.github/workflows/pages-prepare.yml` | Modify | T3 |
| `.github/workflows/pages-publish.yml` | Modify | T3 |
| `.github/workflows/rebuild-pages.yml` | Modify | T3 |
| `.github/workflows/pull-request-checks.yml` | Modify | T3 |
| `.github/workflows/pages-release.yml` | Modify | T3 |
| `.github/workflows/validate-ci.yml` | Modify | T3 |
| `worker/src/lib/env.ts` | Modify | T4, T6 |
| `worker/src/lib/__tests__/env.test.ts` | Modify | T4 |
| `worker/src/handlers/http/gates.ts` | Modify | T4, T6 |
| `worker/src/__tests__/index.fetch.test.ts` | Modify | T4 |
| `worker/wrangler.toml` | Modify | T4 |
| `docs/api-reference.md` | Modify | T4 |
| `worker/migrations/0089_api_key_pepper_version.sql` | Create | T6 |

---

### Task 1: Fix `timingSafeCompare` length leak (H1)

**Files:**
- Modify: `worker/src/lib/auth.ts:142-160`
- Modify: `worker/src/lib/__tests__/auth.test.ts:164-171`

- [ ] **Step 1: Add failing test for different-length inputs**

In `worker/src/lib/__tests__/auth.test.ts`, add a new test after the existing timing-safe compare test (after line 171):

```typescript
  it("returns false for different-length strings without leaking length", async () => {
    expect(await timingSafeCompare("short", "a-much-longer-secret-value")).toBe(false);
    expect(await timingSafeCompare("a-much-longer-secret-value", "short")).toBe(false);
  });
```

- [ ] **Step 2: Run test to verify it passes with current implementation**

Run: `cd worker && npx vitest run src/lib/__tests__/auth.test.ts --reporter=verbose`

Expected: PASS (the current implementation returns false for mismatched lengths — the issue is timing, not correctness). This test documents the contract; the fix changes the implementation.

- [ ] **Step 3: Replace `timingSafeCompare` with HMAC-then-compare**

In `worker/src/lib/auth.ts`, replace lines 142-160:

```typescript
/** Timing-safe string comparison using Web Crypto API.
 *
 * HMACs both inputs with an ephemeral key so the comparison always
 * operates on fixed-length (32-byte) digests — no early return on
 * length mismatch, no timing leak on input length.
 */
export async function timingSafeCompare(a: string, b: string): Promise<boolean> {
  if (a.length === 0 || b.length === 0) {
    console.error("[auth] timingSafeCompare called with empty string — possible misconfiguration");
    return false;
  }
  const encoder = new TextEncoder();
  const ephemeralKey = await crypto.subtle.generateKey(
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const aSig = new Uint8Array(await crypto.subtle.sign("HMAC", ephemeralKey, encoder.encode(a)));
  const bSig = new Uint8Array(await crypto.subtle.sign("HMAC", ephemeralKey, encoder.encode(b)));
  let result = 0;
  for (let i = 0; i < aSig.byteLength; i++) result |= aSig[i] ^ bSig[i];
  return result === 0;
}
```

- [ ] **Step 4: Run all auth tests**

Run: `cd worker && npx vitest run src/lib/__tests__/auth.test.ts --reporter=verbose`

Expected: All tests PASS, including the new different-length test and all existing site-proxy/admin tests.

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/auth.ts worker/src/lib/__tests__/auth.test.ts
git commit -m "fix(auth): eliminate timing leak in timingSafeCompare

HMAC both inputs with an ephemeral key so the comparison always
operates on 32-byte digests regardless of input length.
Fixes audit finding H1."
```

---

### Task 2: Cap rate limit count overflow (L1)

**Files:**
- Modify: `worker/src/lib/api-keys.ts:374-382`

- [ ] **Step 1: Cap the count in the UPSERT**

In `worker/src/lib/api-keys.ts`, replace line 378:

```typescript
// Before:
//   DO UPDATE SET count = count + 1, last_seen_at = excluded.last_seen_at
// After:
     DO UPDATE SET count = MIN(count + 1, 2147483647), last_seen_at = excluded.last_seen_at
```

The full query block (lines 374-382) becomes:

```typescript
  const row = await db.prepare(
    `INSERT INTO api_key_rate_limit (api_key_id, bucket_start, count, last_seen_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(api_key_id, bucket_start)
     DO UPDATE SET count = MIN(count + 1, 2147483647), last_seen_at = excluded.last_seen_at
     RETURNING count`,
  )
    .bind(apiKeyId, bucketStart, nowSec)
    .first<{ count: number | null }>();
```

- [ ] **Step 2: Run existing rate limit test**

Run: `cd worker && npx vitest run src/lib/__tests__/api-keys.test.ts --reporter=verbose`

Expected: All tests PASS (existing rate limit test at line 368 still works since MIN(4,2147483647) = 4).

- [ ] **Step 3: Commit**

```bash
git add worker/src/lib/api-keys.ts
git commit -m "fix(api-keys): cap rate limit count to prevent integer overflow

Adds MIN(..., 2147483647) guard to the UPSERT increment.
Fixes audit finding L1."
```

---

### Task 3: Fix negative cache on API key lookup (M3)

**Files:**
- Modify: `worker/src/lib/api-keys.ts:296-330`
- Modify: `worker/src/lib/__tests__/api-keys.test.ts`

- [ ] **Step 1: Add failing test for negative cache behavior**

In `worker/src/lib/__tests__/api-keys.test.ts`, add after the last test (after line 411):

```typescript
  it("does not cache misses so newly created keys authenticate immediately", async () => {
    const pepper = "pepper";
    const secret = "abcdefghijklmnopqrstuvwxyzABCDEF";
    const secretHash = await hmacSha256Hex(pepper, secret);
    const prefix = "aabbccddeeff0011";

    // First call: prefix not found (miss)
    const dbMiss = mockD1([
      {
        match: "FROM api_keys",
        matchBinds: [prefix],
        rows: [],
        first: null,
      },
    ], { requireMatch: true });

    await expect(
      authenticateApiKey(dbMiss, `ph_live_${prefix}_${secret}`, pepper),
    ).resolves.toEqual({ kind: "invalid" });

    // Second call immediately after: prefix now exists (simulating key creation)
    const dbHit = mockD1([
      {
        match: "FROM api_keys",
        matchBinds: [prefix],
        rows: [{
          id: 99,
          key_prefix: prefix,
          secret_hash: secretHash,
          name: "Just Created",
          owner_email: null,
          tier: "standard",
          traffic_class: "external",
          rate_limit_per_minute: 120,
          is_active: 1,
          expires_at: null,
          created_at: 1_000,
          updated_at: 1_000,
          last_used_at: null,
          last_used_route: null,
        }],
      },
    ], { requireMatch: true });

    // Must hit DB again (not return cached null)
    await expect(
      authenticateApiKey(dbHit, `ph_live_${prefix}_${secret}`, pepper),
    ).resolves.toMatchObject({ kind: "valid" });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run src/lib/__tests__/api-keys.test.ts -t "does not cache misses" --reporter=verbose`

Expected: FAIL — the current implementation caches the null result, so the second call returns `{ kind: "invalid" }` instead of `{ kind: "valid" }`.

- [ ] **Step 3: Skip caching misses in `lookupApiKeyByPrefix`**

In `worker/src/lib/api-keys.ts`, replace lines 325-328:

```typescript
  // Before:
  // apiKeyCache.set(keyPrefix, {
  //   cacheExpiresAt: now + API_KEY_CACHE_TTL_MS,
  //   row,
  // });

  // After: only cache positive hits to avoid blocking newly created keys
  if (row) {
    apiKeyCache.set(keyPrefix, {
      cacheExpiresAt: now + API_KEY_CACHE_TTL_MS,
      row,
    });
  }
```

- [ ] **Step 4: Run all API key tests**

Run: `cd worker && npx vitest run src/lib/__tests__/api-keys.test.ts --reporter=verbose`

Expected: All tests PASS including the new negative-cache test.

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/api-keys.ts worker/src/lib/__tests__/api-keys.test.ts
git commit -m "fix(api-keys): skip caching misses to unblock newly created keys

Negative cache entries blocked authentication of keys created within
the 5-second TTL window. Only cache positive hits since brute-force
is already bounded by IP rate limiting at the gate level.
Fixes audit finding M3."
```

---

### Task 4: Add explicit workflow permissions (M1)

**Files:**
- Modify: `.github/workflows/deploy-cloudflare.yml`
- Modify: `.github/workflows/pages-prepare.yml`
- Modify: `.github/workflows/pages-publish.yml`
- Modify: `.github/workflows/rebuild-pages.yml`
- Modify: `.github/workflows/pull-request-checks.yml`
- Modify: `.github/workflows/pages-release.yml`
- Modify: `.github/workflows/validate-ci.yml`

- [ ] **Step 1: Add permissions to `deploy-cloudflare.yml`**

After the `concurrency:` block (after line 9), before `jobs:`, add:

```yaml
permissions:
  contents: read
```

- [ ] **Step 2: Add permissions to all other workflows missing them**

For each of the following files, add `permissions:\n  contents: read` after the `on:` block and before `jobs:`:

- `.github/workflows/pages-prepare.yml`
- `.github/workflows/pages-publish.yml`
- `.github/workflows/rebuild-pages.yml`
- `.github/workflows/pull-request-checks.yml`
- `.github/workflows/pages-release.yml`
- `.github/workflows/validate-ci.yml`

Each file follows the same pattern: insert the `permissions:` block between the trigger config and the `jobs:` key. Use the existing patterns in `secret-scan.yml` and `dependency-audit.yml` as reference.

- [ ] **Step 3: Validate YAML syntax**

Run: `for f in .github/workflows/*.yml; do python3 -c "import yaml; yaml.safe_load(open('$f'))" && echo "OK: $f" || echo "FAIL: $f"; done`

Expected: All files report OK.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/
git commit -m "ci: add explicit minimal permissions to all workflows

Adds permissions: { contents: read } to the 7 workflows that lacked
explicit permission blocks. Reduces blast radius of compromised runners.
Fixes audit finding M1."
```

---

### Task 5: Add API key audit logging (H2)

**Files:**
- Create: `worker/migrations/0088_api_key_audit_log.sql`
- Modify: `worker/src/lib/api-keys.ts`
- Modify: `worker/src/lib/__tests__/api-keys.test.ts`
- Create: `worker/src/api/api-key-audit-log.ts`
- Create: `worker/src/api/__tests__/api-key-audit-log.test.ts`
- Modify: `shared/lib/api-endpoints.ts`
- Modify: `worker/src/route-registry.ts`
- Modify: `worker/migrations/MANIFEST.md`

#### Part A: Migration

- [ ] **Step 1: Create the migration file**

Create `worker/migrations/0088_api_key_audit_log.sql`:

```sql
-- rollout-safety: backward-compatible

CREATE TABLE IF NOT EXISTS api_key_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key_id INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('created', 'updated', 'deactivated', 'rotated')),
  actor TEXT NOT NULL DEFAULT 'admin',
  detail_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_key_audit_log_key
  ON api_key_audit_log(api_key_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_api_key_audit_log_recent
  ON api_key_audit_log(created_at DESC);
```

- [ ] **Step 2: Update migration manifest**

In `worker/migrations/MANIFEST.md`, add the new entry following the existing format:

```markdown
| 0088 | api_key_audit_log | Audit log for API key mutations |
```

- [ ] **Step 3: Commit migration**

```bash
git add worker/migrations/0088_api_key_audit_log.sql worker/migrations/MANIFEST.md
git commit -m "feat(schema): add api_key_audit_log table

Tracks create, update, deactivate, and rotate events for API keys
with admin actor and optional detail JSON.
Part of audit finding H2."
```

#### Part B: Audit recording in api-keys.ts

- [ ] **Step 4: Add the audit recording function and type**

In `worker/src/lib/api-keys.ts`, add after the `recordApiKeyUsage` function (after line 431):

```typescript
export type ApiKeyAuditAction = "created" | "updated" | "deactivated" | "rotated";

export async function recordApiKeyAudit(
  db: ApiKeyDb,
  apiKeyId: number,
  action: ApiKeyAuditAction,
  detail?: Record<string, unknown>,
  nowSec = getNowSec(),
): Promise<void> {
  await db.prepare(
    `INSERT INTO api_key_audit_log (api_key_id, action, actor, detail_json, created_at)
     VALUES (?, ?, 'admin', ?, ?)`,
  )
    .bind(apiKeyId, action, detail ? JSON.stringify(detail) : null, nowSec)
    .run();
}
```

- [ ] **Step 5: Insert audit calls in each mutation**

In `createApiKey` (around line 667, after the cache clear and before the return):

```typescript
  clearApiKeyCache(material.keyPrefix);
  await recordApiKeyAudit(db, createdRow.id, "created", { name: parsed.name, tier: parsed.tier ?? "standard" }, nowSec);
  return {
```

In `updateApiKey` (around line 716, after `clearApiKeyCache` and `apiKeyLastUsageUpdateById.delete`):

```typescript
  clearApiKeyCache(existing.key_prefix);
  apiKeyLastUsageUpdateById.delete(id);
  await recordApiKeyAudit(db, id, "updated", parsed as Record<string, unknown>, nowSec);
  const updated = await selectPublicApiKeyById(db, id);
```

In `deactivateApiKey` (around line 740, after `clearApiKeyCache` and `apiKeyLastUsageUpdateById.delete`):

```typescript
  clearApiKeyCache(existing.key_prefix);
  apiKeyLastUsageUpdateById.delete(id);
  await recordApiKeyAudit(db, id, "deactivated", undefined, nowSec);
  const updated = await selectPublicApiKeyById(db, id);
```

In `rotateApiKey` (around line 783, after both cache clears and usage delete):

```typescript
  clearApiKeyCache(existing.key_prefix);
  clearApiKeyCache(material.keyPrefix);
  apiKeyLastUsageUpdateById.delete(id);
  await recordApiKeyAudit(db, id, "rotated", undefined, nowSec);
  const updated = await selectPublicApiKeyById(db, id);
```

- [ ] **Step 6: Add test for audit recording**

In `worker/src/lib/__tests__/api-keys.test.ts`, add a new test:

```typescript
  it("records an audit log entry when creating a key", async () => {
    const db = mockD1([
      {
        match: "INSERT INTO api_keys",
        first: {
          id: 5,
          key_prefix: "fedcba9876543210",
          name: "Audited",
          owner_email: null,
          tier: "standard",
          traffic_class: "external",
          rate_limit_per_minute: 120,
          is_active: 1,
          expires_at: 333 + (90 * 24 * 60 * 60),
          created_at: 333,
          updated_at: 333,
          last_used_at: null,
          last_used_route: null,
        },
        rows: [],
      },
      {
        match: "INSERT INTO api_key_audit_log",
        rows: [],
        runMeta: { changes: 1 },
      },
    ], { requireMatch: true });

    const created = await createApiKey(db, "pepper", { name: "Audited" }, 333);
    expect(created).not.toBeInstanceOf(Response);

    const auditInsert = db.getHistory().find((entry) => entry.sql.includes("api_key_audit_log"));
    expect(auditInsert).toBeDefined();
    expect(auditInsert?.binds[0]).toBe(5);
    expect(auditInsert?.binds[1]).toBe("created");
  });
```

- [ ] **Step 7: Run tests**

Run: `cd worker && npx vitest run src/lib/__tests__/api-keys.test.ts --reporter=verbose`

Expected: All tests PASS.

- [ ] **Step 8: Commit**

```bash
git add worker/src/lib/api-keys.ts worker/src/lib/__tests__/api-keys.test.ts
git commit -m "feat(api-keys): record audit log for all key mutations

Inserts a row into api_key_audit_log on create, update, deactivate,
and rotate with the action type and optional detail JSON.
Part of audit finding H2."
```

#### Part C: Audit log query endpoint

- [ ] **Step 9: Register endpoint definition**

In `shared/lib/api-endpoints.ts`, add a new entry in the admin endpoints section (after the `api-keys` entry around line 491):

```typescript
  {
    key: "api-key-audit-log",
    path: "/api/api-keys/audit-log",
    methods: ["GET"],
    adminRequired: true,
    mutatingAdmin: false,
    cacheBypass: true,
  },
```

Also add `"api-key-audit-log"` to the `EndpointKey` type union (find the type definition and add it).

- [ ] **Step 10: Create the handler**

Create `worker/src/api/api-key-audit-log.ts`:

```typescript
import { withAdmin } from "../lib/auth";
import { jsonResponse, withErrorHandler } from "../lib/api-utils";

interface AuditLogRow {
  id: number;
  api_key_id: number;
  action: string;
  actor: string;
  detail_json: string | null;
  created_at: number;
}

const AUDIT_LOG_DEFAULT_LIMIT = 50;
const AUDIT_LOG_MAX_LIMIT = 200;

export const handleApiKeyAuditLog = withErrorHandler(
  "api-key-audit-log",
  async (db: D1Database, trustedAdmin: boolean = false, request?: Request): Promise<Response> => {
    return withAdmin(request, async () => {
      const url = new URL(request!.url);
      const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
      const limit = Number.isFinite(limitParam) && limitParam > 0
        ? Math.min(limitParam, AUDIT_LOG_MAX_LIMIT)
        : AUDIT_LOG_DEFAULT_LIMIT;

      const apiKeyIdParam = url.searchParams.get("apiKeyId");
      const apiKeyId = apiKeyIdParam ? Number.parseInt(apiKeyIdParam, 10) : null;

      let rows: AuditLogRow[];
      if (apiKeyId && Number.isFinite(apiKeyId) && apiKeyId > 0) {
        const result = await db.prepare(
          `SELECT id, api_key_id, action, actor, detail_json, created_at
           FROM api_key_audit_log
           WHERE api_key_id = ?
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
        )
          .bind(apiKeyId, limit)
          .all<AuditLogRow>();
        rows = result.results ?? [];
      } else {
        const result = await db.prepare(
          `SELECT id, api_key_id, action, actor, detail_json, created_at
           FROM api_key_audit_log
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
        )
          .bind(limit)
          .all<AuditLogRow>();
        rows = result.results ?? [];
      }

      const entries = rows.map((row) => ({
        id: row.id,
        apiKeyId: row.api_key_id,
        action: row.action,
        actor: row.actor,
        detail: row.detail_json ? JSON.parse(row.detail_json) : null,
        createdAt: row.created_at,
      }));

      return jsonResponse({ entries }, { "Cache-Control": "no-store" });
    }, trustedAdmin);
  },
);
```

- [ ] **Step 11: Register route in route-registry.ts**

In `worker/src/route-registry.ts`, add the import at the top (with the other api imports):

```typescript
import { handleApiKeyAuditLog } from "./api/api-key-audit-log";
```

In the `STATIC_ROUTES` array, add after the `api-keys` entry (after line 210):

```typescript
  defineStaticRoute("api-key-audit-log", ({ db, trustedAdmin, request }) =>
    handleApiKeyAuditLog(db, trustedAdmin, request)),
```

- [ ] **Step 12: Write handler test**

Create `worker/src/api/__tests__/api-key-audit-log.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { handleApiKeyAuditLog } from "../api-key-audit-log";

describe("api-key-audit-log handler", () => {
  it("requires admin auth", async () => {
    const db = mockD1([]);
    const request = new Request("https://api.pharos.watch/api/api-keys/audit-log");
    const response = await handleApiKeyAuditLog(db, false, request);
    expect(response.status).toBe(401);
  });

  it("returns recent audit entries", async () => {
    const db = mockD1([
      {
        match: "FROM api_key_audit_log",
        rows: [
          {
            id: 1,
            api_key_id: 7,
            action: "created",
            actor: "admin",
            detail_json: '{"name":"Smoke"}',
            created_at: 1000,
          },
        ],
      },
    ]);

    const request = new Request("https://api.pharos.watch/api/api-keys/audit-log");
    const response = await handleApiKeyAuditLog(db, true, request);
    expect(response.status).toBe(200);

    const body = await response.json() as { entries: Array<{ action: string; detail: unknown }> };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]?.action).toBe("created");
    expect(body.entries[0]?.detail).toEqual({ name: "Smoke" });
  });

  it("filters by apiKeyId when provided", async () => {
    const db = mockD1([
      {
        match: "WHERE api_key_id = ?",
        matchBinds: [7, 50],
        rows: [],
      },
    ], { requireMatch: true });

    const request = new Request("https://api.pharos.watch/api/api-keys/audit-log?apiKeyId=7");
    const response = await handleApiKeyAuditLog(db, true, request);
    expect(response.status).toBe(200);
  });
});
```

- [ ] **Step 13: Run tests**

Run: `cd worker && npx vitest run src/api/__tests__/api-key-audit-log.test.ts --reporter=verbose`

Expected: All tests PASS.

- [ ] **Step 14: Run full test suite and type-check**

Run: `cd worker && npx tsc --noEmit && cd .. && npm test`

Expected: No type errors, all tests PASS.

- [ ] **Step 15: Commit**

```bash
git add worker/src/api/api-key-audit-log.ts worker/src/api/__tests__/api-key-audit-log.test.ts shared/lib/api-endpoints.ts worker/src/route-registry.ts
git commit -m "feat(api): add admin endpoint for API key audit log

GET /api/api-keys/audit-log returns recent mutation events.
Supports limit and apiKeyId query parameters.
Completes audit finding H2."
```

---

### Task 6: Add pepper rotation strategy (M4)

**Files:**
- Create: `worker/migrations/0089_api_key_pepper_version.sql`
- Modify: `worker/src/lib/env.ts`
- Modify: `worker/src/lib/api-keys.ts`
- Modify: `worker/src/lib/__tests__/api-keys.test.ts`
- Modify: `worker/src/handlers/http/gates.ts`
- Modify: `worker/migrations/MANIFEST.md`

#### Part A: Migration and env

- [ ] **Step 1: Create the migration file**

Create `worker/migrations/0089_api_key_pepper_version.sql`:

```sql
-- rollout-safety: backward-compatible

ALTER TABLE api_keys ADD COLUMN pepper_version INTEGER NOT NULL DEFAULT 1;
```

- [ ] **Step 2: Update migration manifest**

In `worker/migrations/MANIFEST.md`, add:

```markdown
| 0089 | api_key_pepper_version | Pepper version tracking for zero-downtime rotation |
```

- [ ] **Step 3: Add `API_KEY_HASH_PEPPER_PREVIOUS` to env**

In `worker/src/lib/env.ts`, add to the `Env` interface (after `API_KEY_HASH_PEPPER`):

```typescript
  API_KEY_HASH_PEPPER_PREVIOUS?: string;
```

Add to `WORKER_OPTIONAL_ENV_KEYS` array (after `"API_KEY_HASH_PEPPER"`):

```typescript
  "API_KEY_HASH_PEPPER_PREVIOUS",
```

Add validation in `validateWorkerEnvContract` (after the existing pepper warning, around line 260):

```typescript
  if (
    hasConfiguredValue(env.API_KEY_HASH_PEPPER_PREVIOUS) &&
    hasConfiguredValue(env.API_KEY_HASH_PEPPER) &&
    env.API_KEY_HASH_PEPPER_PREVIOUS?.trim() === env.API_KEY_HASH_PEPPER?.trim()
  ) {
    issues.push({
      code: "api-key-pepper-noop-rotation",
      message: "API_KEY_HASH_PEPPER_PREVIOUS is identical to API_KEY_HASH_PEPPER — this is a no-op rotation.",
    });
  }
```

Also add `"api-key-pepper-noop-rotation"` to the `WorkerEnvIssue["code"]` union type (around line 107).

Update the `validateWorkerEnvContract` Pick type to include `"API_KEY_HASH_PEPPER_PREVIOUS"`.

- [ ] **Step 4: Commit migration and env**

```bash
git add worker/migrations/0089_api_key_pepper_version.sql worker/migrations/MANIFEST.md worker/src/lib/env.ts
git commit -m "feat(schema): add pepper_version column and previous pepper env var

Tracks which pepper version was used to hash each API key's secret,
enabling zero-downtime pepper rotation.
Part of audit finding M4."
```

#### Part B: Dual-pepper auth with opportunistic re-hash

- [ ] **Step 5: Add failing test for previous-pepper authentication**

In `worker/src/lib/__tests__/api-keys.test.ts`, add:

```typescript
  it("authenticates with previous pepper and opportunistically re-hashes", async () => {
    const oldPepper = "old-pepper";
    const newPepper = "new-pepper";
    const secret = "abcdefghijklmnopqrstuvwxyzABCDEF";
    const oldSecretHash = await hmacSha256Hex(oldPepper, secret);
    const prefix = "0123456789abcdef";

    const db = mockD1([
      {
        match: "FROM api_keys",
        matchBinds: [prefix],
        rows: [{
          id: 7,
          key_prefix: prefix,
          secret_hash: oldSecretHash,
          name: "Legacy",
          owner_email: null,
          tier: "standard",
          traffic_class: "external",
          rate_limit_per_minute: 120,
          is_active: 1,
          expires_at: null,
          created_at: 1,
          updated_at: 1,
          last_used_at: null,
          last_used_route: null,
          pepper_version: 1,
        }],
      },
      {
        match: "UPDATE api_keys SET secret_hash",
        rows: [],
        runMeta: { changes: 1 },
      },
    ], { requireMatch: true });

    const result = await authenticateApiKey(
      db,
      `ph_live_${prefix}_${secret}`,
      newPepper,
      oldPepper,
      1_000,
    );

    expect(result).toMatchObject({ kind: "valid" });

    // Verify the re-hash UPDATE was issued
    const rehashQuery = db.getHistory().find((entry) =>
      entry.sql.includes("UPDATE api_keys SET secret_hash"),
    );
    expect(rehashQuery).toBeDefined();
    expect(rehashQuery?.binds[0]).toBe(await hmacSha256Hex(newPepper, secret));
  });
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd worker && npx vitest run src/lib/__tests__/api-keys.test.ts -t "authenticates with previous pepper" --reporter=verbose`

Expected: FAIL — `authenticateApiKey` doesn't accept a `pepperPrevious` parameter yet.

- [ ] **Step 7: Update `authenticateApiKey` to support dual-pepper**

In `worker/src/lib/api-keys.ts`, modify the `authenticateApiKey` function signature and body. Replace lines 332-365:

```typescript
export async function authenticateApiKey(
  db: ApiKeyDb,
  apiKeyHeader: string | null,
  pepper: string | undefined,
  pepperPrevious?: string,
  nowSec = getNowSec(),
): Promise<ApiKeyAuthenticationResult> {
  const parsed = parseApiKeyToken(apiKeyHeader);
  if (!parsed) {
    return apiKeyHeader?.trim() ? { kind: "invalid" } : { kind: "missing" };
  }

  const effectivePepper = pepper?.trim();
  if (!effectivePepper) {
    return { kind: "unavailable" };
  }

  const row = await lookupApiKeyByPrefix(db, parsed.prefix);
  if (!row || row.is_active !== 1) {
    return { kind: "invalid" };
  }
  if (row.expires_at != null && row.expires_at <= nowSec) {
    return { kind: "invalid" };
  }

  const expectedHash = await hmacSha256Hex(effectivePepper, parsed.secret);
  if (await timingSafeCompare(expectedHash, row.secret_hash)) {
    return {
      kind: "valid",
      key: mapRowToAuthenticatedKey(row),
    };
  }

  // Try previous pepper for zero-downtime rotation
  const effectivePreviousPepper = pepperPrevious?.trim();
  if (effectivePreviousPepper) {
    const previousHash = await hmacSha256Hex(effectivePreviousPepper, parsed.secret);
    if (await timingSafeCompare(previousHash, row.secret_hash)) {
      // Opportunistic re-hash: migrate this key to the current pepper
      await db.prepare(
        "UPDATE api_keys SET secret_hash = ?, pepper_version = pepper_version + 1, updated_at = ? WHERE id = ?",
      )
        .bind(expectedHash, nowSec, row.id)
        .run();
      clearApiKeyCache(parsed.prefix);
      return {
        kind: "valid",
        key: mapRowToAuthenticatedKey(row),
      };
    }
  }

  return { kind: "invalid" };
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd worker && npx vitest run src/lib/__tests__/api-keys.test.ts --reporter=verbose`

Expected: All tests PASS. The existing tests pass `undefined` as `pepperPrevious` implicitly (it's optional).

- [ ] **Step 9: Update callers to pass `pepperPrevious`**

In `worker/src/handlers/http/gates.ts`, update the `authenticateApiKey` call (around line 95-99):

```typescript
    const apiKeyAuth = await authenticateApiKey(
      env.DB,
      request.headers.get("X-API-Key"),
      env.API_KEY_HASH_PEPPER,
      env.API_KEY_HASH_PEPPER_PREVIOUS,
    );
```

Note: Only `gates.ts` calls `authenticateApiKey` — the route context and `ApiKeysRouteFields` do not need updating because `rotateApiKey` and `createApiKey` only use the current pepper.

- [ ] **Step 10: Run type-check and full tests**

Run: `cd worker && npx tsc --noEmit && cd .. && npm test`

Expected: No type errors, all tests PASS.

- [ ] **Step 11: Commit**

```bash
git add worker/src/lib/api-keys.ts worker/src/lib/__tests__/api-keys.test.ts worker/src/handlers/http/gates.ts
git commit -m "feat(api-keys): support dual-pepper authentication with opportunistic re-hash

When API_KEY_HASH_PEPPER is rotated, existing keys hashed with the
previous pepper still authenticate. On successful auth with the old
pepper, the secret is re-hashed with the current pepper in-place.
Fixes audit finding M4."
```

---

### Task 7: Switch to enforce auth mode (M2)

**Files:**
- Modify: `worker/src/lib/env.ts:188-196`
- Modify: `worker/src/lib/__tests__/env.test.ts`
- Modify: `worker/src/handlers/http/gates.ts:112-128`
- Modify: `worker/src/__tests__/index.fetch.test.ts`
- Modify: `worker/wrangler.toml`
- Modify: `docs/api-reference.md`

#### Part A: Change the default

- [ ] **Step 1: Add failing test for new default**

In `worker/src/lib/__tests__/env.test.ts`, find the test for `resolvePublicApiAuthMode` and add or update:

```typescript
  it("defaults to enforce when PUBLIC_API_AUTH_MODE is not set", () => {
    expect(resolvePublicApiAuthMode({})).toBe("enforce");
    expect(resolvePublicApiAuthMode({ PUBLIC_API_AUTH_MODE: undefined })).toBe("enforce");
    expect(resolvePublicApiAuthMode({ PUBLIC_API_AUTH_MODE: "" })).toBe("enforce");
  });

  it("allows explicit off as an escape hatch", () => {
    expect(resolvePublicApiAuthMode({ PUBLIC_API_AUTH_MODE: "off" })).toBe("off");
  });

  it("accepts report-only as a valid mode", () => {
    expect(resolvePublicApiAuthMode({ PUBLIC_API_AUTH_MODE: "report-only" })).toBe("report-only");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run src/lib/__tests__/env.test.ts -t "defaults to enforce" --reporter=verbose`

Expected: FAIL — current default is `"off"`.

- [ ] **Step 3: Change the default in `resolvePublicApiAuthMode`**

In `worker/src/lib/env.ts`, replace lines 188-196:

```typescript
export function resolvePublicApiAuthMode(
  env: Pick<Env, "PUBLIC_API_AUTH_MODE">,
): PublicApiAuthMode {
  const raw = getConfiguredValue(env.PUBLIC_API_AUTH_MODE)?.toLowerCase();
  if (raw === "off" || raw === "report-only") {
    return raw;
  }
  return "enforce";
}
```

- [ ] **Step 4: Run env tests**

Run: `cd worker && npx vitest run src/lib/__tests__/env.test.ts --reporter=verbose`

Expected: All tests PASS with new default.

- [ ] **Step 5: Commit default change**

```bash
git add worker/src/lib/env.ts worker/src/lib/__tests__/env.test.ts
git commit -m "feat(auth): default PUBLIC_API_AUTH_MODE to enforce

Protected public API endpoints now require API key authentication by
default. Operators can still set mode to off as an escape hatch.
Part of audit finding M2."
```

#### Part B: Clean up report-only passthrough in gates

- [ ] **Step 6: Update gates to reject on both enforce and report-only**

In `worker/src/handlers/http/gates.ts`, replace lines 112-129 (the enforce + report-only blocks):

```typescript
    if (authMode !== "off") {
      if (apiKeyAuth.kind === "unavailable") {
        return {
          isAdmin,
          isSiteProxy: false,
          apiKey: null,
          requestLane: "public-api",
          response: errorResponse(503, "Public API temporarily unavailable"),
        };
      }
      if (authMode === "report-only" && apiKeyAuth.kind !== "missing") {
        console.warn(`[public-api-auth] rejected ${apiKeyAuth.kind} request on ${url.pathname}`);
      }
      return { isAdmin, isSiteProxy: false, apiKey: null, requestLane: "public-api", response: errorResponse(401, "Unauthorized") };
    }
```

This treats `report-only` identically to `enforce` (rejects the request) but also logs the rejection for observability.

- [ ] **Step 7: Add explicit `PUBLIC_API_AUTH_MODE` to wrangler.toml**

In `worker/wrangler.toml`, add to the `[vars]` section:

```toml
PUBLIC_API_AUTH_MODE = "enforce"
```

- [ ] **Step 8: Update index.fetch tests for new default behavior**

In `worker/src/__tests__/index.fetch.test.ts`, find any tests that expect unauthenticated public API requests to succeed and update them. Tests that hit protected endpoints without an API key should now expect 401 instead of 200.

Look for patterns like:
```typescript
// If there's a test fetching /api/stablecoins without API key expecting 200,
// update it to expect 401 or add API_KEY_HASH_PEPPER + valid key to the env
```

If the existing tests already mock `PUBLIC_API_AUTH_MODE` or set it explicitly, verify they still pass. If tests pass `PUBLIC_API_AUTH_MODE: undefined` and expect the request to succeed, they need updating.

- [ ] **Step 9: Update docs/api-reference.md**

Add a note near the top of the authentication section:

```markdown
All protected API endpoints require authentication via the `X-API-Key` header.
Requests without a valid API key receive a `401 Unauthorized` response.
```

- [ ] **Step 10: Run full test suite and type-check**

Run: `cd worker && npx tsc --noEmit && cd .. && npm test`

Expected: All tests PASS, no type errors.

- [ ] **Step 11: Commit**

```bash
git add worker/src/handlers/http/gates.ts worker/wrangler.toml worker/src/__tests__/index.fetch.test.ts docs/api-reference.md
git commit -m "feat(auth): enforce API key authentication on protected endpoints

report-only mode now rejects (with logging) instead of passing through.
wrangler.toml explicitly sets enforce as the production mode.
Completes audit finding M2."
```

---

## Final Validation

- [ ] **Run the merge gate**

```bash
npm run test:merge-gate
```

Expected: All checks pass (lint, type-check, tests, build, SEO gate).

- [ ] **Create summary commit or tag**

If all tasks are committed individually, no summary commit needed. Optionally tag the completion:

```bash
git tag -a security-audit-2026-04-04 -m "Complete remediation of 7 security audit findings"
```
