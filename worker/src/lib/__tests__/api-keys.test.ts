import { beforeEach, describe, expect, it } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";
import { hmacSha256Hex } from "../../api/__tests__/helpers/auth";
import {
  authenticateApiKey,
  checkApiKeyRateLimit,
  createApiKey,
  listApiKeys,
  parseApiKeyToken,
  resetApiKeyStateForTests,
  recordApiKeyUsage,
  rotateApiKey,
  updateApiKey,
} from "../api-keys";

describe("api key helpers", () => {
  beforeEach(() => {
    resetApiKeyStateForTests();
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
    const db = mockD1([
      {
        match: "FROM api_keys",
        matchBinds: ["ffffffffffffffff"],
        rows: [],
        first: null,
      },
      {
        match: "FROM api_keys",
        matchBinds: ["0123456789abcdef"],
        rows: [{
          id: 7,
          key_prefix: "0123456789abcdef",
          secret_hash: secretHash,
          name: "Smoke",
          owner_email: "ops@pharos.watch",
          tier: "ci",
          traffic_class: "site",
          rate_limit_per_minute: 180,
          is_active: 1,
          expires_at: 1_800,
          created_at: 1,
          updated_at: 1,
          last_used_at: null,
          last_used_route: null,
        }],
      },
    ], { requireMatch: true });

    await expect(authenticateApiKey(db, null, pepper)).resolves.toEqual({ kind: "missing" });
    await expect(authenticateApiKey(db, "ph_live_ffffffffffffffff_abcdefghijklmnopqrstuvwxyzABCDEF", pepper)).resolves.toEqual({ kind: "invalid" });
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
    const db = mockD1([
      {
        match: "FROM api_keys",
        matchBinds: ["0123456789abcdef"],
        rows: [{
          id: 7,
          key_prefix: "0123456789abcdef",
          secret_hash: secretHash,
          name: "Expired",
          owner_email: "ops@pharos.watch",
          tier: "ci",
          traffic_class: "external",
          rate_limit_per_minute: 180,
          is_active: 1,
          expires_at: 900,
          created_at: 1,
          updated_at: 1,
          last_used_at: null,
          last_used_route: null,
        }],
      },
    ], { requireMatch: true });

    await expect(
      authenticateApiKey(db, "ph_live_0123456789abcdef_abcdefghijklmnopqrstuvwxyzABCDEF", pepper, undefined, 1_000),
    ).resolves.toEqual({ kind: "invalid" });
  });

  it("creates an API key and returns the raw token once", async () => {
    const db = mockD1([
      {
        match: "INSERT INTO api_keys",
        first: {
          id: 3,
          key_prefix: "fedcba9876543210",
          name: "Digest",
          owner_email: "digest@pharos.watch",
          tier: "ci",
          traffic_class: "external",
          rate_limit_per_minute: 90,
          is_active: 1,
          expires_at: 111 + (90 * 24 * 60 * 60),
          created_at: 111,
          updated_at: 111,
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

    const created = await createApiKey(db, "pepper", {
      name: "Digest",
      ownerEmail: "digest@pharos.watch",
      tier: "ci",
      rateLimitPerMinute: 90,
    }, 111);

    expect(created).not.toBeInstanceOf(Response);
    expect(created).toMatchObject({
      key: {
        id: 3,
        keyPrefix: "fedcba9876543210",
        maskedToken: "ph_live_fedcba9876543210_********",
        name: "Digest",
        ownerEmail: "digest@pharos.watch",
        tier: "ci",
        trafficClass: "external",
        rateLimitPerMinute: 90,
        isActive: true,
        expiresAt: 111 + (90 * 24 * 60 * 60),
      },
    });
    expect(db.getHistory()[0]?.binds[7]).toBe(111 + (90 * 24 * 60 * 60));
    expect(parseApiKeyToken((created as Exclude<typeof created, Response>).token)).not.toBeNull();
  });

  it("rejects partial numeric rate limit strings", async () => {
    const created = await createApiKey(mockD1([]), "pepper", {
      name: "Bad rate",
      rateLimitPerMinute: "120abc",
    }, 111);

    expect(created).toBeInstanceOf(Response);
    expect((created as Response).status).toBe(400);
    await expect((created as Response).json()).resolves.toEqual({
      error: "rateLimitPerMinute must be an integer between 1 and 10000",
    });
  });

  it("preserves explicit null expiry as a non-expiring exception", async () => {
    const db = mockD1([
      {
        match: "INSERT INTO api_keys",
        first: {
          id: 4,
          key_prefix: "0011223344556677",
          name: "Permanent",
          owner_email: null,
          tier: "standard",
          traffic_class: "external",
          rate_limit_per_minute: 120,
          is_active: 1,
          expires_at: null,
          created_at: 222,
          updated_at: 222,
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

    const created = await createApiKey(db, "pepper", {
      name: "Permanent",
      expiresAt: null,
    }, 222);

    expect(created).not.toBeInstanceOf(Response);
    expect((created as Exclude<typeof created, Response>).key.expiresAt).toBeNull();
    expect(db.getHistory()[0]?.binds[7]).toBeNull();
  });

  it("updates expiry metadata and preserves explicit null on update", async () => {
    const db = mockD1([
      {
        match: "key_prefix,\n       secret_hash,\n       name",
        matchBinds: [7],
        first: {
          id: 7,
          key_prefix: "0123456789abcdef",
          secret_hash: "hash",
          name: "Ops",
          owner_email: "ops@pharos.watch",
          tier: "standard",
          traffic_class: "external",
          rate_limit_per_minute: 120,
          is_active: 1,
          expires_at: 1_800,
          created_at: 1,
          updated_at: 1,
          last_used_at: null,
          last_used_route: null,
        },
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
        first: {
          id: 7,
          key_prefix: "0123456789abcdef",
          name: "Ops",
          owner_email: "ops@pharos.watch",
          tier: "standard",
          traffic_class: "external",
          rate_limit_per_minute: 120,
          is_active: 1,
          expires_at: null,
          created_at: 1,
          updated_at: 2_000,
          last_used_at: null,
          last_used_route: null,
        },
        rows: [],
      },
    ], { requireMatch: true });

    const updated = await updateApiKey(db, 7, { expiresAt: null }, 2_000);

    expect(updated).not.toBeInstanceOf(Response);
    expect((updated as Exclude<typeof updated, Response>).key.expiresAt).toBeNull();
    expect(db.getHistory().find((entry) => entry.sql.includes("UPDATE api_keys"))?.binds[6]).toBeNull();
  });

  it("lists expired keys instead of filtering them out", async () => {
    const db = mockD1([
      {
        match: "ORDER BY created_at DESC, id DESC",
        rows: [
          {
            id: 9,
            key_prefix: "0011223344556677",
            name: "Expired",
            owner_email: null,
            tier: "standard",
            traffic_class: "external",
            rate_limit_per_minute: 120,
            is_active: 1,
            expires_at: 900,
            created_at: 100,
            updated_at: 100,
            last_used_at: null,
            last_used_route: null,
          },
          {
            id: 8,
            key_prefix: "8899aabbccddeeff",
            name: "Permanent",
            owner_email: null,
            tier: "standard",
            traffic_class: "external",
            rate_limit_per_minute: 120,
            is_active: 1,
            expires_at: null,
            created_at: 90,
            updated_at: 90,
            last_used_at: null,
            last_used_route: null,
          },
        ],
      },
    ], { requireMatch: true });

    const listed = await listApiKeys(db, 1_000);

    expect(listed.keys).toHaveLength(2);
    expect(listed.keys[0]?.expiresAt).toBe(900);
    expect(listed.keys[1]?.expiresAt).toBeNull();
  });

  it("preserves the current expiry when rotating a key", async () => {
    const db = mockD1([
      {
        match: "key_prefix,\n       secret_hash,\n       name",
        matchBinds: [7],
        first: {
          id: 7,
          key_prefix: "0123456789abcdef",
          secret_hash: "hash",
          name: "Ops",
          owner_email: "ops@pharos.watch",
          tier: "standard",
          traffic_class: "external",
          rate_limit_per_minute: 120,
          is_active: 1,
          expires_at: 5_000,
          created_at: 1,
          updated_at: 1,
          last_used_at: 100,
          last_used_route: "/api/stablecoins",
        },
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
        first: {
          id: 7,
          key_prefix: "fedcba9876543210",
          name: "Ops",
          owner_email: "ops@pharos.watch",
          tier: "standard",
          traffic_class: "external",
          rate_limit_per_minute: 120,
          is_active: 1,
          expires_at: 5_000,
          created_at: 1,
          updated_at: 2_000,
          last_used_at: null,
          last_used_route: null,
        },
        rows: [],
      },
    ], { requireMatch: true });

    const rotated = await rotateApiKey(db, "pepper", 7, 2_000);

    expect(rotated).not.toBeInstanceOf(Response);
    expect((rotated as Exclude<typeof rotated, Response>).key.expiresAt).toBe(5_000);
  });

  it("returns 429 when the per-key minute bucket is exhausted", async () => {
    const db = mockD1([
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
    ], { requireMatch: true });

    const response = await checkApiKeyRateLimit(db, 7, 3, 600);
    expect(response?.status).toBe(429);
  });

  it("throttles last-used writes to avoid per-request metadata churn", async () => {
    const db = mockD1([
      {
        match: "UPDATE api_keys SET last_used_at = ?, last_used_route = ? WHERE id = ?",
        rows: [],
        runMeta: { changes: 1 },
      },
    ], { requireMatch: true });

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
});
