# API Key Gating Design

**Date:** 2026-04-03
**Status:** Approved
**Goal:** Gate external API access behind API keys while keeping website traffic unaffected. Admin-provisioned keys only (self-service registration is out of scope).

## Context

The public API is receiving ~19k external requests/day (63.8% of total traffic). Top-hit routes like `/api/stress-signals`, `/api/stablecoins`, and `/api/peg-summary` show 90%+ external share. The API needs key-based access control before offering paid tiers.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Key delivery | `Authorization: Bearer <key>` header | Industry standard, expected by API consumers |
| Unauthenticated external requests | Hard block (401) | Stop abuse immediately; keys can be handed out freely |
| Tiers | Free only (5 req/s) | Paid tiers out of scope; schema accommodates them |
| Key storage | D1 + in-memory cache | Consistent with stack; cache eliminates most D1 lookups |
| Provisioning | Admin-only endpoints | Self-service registration deferred to paid tier launch |

## Schema

### Table: `api_keys`

```sql
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,            -- prefixed key: "ph_<uuid>"
  name TEXT NOT NULL,             -- human label ("Alice's bot")
  owner_email TEXT NOT NULL,      -- contact email
  tier TEXT NOT NULL DEFAULT 'free',
  rate_limit_per_sec INTEGER NOT NULL DEFAULT 5,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE INDEX idx_api_keys_active ON api_keys(is_active);
```

### Table: `api_key_usage`

```sql
CREATE TABLE api_key_usage (
  key_id TEXT NOT NULL,
  bucket_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, bucket_start)
);

CREATE INDEX idx_api_key_usage_bucket ON api_key_usage(bucket_start);
```

## Request Flow

```
Request arrives at evaluateAccessGate()
  │
  ├─ Is admin (CF Access JWT)? → pass through (unchanged)
  │
  ├─ Not an /api/ route? → pass through (unchanged)
  │
  ├─ Is first-party website?
  │    (Origin/Referer === SITE_ORIGIN, or Pharos Accept marker + same-site fetch)
  │    → pass through (unchanged, no key needed)
  │
  ├─ Has "Authorization: Bearer <key>" header?
  │    ├─ Look up key in D1 (with in-memory cache, 5min TTL)
  │    ├─ Key not found or is_active=0? → 401 "Invalid API key"
  │    ├─ Check per-key rate limit (api_key_usage, 1-second buckets)
  │    ├─ Over limit? → 429 + Retry-After + rate limit headers
  │    └─ OK → pass through + rate limit headers + debounced last_used_at update
  │
  └─ No auth header? → 401 "API key required. See https://pharos.watch/api-docs"
```

First-party detection uses the same logic already in `classifyPublicApiRequestSource()`:
- Origin or Referer matches `SITE_ORIGIN`
- OR: Pharos Accept marker present + `Sec-Fetch-Site` is `same-site`/`same-origin`

## In-Memory Key Cache

```typescript
Map<string, { key: ApiKeyRow; cachedAt: number }>
```

- **TTL:** 5 minutes (300,000 ms)
- **Invalidation:** natural isolate recycling; no explicit invalidation needed at current scale
- **Miss behavior:** query D1, populate cache, return result
- **Negative caching:** cache misses for 60 seconds to prevent D1 hammering from invalid keys

## Per-Key Rate Limiting

Uses the same D1 upsert pattern as existing `checkPublicApiRateLimit()`:

```sql
INSERT INTO api_key_usage (key_id, bucket_start, count)
VALUES (?, ?, 1)
ON CONFLICT(key_id, bucket_start)
DO UPDATE SET count = count + 1
RETURNING count
```

- 1-second buckets for req/s enforcement
- Prune old buckets periodically (same pattern as existing rate limit pruning)
- The existing IP-based rate limit (`public_api_rate_limit`) remains as a secondary safety net

## Response Headers

**All keyed responses:**
```
X-RateLimit-Limit: 5
X-RateLimit-Remaining: 3
X-RateLimit-Reset: 1712170801
```

**401 responses (no key or invalid key):**
```
WWW-Authenticate: Bearer realm="pharos.watch"
```

## Admin Endpoints

All require admin auth (existing `requireAdmin` / CF Access JWT).

| Method | Path | Body / Params | Returns |
|---|---|---|---|
| `POST` | `/api/admin/api-keys` | `{ name, ownerEmail, tier?, rateLimitPerSec? }` | Created key object (includes the `id` — the actual key) |
| `GET` | `/api/admin/api-keys` | — | Array of all keys with metadata |
| `PATCH` | `/api/admin/api-keys/:id` | `{ name?, ownerEmail?, tier?, rateLimitPerSec?, isActive? }` | Updated key object |
| `DELETE` | `/api/admin/api-keys/:id` | — | 204 No Content |

## CORS Change

Add `Authorization` to `Access-Control-Allow-Headers` in `cors.ts` so browser-based API consumers can send the header:

```
Access-Control-Allow-Headers: Content-Type, Idempotency-Key, Authorization
```

## Files to Change

| File | Change |
|---|---|
| `worker/migrations/0083_api_keys.sql` | `api_keys` and `api_key_usage` tables |
| `worker/src/lib/api-keys.ts` | New: key lookup, cache, validation, per-key rate limiting |
| `worker/src/handlers/http/gates.ts` | Insert key check into `evaluateAccessGate`, extract first-party detection |
| `worker/src/handlers/http/request-dispatch.ts` | Attach rate limit headers to responses |
| `worker/src/handlers/http/cors.ts` | Add `Authorization` to allowed headers |
| `worker/src/api/admin/api-keys.ts` | New: CRUD endpoints |
| Router registration | Register admin API key endpoints |
| `worker/src/lib/request-source-attribution.ts` | Add `"api-key"` as a third source classification |

## Frontend Impact

**None.** Website traffic is identified by existing first-party markers and bypasses the key requirement entirely.

## Future Extensibility

The design accommodates paid tiers without schema changes:
- `tier` column supports arbitrary tier names
- `rate_limit_per_sec` is per-key, allowing custom limits
- Usage data in `api_key_usage` enables billing/analytics
- Self-service registration would add a public signup flow + Stripe integration on top of this foundation

## Out of Scope

- Self-service key registration
- Paid tiers / billing integration
- Per-endpoint key scoping (all keys access all public endpoints)
- API documentation page (just a link in the 401 response for now)
- Usage dashboard for key holders
