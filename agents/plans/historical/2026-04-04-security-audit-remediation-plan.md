# Security Audit Remediation — Design Spec

**Date**: 2026-04-04
**Scope**: 7 findings from the comprehensive Pharos security audit
**Status**: Approved for implementation

---

## Findings Index

| ID | Severity | Title | Approach |
|----|----------|-------|----------|
| H1 | HIGH | `timingSafeCompare` leaks secret length | HMAC-then-compare |
| H2 | HIGH | No audit logging for API key mutations | New D1 table + admin endpoint |
| M1 | MEDIUM | Deploy workflows lack explicit permissions | Add `permissions:` blocks |
| M2 | MEDIUM | Switch public API auth to `enforce` mode | Default change + cleanup |
| M3 | MEDIUM | Negative cache blocks newly created keys | Skip caching misses |
| M4 | MEDIUM | No pepper rotation strategy | Dual-pepper with version column |
| L1 | LOW | Rate limit count overflow | Cap in UPSERT |

---

## H1 — Fix `timingSafeCompare` length leak

**File**: `worker/src/lib/auth.ts:142-160`

**Problem**: Early return on `aBuf.byteLength !== bBuf.byteLength` (line 150) leaks whether the attacker's string matches the secret's byte length. In the API key path this is a non-issue (both sides are HMAC hex digests, always 64 chars), but in the site-proxy path (`auth.ts:98-99`) the attacker-controlled `presentedSecret` is compared directly against `SITE_API_SHARED_SECRET`.

**Fix**: Replace the early-return length check with an HMAC-then-compare approach. HMAC both inputs with an ephemeral key so both digests are always 32 bytes, regardless of input length. The comparison loop then runs in constant time.

```typescript
export async function timingSafeCompare(a: string, b: string): Promise<boolean> {
  if (a.length === 0 || b.length === 0) {
    console.error("[auth] timingSafeCompare called with empty string — possible misconfiguration");
    return false;
  }
  const encoder = new TextEncoder();
  // Generate ephemeral HMAC key so both digests are always 32 bytes
  const ephemeralKey = await crypto.subtle.generateKey(
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const aSig = new Uint8Array(await crypto.subtle.sign("HMAC", ephemeralKey, encoder.encode(a)));
  const bSig = new Uint8Array(await crypto.subtle.sign("HMAC", ephemeralKey, encoder.encode(b)));
  // Both are exactly 32 bytes — no length leak
  let result = 0;
  for (let i = 0; i < aSig.byteLength; i++) result |= aSig[i] ^ bSig[i];
  return result === 0;
}
```

**Tests**: Update `worker/src/lib/__tests__/auth.test.ts`:
- Add test: different-length strings still return false without timing leak
- Add test: same-length wrong strings return false
- Existing tests should still pass (API contract unchanged)

---

## H2 — API key audit logging

**Problem**: Create, update, deactivate, rotate operations on API keys have no audit trail.

### Schema

**New migration** `worker/migrations/0088_api_key_audit_log.sql`:

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

### Implementation

**File**: `worker/src/lib/api-keys.ts`

Add a new function:

```typescript
type ApiKeyAuditAction = "created" | "updated" | "deactivated" | "rotated";

async function recordApiKeyAudit(
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

Insert calls after each mutation:
- `createApiKey`: `recordApiKeyAudit(db, createdRow.id, "created", { name: parsed.name })`
- `updateApiKey`: `recordApiKeyAudit(db, id, "updated", parsed)` (log which fields changed)
- `deactivateApiKey`: `recordApiKeyAudit(db, id, "deactivated")`
- `rotateApiKey`: `recordApiKeyAudit(db, id, "rotated")`

### Query endpoint

**New admin endpoint**: `GET /api/api-keys/audit-log`

- Query params: `limit` (default 50, max 200), `apiKeyId` (optional filter)
- Returns: `{ entries: [{ id, apiKeyId, action, actor, detailJson, createdAt }] }`
- Admin-only (wrapped with `withAdmin`)

This requires:
1. New endpoint key `"api-key-audit-log"` in `shared/lib/api-endpoints.ts`
2. New handler `worker/src/api/api-key-audit-log.ts`
3. Registration in `worker/src/route-registry.ts`

### Tests

- `worker/src/lib/__tests__/api-keys.test.ts`: Verify audit rows are inserted for each mutation
- `worker/src/api/__tests__/api-key-audit-log.test.ts`: Verify admin gate, pagination, filtering

---

## M1 — Add explicit workflow permissions

**Problem**: 7 of 10 GitHub workflows lack `permissions:` blocks, inheriting potentially broad defaults.

**Fix**: Add minimal `permissions:` at the workflow level for each:

| Workflow | Permissions |
|----------|------------|
| `deploy-cloudflare.yml` | `contents: read` (jobs use secrets for CF deploy, not GitHub API) |
| `pages-prepare.yml` | `contents: read` |
| `pages-publish.yml` | `contents: read` |
| `rebuild-pages.yml` | `contents: read` |
| `pull-request-checks.yml` | `contents: read` |
| `pages-release.yml` | `contents: read` |
| `validate-ci.yml` | `contents: read` (already correct pattern) |

For `validate-ci.yml`: it already works without explicit permissions so verify it doesn't need more than `contents: read`. The other workflows that already have permissions (`dependency-audit.yml`, `codeql.yml`, `secret-scan.yml`) are left as-is.

**Implementation**: Add after the `on:` block in each workflow:

```yaml
permissions:
  contents: read
