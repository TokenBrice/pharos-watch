import { describe, expect, it } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";
import {
  authenticateApiKey,
  checkApiKeyRateLimit,
  createApiKey,
  parseApiKeyToken,
  recordApiKeyUsage,
} from "../api-keys";

async function hmacSha256Hex(secret: string, input: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(input));
  return Array.from(new Uint8Array(signature), (value) => value.toString(16).padStart(2, "0")).join("");
}

describe("api key helpers", () => {
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
          rate_limit_per_minute: 180,
          is_active: 1,
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
      authenticateApiKey(db, "ph_live_0123456789abcdef_abcdefghijklmnopqrstuvwxyzABCDEF", pepper),
    ).resolves.toEqual({
      kind: "valid",
      key: {
        id: 7,
        keyPrefix: "0123456789abcdef",
        name: "Smoke",
        ownerEmail: "ops@pharos.watch",
        tier: "ci",
        rateLimitPerMinute: 180,
        isActive: true,
      },
    });
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
          rate_limit_per_minute: 90,
          is_active: 1,
          created_at: 111,
          updated_at: 111,
          last_used_at: null,
          last_used_route: null,
        },
        rows: [],
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
        rateLimitPerMinute: 90,
        isActive: true,
      },
    });
    expect(parseApiKeyToken((created as Exclude<typeof created, Response>).token)).not.toBeNull();
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
      rateLimitPerMinute: 120,
      isActive: true,
    };

    await recordApiKeyUsage(db, key, "/api/stablecoins", 1_000);
    await recordApiKeyUsage(db, key, "/api/stablecoins", 1_001);

    expect(db.getHistory().filter((entry) => entry.sql.includes("UPDATE api_keys SET last_used_at"))).toHaveLength(1);
  });
});
