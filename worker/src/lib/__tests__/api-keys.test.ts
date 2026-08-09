import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { hmacSha256Hex } from "../../test-helpers/__shared/auth";
import { makeApiKeyRow } from "../../test-helpers/__shared/fixtures";
import {
  API_KEY_AUTH_CACHE_MAX_ENTRIES,
  API_KEY_AUTH_CACHE_TTL_MS,
  API_KEY_LOCAL_RATE_LIMIT_MAX_ENTRIES,
  API_KEY_USAGE_UPDATE_CACHE_MAX_ENTRIES,
  authenticateApiKey,
  checkApiKeyRateLimit,
  checkIsolateLocalApiKeyRateLimit,
  createApiKey,
  isApiKeyRateLimitDependencyCircuitOpen,
  listApiKeys,
  parseApiKeyToken,
  recordApiKeyRateLimitDependencyFailure,
  recordApiKeyRateLimitDependencySuccess,
  resetApiKeyStateForTests,
  recordApiKeyUsage,
  resolveIsolateFallbackApiKeyRateLimit,
  rotateApiKey,
  updateApiKey,
} from "../api-keys";
import { getApiKeyRuntimeState, lookupApiKeyByPrefix, normalizeCreateInput } from "../api-key-core";

describe("api key helpers", () => {
  beforeEach(() => {
    resetApiKeyStateForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("parses the canonical API key token shape", () => {
    expect(parseApiKeyToken("ph_live_0123456789abcdef_abcdefghijklmnopqrstuvwxyzABCDEF")).toEqual({
      token: "ph_live_0123456789abcdef_abcdefghijklmnopqrstuvwxyzABCDEF",
      prefix: "0123456789abcdef",
      secret: "abcdefghijklmnopqrstuvwxyzABCDEF",
    });
    expect(parseApiKeyToken("bad-token")).toBeNull();
  });

  it("authenticates active API keys by prefix + secret hash", async () => {
    const pepper = "pepper";
    const secret = "abcdefghijklmnopqrstuvwxyzABCDEF";
    const secretHash = await hmacSha256Hex(pepper, secret);
    const db = mockD1(
      [
        {
          match: "FROM api_keys",
          matchBinds: ["ffffffffffffffff"],
          rows: [],
          first: null,
        },
        {
          match: "FROM api_keys",
          matchBinds: ["0123456789abcdef"],
          rows: [
            makeApiKeyRow({
              secret_hash: secretHash,
              name: "Smoke",
              owner_email: "ops@pharos.watch",
              tier: "ci",
              traffic_class: "site",
              rate_limit_per_minute: 180,
              expires_at: 1_800,
            }),
          ],
        },
      ],
      { requireMatch: true },
    );

    await expect(authenticateApiKey(db, null, pepper)).resolves.toEqual({ kind: "missing" });
    await expect(
      authenticateApiKey(db, "ph_live_ffffffffffffffff_abcdefghijklmnopqrstuvwxyzABCDEF", pepper),
    ).resolves.toEqual({ kind: "invalid" });
    await expect(
      authenticateApiKey(db, "ph_live_0123456789abcdef_abcdefghijklmnopqrstuvwxyzABCDEF", pepper, undefined, 1_700),
    ).resolves.toEqual({
      kind: "valid",
      key: {
        id: 7,
        keyPrefix: "0123456789abcdef",
        name: "Smoke",
        ownerEmail: "ops@pharos.watch",
        tier: "ci",
        trafficClass: "site",
        rateLimitPerMinute: 180,
        isActive: true,
        expiresAt: 1_800,
      },
    });
  });

  it("rejects expired API keys even when the prefix and secret hash match", async () => {
    const pepper = "pepper";
    const secret = "abcdefghijklmnopqrstuvwxyzABCDEF";
    const secretHash = await hmacSha256Hex(pepper, secret);
    const db = mockD1(
      [
        {
          match: "FROM api_keys",
          matchBinds: ["0123456789abcdef"],
          rows: [
            makeApiKeyRow({
              secret_hash: secretHash,
              name: "Expired",
              owner_email: "ops@pharos.watch",
              tier: "ci",
              rate_limit_per_minute: 180,
              expires_at: 900,
            }),
          ],
        },
      ],
      { requireMatch: true },
    );

    await expect(
      authenticateApiKey(db, "ph_live_0123456789abcdef_abcdefghijklmnopqrstuvwxyzABCDEF", pepper, undefined, 1_000),
    ).resolves.toEqual({ kind: "invalid" });
  });

  it("creates an API key and returns the raw token once", async () => {
    const db = mockD1(
      [
        {
          match: "INSERT INTO api_keys",
          first: makeApiKeyRow({
            id: 3,
            key_prefix: "fedcba9876543210",
            name: "Digest",
            owner_email: "digest@pharos.watch",
            tier: "standard",
            rate_limit_per_minute: 90,
            expires_at: 111 + 90 * 24 * 60 * 60,
            created_at: 111,
            updated_at: 111,
          }),
          rows: [],
        },
        {
          match: "INSERT INTO api_key_audit_log",
          rows: [],
          runMeta: { changes: 1 },
        },
      ],
      { requireMatch: true },
    );

    const created = await createApiKey(
      db,
      "pepper",
      {
        name: "Digest",
        ownerEmail: "digest@pharos.watch",
        tier: "standard",
        rateLimitPerMinute: 90,
      },
      111,
    );

    expect(created).not.toBeInstanceOf(Response);
    expect(created).toMatchObject({
      key: {
        id: 3,
        keyPrefix: "fedcba9876543210",
        maskedToken: "ph_live_fedcba9876543210_********",
        name: "Digest",
        ownerEmail: "digest@pharos.watch",
        tier: "standard",
        trafficClass: "external",
        rateLimitPerMinute: 90,
        isActive: true,
        expiresAt: 111 + 90 * 24 * 60 * 60,
      },
    });
    expect(db.getHistory()[0]?.binds[8]).toBe(111 + 90 * 24 * 60 * 60);
    expect(parseApiKeyToken((created as Exclude<typeof created, Response>).token)).not.toBeNull();
  });

  it("rejects partial numeric rate limit strings", async () => {
    const created = await createApiKey(
      mockD1([]),
      "pepper",
      {
        name: "Bad rate",
        rateLimitPerMinute: "120abc",
      },
      111,
    );

    expect(created).toBeInstanceOf(Response);
    expect((created as Response).status).toBe(400);
    await expect((created as Response).json()).resolves.toEqual({
      error: "rateLimitPerMinute must be an integer between 1 and 10000",
    });
  });

  it("normalizes create input string fields and rejects an unknown tier", async () => {
    expect(
      normalizeCreateInput({
        name: "  Ops token  ",
        ownerEmail: " Ops@Pharos.Watch ",
        tier: "  Self-Serve  ",
        rateLimitPerMinute: "120",
        expiresAt: "1800",
      }),
    ).toEqual({
      name: "Ops token",
      ownerEmail: "ops@pharos.watch",
      tier: "self-serve",
      rateLimitPerMinute: 120,
      expiresAt: 1800,
    });

    // trafficClass is no longer an issuance dimension: the lane is derived per
    // request in handlers/http/gates.ts, so an admin body cannot assign it.
    expect(normalizeCreateInput({ name: "Ops token", trafficClass: "site" })).not.toHaveProperty("trafficClass");

    const invalidTier = normalizeCreateInput({
      name: "Ops token",
      tier: "enterprise",
    });
    expect(invalidTier).toBeInstanceOf(Response);
    expect((invalidTier as Response).status).toBe(400);
    await expect((invalidTier as Response).json()).resolves.toEqual({
      error: "tier must be one of: standard, self-serve",
    });
  });

  it("preserves explicit null expiry as a non-expiring exception", async () => {
    const db = mockD1(
      [
        {
          match: "INSERT INTO api_keys",
          first: makeApiKeyRow({
            id: 4,
            key_prefix: "0011223344556677",
            name: "Permanent",
            created_at: 222,
            updated_at: 222,
          }),
          rows: [],
        },
        {
          match: "INSERT INTO api_key_audit_log",
          rows: [],
          runMeta: { changes: 1 },
        },
      ],
      { requireMatch: true },
    );

    const created = await createApiKey(
      db,
      "pepper",
      {
        name: "Permanent",
        expiresAt: null,
      },
      222,
    );

    expect(created).not.toBeInstanceOf(Response);
    expect((created as Exclude<typeof created, Response>).key.expiresAt).toBeNull();
    expect(db.getHistory()[0]?.binds[8]).toBeNull();
  });

  it("updates expiry metadata and preserves explicit null on update", async () => {
    const db = mockD1(
      [
        {
          match: "key_prefix,\n       secret_hash,\n       name",
          matchBinds: [7],
          first: makeApiKeyRow({
            owner_email: "ops@pharos.watch",
            expires_at: 1_800,
          }),
          rows: [],
        },
        {
          match: "UPDATE api_keys",
          rows: [],
          runMeta: { changes: 1 },
        },
        {
          match: "INSERT INTO api_key_audit_log",
          rows: [],
          runMeta: { changes: 1 },
        },
        {
          match: "key_prefix,\n       name,\n       owner_email",
          matchBinds: [7],
          first: makeApiKeyRow({
            owner_email: "ops@pharos.watch",
            updated_at: 2_000,
          }),
          rows: [],
        },
      ],
      { requireMatch: true },
    );

    const updated = await updateApiKey(db, 7, { expiresAt: null }, 2_000);

    expect(updated).not.toBeInstanceOf(Response);
    expect((updated as Exclude<typeof updated, Response>).key.expiresAt).toBeNull();
    expect(db.getHistory().find((entry) => entry.sql.includes("UPDATE api_keys"))?.binds[6]).toBeNull();
  });

  it("lists expired keys instead of filtering them out", async () => {
    const db = mockD1(
      [
        {
          match: "ORDER BY created_at DESC, id DESC",
          rows: [
            makeApiKeyRow({
              id: 9,
              key_prefix: "0011223344556677",
              name: "Expired",
              expires_at: 900,
              created_at: 100,
              updated_at: 100,
            }),
            makeApiKeyRow({
              id: 8,
              key_prefix: "8899aabbccddeeff",
              name: "Permanent",
              created_at: 90,
              updated_at: 90,
            }),
          ],
        },
      ],
      { requireMatch: true },
    );

    const listed = await listApiKeys(db, 1_000);

    expect(listed.keys).toHaveLength(2);
    expect(listed.keys[0]?.expiresAt).toBe(900);
    expect(listed.keys[1]?.expiresAt).toBeNull();
  });

  it("preserves the current expiry when rotating a key", async () => {
    const db = mockD1(
      [
        {
          match: "key_prefix,\n       secret_hash,\n       name",
          matchBinds: [7],
          first: makeApiKeyRow({
            owner_email: "ops@pharos.watch",
            expires_at: 5_000,
            last_used_at: 100,
            last_used_route: "/api/stablecoins",
          }),
          rows: [],
        },
        {
          match: "UPDATE api_keys",
          rows: [],
          runMeta: { changes: 1 },
        },
        {
          match: "INSERT INTO api_key_audit_log",
          rows: [],
          runMeta: { changes: 1 },
        },
        {
          match: "key_prefix,\n       name,\n       owner_email",
          matchBinds: [7],
          first: makeApiKeyRow({
            key_prefix: "fedcba9876543210",
            owner_email: "ops@pharos.watch",
            expires_at: 5_000,
            updated_at: 2_000,
          }),
          rows: [],
        },
      ],
      { requireMatch: true },
    );

    const rotated = await rotateApiKey(db, "pepper", 7, 2_000);

    expect(rotated).not.toBeInstanceOf(Response);
    expect((rotated as Exclude<typeof rotated, Response>).key.expiresAt).toBe(5_000);
  });

  it("returns 429 when the per-key minute bucket is exhausted", async () => {
    const db = mockD1(
      [
        {
          match: "INSERT INTO api_key_rate_limit",
          first: { count: 4 },
          rows: [],
        },
        {
          match: "DELETE FROM api_key_rate_limit",
          rows: [],
          runMeta: { changes: 0 },
        },
      ],
      { requireMatch: true },
    );

    const response = await checkApiKeyRateLimit(db, 7, 3, 600);
    expect(response?.status).toBe(429);
  });

  it("hands each bucket's rate-limit prune to the request lifetime exactly once", async () => {
    const pruneResolvers: Array<() => void> = [];
    const db = {
      prepare: (sql: string) => ({
        bind: () => ({
          first: async () => ({ count: 1 }),
          run: () => {
            if (!sql.includes("DELETE FROM api_key_rate_limit")) {
              return Promise.resolve({ success: true, meta: { changes: 1 } });
            }
            return new Promise<{ success: boolean; meta: { changes: number } }>((resolve) => {
              pruneResolvers.push(() => resolve({ success: true, meta: { changes: 1 } }));
            });
          },
        }),
      }),
    } as unknown as Parameters<typeof checkApiKeyRateLimit>[0];

    const waitUntil = vi.fn();
    const execCtx = { waitUntil, passThroughOnException: () => {} } as unknown as ExecutionContext;

    await checkApiKeyRateLimit(db, 7, 100, 600, execCtx);
    expect(waitUntil).toHaveBeenCalledTimes(1);

    // Same 60s bucket: no second prune is scheduled.
    await checkApiKeyRateLimit(db, 7, 100, 630, execCtx);
    expect(waitUntil).toHaveBeenCalledTimes(1);

    // New bucket: a second, distinct prune promise reaches waitUntil.
    await checkApiKeyRateLimit(db, 7, 100, 660, execCtx);
    expect(waitUntil).toHaveBeenCalledTimes(2);
    expect(waitUntil.mock.calls[1]?.[0]).not.toBe(waitUntil.mock.calls[0]?.[0]);

    pruneResolvers[0]?.();
    pruneResolvers[1]?.();
    await Promise.all(waitUntil.mock.calls.map((call) => call[0]));
  });

  it("skips the rate-limit prune entirely when no ExecutionContext is supplied", async () => {
    const prepared: string[] = [];
    const db = {
      prepare: (sql: string) => {
        prepared.push(sql);
        return {
          bind: () => ({
            first: async () => ({ count: 1 }),
            run: async () => ({ success: true, meta: { changes: 1 } }),
          }),
        };
      },
    } as unknown as Parameters<typeof checkApiKeyRateLimit>[0];

    await checkApiKeyRateLimit(db, 9, 100, 600);
    expect(prepared.some((sql) => sql.includes("DELETE FROM api_key_rate_limit"))).toBe(false);
  });

  it("throttles last-used writes to avoid per-request metadata churn", async () => {
    const db = mockD1(
      [
        {
          match: "UPDATE api_keys SET last_used_at = ?, last_used_route = ? WHERE id = ?",
          rows: [],
          runMeta: { changes: 1 },
        },
      ],
      { requireMatch: true },
    );

    const key = {
      id: 12,
      keyPrefix: "0123456789abcdef",
      name: "Ops",
      ownerEmail: null,
      tier: "standard",
      trafficClass: "external" as const,
      rateLimitPerMinute: 120,
      isActive: true,
      expiresAt: null,
    };

    await recordApiKeyUsage(db, key, "/api/stablecoins", 1_000);
    await recordApiKeyUsage(db, key, "/api/stablecoins", 1_001);

    expect(db.getHistory().filter((entry) => entry.sql.includes("UPDATE api_keys SET last_used_at"))).toHaveLength(1);
  });

  it("does not throttle later last-used writes after a failed metadata update", async () => {
    const key = {
      id: 12,
      keyPrefix: "0123456789abcdef",
      name: "Ops",
      ownerEmail: null,
      tier: "standard",
      trafficClass: "external" as const,
      rateLimitPerMinute: 120,
      isActive: true,
      expiresAt: null,
    };
    const failingDb = mockD1(
      [
        {
          match: "UPDATE api_keys SET last_used_at = ?, last_used_route = ? WHERE id = ?",
          rows: [],
          throwError: new Error("d1 unavailable"),
        },
      ],
      { requireMatch: true },
    );
    const succeedingDb = mockD1(
      [
        {
          match: "UPDATE api_keys SET last_used_at = ?, last_used_route = ? WHERE id = ?",
          rows: [],
          runMeta: { changes: 1 },
        },
      ],
      { requireMatch: true },
    );

    await expect(recordApiKeyUsage(failingDb, key, "/api/stablecoins", 1_000)).rejects.toThrow("d1 unavailable");
    await recordApiKeyUsage(succeedingDb, key, "/api/stablecoins", 1_001);

    expect(
      succeedingDb.getHistory().filter((entry) => entry.sql.includes("UPDATE api_keys SET last_used_at")),
    ).toHaveLength(1);
  });

  it("does not cache misses so newly created keys authenticate immediately", async () => {
    const pepper = "pepper";
    const secret = "abcdefghijklmnopqrstuvwxyzABCDEF";
    const secretHash = await hmacSha256Hex(pepper, secret);
    const prefix = "aabbccddeeff0011";

    // First call: prefix not found (miss)
    const dbMiss = mockD1(
      [
        {
          match: "FROM api_keys",
          matchBinds: [prefix],
          rows: [],
          first: null,
        },
      ],
      { requireMatch: true },
    );

    await expect(authenticateApiKey(dbMiss, `ph_live_${prefix}_${secret}`, pepper)).resolves.toEqual({
      kind: "invalid",
    });

    // Second call immediately after: prefix now exists (simulating key creation)
    const dbHit = mockD1(
      [
        {
          match: "FROM api_keys",
          matchBinds: [prefix],
          rows: [
            makeApiKeyRow({
              id: 99,
              key_prefix: prefix,
              secret_hash: secretHash,
              name: "Just Created",
              created_at: 1_000,
              updated_at: 1_000,
            }),
          ],
        },
      ],
      { requireMatch: true },
    );

    // Must hit DB again (not return cached null)
    await expect(authenticateApiKey(dbHit, `ph_live_${prefix}_${secret}`, pepper)).resolves.toMatchObject({
      kind: "valid",
    });
  });

  it("fails closed when D1 lookup fails instead of authenticating with stale cache", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-11T10:00:00.000Z"));

    const pepper = "pepper";
    const secret = "abcdefghijklmnopqrstuvwxyzABCDEF";
    const secretHash = await hmacSha256Hex(pepper, secret);
    const prefix = "0123456789abcdef";
    const cachedRow = makeApiKeyRow({
      key_prefix: prefix,
      secret_hash: secretHash,
      name: "Cached",
    });
    const dbHit = mockD1(
      [
        {
          match: "FROM api_keys",
          matchBinds: [prefix],
          rows: [cachedRow],
        },
      ],
      { requireMatch: true },
    );
    const dbUnavailable = mockD1(
      [
        {
          match: "FROM api_keys",
          matchBinds: [prefix],
          rows: [],
          throwError: new Error("lookup failed"),
        },
      ],
      { requireMatch: true },
    );

    await expect(authenticateApiKey(dbHit, `ph_live_${prefix}_${secret}`, pepper)).resolves.toMatchObject({
      kind: "valid",
    });

    await expect(authenticateApiKey(dbUnavailable, `ph_live_${prefix}_${secret}`, pepper)).resolves.toEqual({
      kind: "unavailable",
    });
    expect(dbUnavailable.getHistory().filter((entry) => entry.sql.includes("FROM api_keys"))).toHaveLength(1);
    expect(getApiKeyRuntimeState().apiKeyCache.has(prefix)).toBe(false);
  });

  it("fails closed instead of using stale cache for self-serve keys when D1 is unavailable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-11T10:00:00.000Z"));

    const pepper = "pepper";
    const secret = "abcdefghijklmnopqrstuvwxyzABCDEF";
    const secretHash = await hmacSha256Hex(pepper, secret);
    const prefix = "1122334455667788";
    const cachedRow = makeApiKeyRow({
      id: 17,
      key_prefix: prefix,
      secret_hash: secretHash,
      name: "Self Serve",
      owner_email: "builder@example.com",
      tier: "self-serve",
      rate_limit_per_minute: 30,
    });
    const dbHit = mockD1(
      [
        {
          match: "FROM api_keys",
          matchBinds: [prefix],
          rows: [cachedRow],
        },
        {
          match: "FROM api_key_self_serve_revocations",
          matchBinds: [prefix],
          rows: [],
          first: null,
        },
      ],
      { requireMatch: true },
    );
    const dbUnavailable = mockD1(
      [
        {
          match: "FROM api_keys",
          matchBinds: [prefix],
          rows: [],
          throwError: new Error("lookup failed"),
        },
      ],
      { requireMatch: true },
    );

    await expect(authenticateApiKey(dbHit, `ph_live_${prefix}_${secret}`, pepper)).resolves.toMatchObject({
      kind: "valid",
    });

    vi.advanceTimersByTime(API_KEY_AUTH_CACHE_TTL_MS + 1);

    await expect(authenticateApiKey(dbUnavailable, `ph_live_${prefix}_${secret}`, pepper)).resolves.toEqual({
      kind: "unavailable",
    });
  });

  it("authenticates with previous pepper and opportunistically re-hashes", async () => {
    const oldPepper = "old-pepper";
    const newPepper = "new-pepper";
    const secret = "abcdefghijklmnopqrstuvwxyzABCDEF";
    const oldSecretHash = await hmacSha256Hex(oldPepper, secret);
    const prefix = "0123456789abcdef";

    const db = mockD1(
      [
        {
          match: "FROM api_keys",
          matchBinds: [prefix],
          rows: [
            makeApiKeyRow({
              key_prefix: prefix,
              secret_hash: oldSecretHash,
              name: "Legacy",
              pepper_version: 1,
            }),
          ],
        },
        {
          match: "UPDATE api_keys SET secret_hash",
          rows: [],
          runMeta: { changes: 1 },
        },
      ],
      { requireMatch: true },
    );

    const result = await authenticateApiKey(db, `ph_live_${prefix}_${secret}`, newPepper, oldPepper, 1_000);

    expect(result).toMatchObject({ kind: "valid" });

    // Verify the re-hash UPDATE was issued
    const rehashQuery = db.getHistory().find((entry) => entry.sql.includes("UPDATE api_keys SET secret_hash"));
    expect(rehashQuery).toBeDefined();
    expect(rehashQuery?.binds[0]).toBe(await hmacSha256Hex(newPepper, secret));
  });

  it("returns unavailable when API key lookup storage fails", async () => {
    const db = mockD1(
      [
        {
          match: "FROM api_keys",
          matchBinds: ["0123456789abcdef"],
          rows: [],
          throwError: new Error("lookup failed"),
        },
      ],
      { requireMatch: true },
    );

    await expect(
      authenticateApiKey(db, "ph_live_0123456789abcdef_abcdefghijklmnopqrstuvwxyzABCDEF", "pepper"),
    ).resolves.toEqual({ kind: "unavailable" });
  });

  it("treats previous-pepper rehash storage as best-effort after auth succeeds", async () => {
    const oldPepper = "old-pepper";
    const newPepper = "new-pepper";
    const secret = "abcdefghijklmnopqrstuvwxyzABCDEF";
    const oldSecretHash = await hmacSha256Hex(oldPepper, secret);
    const prefix = "0123456789abcdef";
    const db = mockD1(
      [
        {
          match: "FROM api_keys",
          matchBinds: [prefix],
          rows: [
            makeApiKeyRow({
              key_prefix: prefix,
              secret_hash: oldSecretHash,
              name: "Legacy",
              pepper_version: 1,
            }),
          ],
        },
        {
          match: "UPDATE api_keys SET secret_hash",
          rows: [],
          throwError: new Error("rehash failed"),
        },
      ],
      { requireMatch: true },
    );

    await expect(
      authenticateApiKey(db, `ph_live_${prefix}_${secret}`, newPepper, oldPepper, 1_000),
    ).resolves.toMatchObject({ kind: "valid" });
  });

  it("uses the isolate-local fallback limiter when D1 minute-bucket storage is unavailable", () => {
    expect(checkIsolateLocalApiKeyRateLimit(7, 2, 600)).toBeNull();
    expect(checkIsolateLocalApiKeyRateLimit(7, 2, 601)).toBeNull();
    expect(checkIsolateLocalApiKeyRateLimit(7, 2, 602)?.status).toBe(429);
  });

  it("prunes isolate-local fallback limiter buckets once per minute", () => {
    const state = getApiKeyRuntimeState();
    state.apiKeyFallbackRateLimitById.set(99, { bucketStart: 540, count: 1 });

    expect(checkIsolateLocalApiKeyRateLimit(7, 120, 600)).toBeNull();
    expect(state.apiKeyFallbackRateLimitById.has(99)).toBe(false);
    expect(state.lastApiKeyFallbackRateLimitPruneBucket).toBe(600);

    state.apiKeyFallbackRateLimitById.set(100, { bucketStart: 540, count: 1 });
    expect(checkIsolateLocalApiKeyRateLimit(8, 120, 601)).toBeNull();
    expect(state.apiKeyFallbackRateLimitById.has(100)).toBe(true);

    expect(checkIsolateLocalApiKeyRateLimit(9, 120, 660)).toBeNull();
    expect(state.apiKeyFallbackRateLimitById.has(100)).toBe(false);
    expect(state.lastApiKeyFallbackRateLimitPruneBucket).toBe(660);
  });

  it("opens and resets the API key rate-limit dependency circuit", () => {
    expect(isApiKeyRateLimitDependencyCircuitOpen(1_000)).toBe(false);

    expect(recordApiKeyRateLimitDependencyFailure(1_000)).toMatchObject({
      consecutiveFailures: 1,
      opened: false,
    });
    expect(recordApiKeyRateLimitDependencyFailure(1_001)).toMatchObject({
      consecutiveFailures: 2,
      opened: false,
    });
    const opened = recordApiKeyRateLimitDependencyFailure(1_002);
    expect(opened).toMatchObject({
      consecutiveFailures: 3,
      opened: true,
    });
    expect(opened.openUntilMs).toBe(61_002);
    expect(isApiKeyRateLimitDependencyCircuitOpen(61_001)).toBe(true);
    expect(isApiKeyRateLimitDependencyCircuitOpen(61_002)).toBe(false);

    recordApiKeyRateLimitDependencySuccess();
    expect(getApiKeyRuntimeState().apiKeyRateLimitDependencyCircuit).toEqual({
      consecutiveFailures: 0,
      openUntilMs: 0,
    });
  });

  it("caps the dependency fallback limiter to the self-serve quota without raising stricter keys", () => {
    expect(resolveIsolateFallbackApiKeyRateLimit(120)).toBe(30);
    expect(resolveIsolateFallbackApiKeyRateLimit(10)).toBe(10);
  });

  it("caps the isolate-local API key auth cache", async () => {
    const secretHash = await hmacSha256Hex("pepper", "abcdefghijklmnopqrstuvwxyzABCDEF");
    const db = mockD1([
      {
        match: "FROM api_keys",
        rows: [
          makeApiKeyRow({
            secret_hash: secretHash,
            name: "Cached",
          }),
        ],
      },
    ]);

    for (let i = 0; i < API_KEY_AUTH_CACHE_MAX_ENTRIES + 5; i++) {
      await lookupApiKeyByPrefix(db, i.toString(16).padStart(16, "0"));
    }

    expect(getApiKeyRuntimeState().apiKeyCache.size).toBe(API_KEY_AUTH_CACHE_MAX_ENTRIES);
  });

  it("caps isolate-local fallback rate-limit buckets", () => {
    for (let i = 0; i < API_KEY_LOCAL_RATE_LIMIT_MAX_ENTRIES + 5; i++) {
      expect(checkIsolateLocalApiKeyRateLimit(i + 1, 120, 600)).toBeNull();
    }

    expect(getApiKeyRuntimeState().apiKeyFallbackRateLimitById.size).toBe(API_KEY_LOCAL_RATE_LIMIT_MAX_ENTRIES);
  });

  it("caps isolate-local last-used throttling state", async () => {
    const db = mockD1([
      {
        match: "UPDATE api_keys SET last_used_at = ?, last_used_route = ? WHERE id = ?",
        rows: [],
        runMeta: { changes: 1 },
      },
    ]);

    for (let i = 0; i < API_KEY_USAGE_UPDATE_CACHE_MAX_ENTRIES + 5; i++) {
      await recordApiKeyUsage(
        db,
        {
          id: i + 1,
          keyPrefix: i.toString(16).padStart(16, "0"),
          name: "Key",
          ownerEmail: null,
          tier: "standard",
          trafficClass: "external",
          rateLimitPerMinute: 120,
          isActive: true,
          expiresAt: null,
        },
        "/api/stablecoins",
        1_000,
      );
    }

    expect(getApiKeyRuntimeState().apiKeyLastUsageUpdateById.size).toBe(API_KEY_USAGE_UPDATE_CACHE_MAX_ENTRIES);
  });

  it("records an audit log entry when creating a key", async () => {
    const db = mockD1(
      [
        {
          match: "INSERT INTO api_keys",
          first: makeApiKeyRow({
            id: 5,
            key_prefix: "fedcba9876543210",
            name: "Audited",
            expires_at: 333 + 90 * 24 * 60 * 60,
            created_at: 333,
            updated_at: 333,
          }),
          rows: [],
        },
        {
          match: "INSERT INTO api_key_audit_log",
          rows: [],
          runMeta: { changes: 1 },
        },
      ],
      { requireMatch: true },
    );

    const created = await createApiKey(db, "pepper", { name: "Audited" }, 333);
    expect(created).not.toBeInstanceOf(Response);

    const auditInsert = db.getHistory().find((entry) => entry.sql.includes("api_key_audit_log"));
    expect(auditInsert).toBeDefined();
    expect(auditInsert?.binds[0]).toBe(5);
    expect(auditInsert?.binds[1]).toBe("created");
  });
});