```

---

## M2 — Switch to `enforce` auth mode

**Problem**: `PUBLIC_API_AUTH_MODE` defaults to `"off"`, allowing unauthenticated access to protected public API endpoints.

### Code changes

1. **`worker/src/lib/env.ts:188-196`** — Change default from `"off"` to `"enforce"`:

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

2. **`worker/wrangler.toml`** — Add explicit var for documentation clarity:

```toml
PUBLIC_API_AUTH_MODE = "enforce"
```

3. **`worker/src/handlers/http/gates.ts:126-128`** — Remove the `report-only` passthrough code:

```typescript
// Remove this block:
// if (authMode === "report-only" && apiKeyAuth.kind !== "missing") {
//   console.warn(`[public-api-auth] protected request ${apiKeyAuth.kind} on ${url.pathname}`);
// }
```

4. **`worker/src/lib/env.ts:247-253`** — Update env validation to warn when mode is `"off"`:

```typescript
if (resolvePublicApiAuthMode(env) === "off" && hasConfiguredValue(env.API_KEY_HASH_PEPPER)) {
  issues.push({
    code: "public-api-auth-mode-degraded",
    message: "PUBLIC_API_AUTH_MODE is off but API_KEY_HASH_PEPPER is configured. Consider switching to enforce.",
  });
}
```

5. **Remove `"report-only"` from `PublicApiAuthMode`** type — it's dead code after enforcement. Keep `"off"` as an escape hatch.

Actually, keep `"report-only"` in the type for now since it's still a valid setting operators can choose. Just remove the special passthrough behavior in gates.ts (report-only should behave the same as enforce — reject the request).

Revised: `report-only` stays as a type but gates.ts treats it identically to `enforce` (both reject unauthenticated). The only behavioral difference is: report-only logs a warning before rejecting.

6. **Update `docs/api-reference.md`** — Note that API keys are now required for protected endpoints.

### Tests

- Update `worker/src/__tests__/index.fetch.test.ts`: verify protected endpoints return 401 without API key when mode is not explicitly set (testing new default)
- Update `worker/src/lib/__tests__/env.test.ts`: verify default is now `"enforce"`

---

## M3 — Fix negative cache on API key lookup

**File**: `worker/src/lib/api-keys.ts:296-330`

**Problem**: `lookupApiKeyByPrefix` caches null results for 5 seconds. A key prefix looked up before creation blocks authentication of the newly created key for up to 5s.

**Fix**: Only cache positive hits. Change line 325-328:

```typescript
// Before:
apiKeyCache.set(keyPrefix, {
  cacheExpiresAt: now + API_KEY_CACHE_TTL_MS,
  row,
});

// After:
if (row) {
  apiKeyCache.set(keyPrefix, {
    cacheExpiresAt: now + API_KEY_CACHE_TTL_MS,
    row,
  });
}
```

The brute-force concern (repeated lookups for non-existent prefixes) is already mitigated by IP-based rate limiting at the gate level. Non-existent key lookups from rate-limited IPs are bounded to `PUBLIC_API_RATE_LIMIT_MAX_REQUESTS` per window.

**Tests**: `worker/src/lib/__tests__/api-keys.test.ts`:
- Add test: after a miss, a subsequently created key authenticates immediately (no 5s delay)

---

## M4 — Pepper rotation strategy

**Problem**: `API_KEY_HASH_PEPPER` is a single static secret. Rotating it invalidates all existing key hashes with no migration path.

### Env changes

Add `API_KEY_HASH_PEPPER_PREVIOUS` to:
- `worker/src/lib/env.ts`: `Env` interface + `WORKER_OPTIONAL_ENV_KEYS`
- `worker/wrangler.toml`: not needed (it's a secret, set via `wrangler secret put`)

### Schema change

**New migration** `0089_api_key_pepper_version.sql`:

```sql
-- rollout-safety: backward-compatible
ALTER TABLE api_keys ADD COLUMN pepper_version INTEGER NOT NULL DEFAULT 1;
```

### Auth flow change

**File**: `worker/src/lib/api-keys.ts:332-365` (`authenticateApiKey`)

Add `pepperPrevious` parameter. Try current pepper first; if it fails, try previous pepper. On successful auth with previous pepper, re-hash with current pepper (opportunistic migration):

```typescript
export async function authenticateApiKey(
  db: ApiKeyDb,
  apiKeyHeader: string | null,
  pepper: string | undefined,
  pepperPrevious?: string,         // <-- new
  nowSec = getNowSec(),
): Promise<ApiKeyAuthenticationResult> {
  // ... existing parse + lookup ...

  const effectivePepper = pepper?.trim();
  if (!effectivePepper) {
    return { kind: "unavailable" };
  }

  const expectedHash = await hmacSha256Hex(effectivePepper, parsed.secret);
  if (await timingSafeCompare(expectedHash, row.secret_hash)) {
    return { kind: "valid", key: mapRowToAuthenticatedKey(row) };
  }

  // Try previous pepper for rotation
  const effectivePreviousPepper = pepperPrevious?.trim();
  if (effectivePreviousPepper) {
    const previousHash = await hmacSha256Hex(effectivePreviousPepper, parsed.secret);
    if (await timingSafeCompare(previousHash, row.secret_hash)) {
      // Opportunistic re-hash with current pepper
      const newHash = expectedHash; // already computed above
      await db.prepare(
        "UPDATE api_keys SET secret_hash = ?, pepper_version = pepper_version + 1, updated_at = ? WHERE id = ?",
      ).bind(newHash, nowSec, row.id).run();
      clearApiKeyCache(parsed.prefix);
      return { kind: "valid", key: mapRowToAuthenticatedKey(row) };
    }
  }

  return { kind: "invalid" };
}
```

### Callers

**`worker/src/handlers/http/gates.ts:95-99`**: Pass `env.API_KEY_HASH_PEPPER_PREVIOUS`:

```typescript
const apiKeyAuth = await authenticateApiKey(
  env.DB,
  request.headers.get("X-API-Key"),
  env.API_KEY_HASH_PEPPER,
  env.API_KEY_HASH_PEPPER_PREVIOUS,  // <-- new
);
```

**`worker/src/handlers/http/context.ts`**: Update `apiKeyHashPepper` hydrator to also pass previous pepper. Add `apiKeyHashPepperPrevious` field to `ApiKeysRouteFields`.

### Env validation

**`worker/src/lib/env.ts`**: Warn if `API_KEY_HASH_PEPPER_PREVIOUS` is set but identical to `API_KEY_HASH_PEPPER` (no-op rotation).

### Tests

- `worker/src/lib/__tests__/api-keys.test.ts`: Test auth succeeds with previous pepper, verify re-hash happens, verify cache invalidation after re-hash
- Verify that after re-hash, auth with current pepper succeeds (key fully migrated)

---

## L1 — Rate limit count overflow guard

**File**: `worker/src/lib/api-keys.ts:375-379`

**Problem**: `count = count + 1` in the UPSERT can overflow SQLite's 64-bit integer. While theoretical (would need ~9.2 quintillion requests in one 60s bucket), it's architecturally unsound because a negative count would bypass the rate limit check.

**Fix**: Cap the increment:

```sql
DO UPDATE SET count = MIN(count + 1, 2147483647), last_seen_at = excluded.last_seen_at
```

Using INT32 max (2147483647) instead of INT64 max for safety and readability. Any count above the rate limit (max 10,000/min) already triggers rejection, so capping at 2B is far beyond any legitimate use.

**Tests**: Existing rate limit tests cover the boundary. No new test needed since the cap is unreachable in practice.

---

## Implementation Order

Dependencies between findings:

```
H1 (timingSafeCompare) ← M4 depends on this being correct
M3 (negative cache)    ← independent
L1 (overflow guard)    ← independent
H2 (audit logging)     ← independent (new migration + endpoint)
M4 (pepper rotation)   ← depends on H1 being fixed first
M2 (enforce mode)      ← should be last (changes default behavior)
M1 (workflow perms)    ← independent (CI only, no code)
```

Recommended sequence:
1. **H1** — Fix timingSafeCompare (prerequisite for M4)
2. **L1** — Rate limit overflow cap (one-liner)
3. **M3** — Fix negative cache (one-liner)
4. **M1** — Add workflow permissions (CI-only, no runtime code)
5. **H2** — Audit logging (new migration + endpoint + tests)
6. **M4** — Pepper rotation (new migration + auth flow change)
7. **M2** — Enforce auth mode (behavior change, deploy last)
