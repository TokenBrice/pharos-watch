import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../index";
import { mockD1 } from "./helpers/mock-d1";
import { makeApiRequest, stubCryptoForAuth } from "./helpers/auth";
import {
  handleApiKeyRotate,
  handleApiKeyUpdate,
  handleApiKeys,
} from "../api-keys";
import { resetApiKeyStateForTests } from "../../lib/api-keys";
import { resetRateLimitStateForTests } from "../../lib/rate-limit";
import { resetRequestAttributionStateForTests } from "../../lib/request-source-attribution";

stubCryptoForAuth();

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

function makeCtx() {
  const waits: Promise<unknown>[] = [];
  return {
    waits,
    ctx: {
      waitUntil: vi.fn((promise: Promise<unknown>) => {
        waits.push(promise);
      }),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext,
  };
}

function makeEnv(db: D1Database) {
  return {
    DB: db,
    CORS_ORIGIN: "https://pharos.watch",
    PUBLIC_API_RATE_LIMIT_SALT: "test-salt",
    PUBLIC_API_AUTH_MODE: "enforce",
    API_KEY_HASH_PEPPER: "pepper",
    SITE_API_SHARED_SECRET: "site-secret",
  } as const;
}

describe("api key handlers", () => {
  beforeEach(() => {
    resetApiKeyStateForTests();
    resetRateLimitStateForTests();
    resetRequestAttributionStateForTests();
    vi.restoreAllMocks();
    vi.stubGlobal("caches", {
      default: {
        match: vi.fn(),
        put: vi.fn(async () => undefined),
      },
    });
  });

  it("lists keys including expired rows and exposes expiresAt", async () => {
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
        ],
      },
    ], { requireMatch: true });

    const response = await handleApiKeys(
      db,
      true,
      makeApiRequest("/api/api-keys", { adminKey: "secret-key" }),
      "pepper",
    );
    const body = await response.json() as { keys: Array<{ expiresAt: number | null }> };

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]?.expiresAt).toBe(900);
  });

  it("creates keys with the default 90-day expiry when expiresAt is omitted", async () => {
    const nowSec = 2_000;
    const db = mockD1([
      {
        match: "INSERT INTO api_keys",
        first: {
          id: 5,
          key_prefix: "0011223344556677",
          name: "Default",
          owner_email: null,
          tier: "standard",
          traffic_class: "external",
          rate_limit_per_minute: 120,
          is_active: 1,
          expires_at: nowSec + (90 * 24 * 60 * 60),
          created_at: nowSec,
          updated_at: nowSec,
          last_used_at: null,
          last_used_route: null,
        },
        rows: [],
      },
    ], { requireMatch: true });

    vi.useFakeTimers();
    vi.setSystemTime(new Date(nowSec * 1000));

    const response = await handleApiKeys(
      db,
      true,
      makeApiRequest("/api/api-keys", {
        method: "POST",
        adminKey: "secret-key",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Default" }),
      }),
      "pepper",
    );
    const body = await response.json() as { key: { expiresAt: number | null } };

    expect(response.status).toBe(201);
    expect(body.key.expiresAt).toBe(nowSec + (90 * 24 * 60 * 60));
    vi.useRealTimers();
  });

  it("updates expiresAt through the admin handler", async () => {
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
          expires_at: null,
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
          expires_at: 5_000,
          created_at: 1,
          updated_at: 2_000,
          last_used_at: null,
          last_used_route: null,
        },
        rows: [],
      },
    ], { requireMatch: true });

    const response = await handleApiKeyUpdate(
      db,
      7,
      true,
      makeApiRequest("/api/api-keys/7/update", {
        method: "POST",
        adminKey: "secret-key",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expiresAt: 5_000 }),
      }),
    );
    const body = await response.json() as { key: { expiresAt: number | null } };

    expect(response.status).toBe(200);
    expect(body.key.expiresAt).toBe(5_000);
  });

  it("preserves the current expiry when rotating a key", async () => {
    const db = mockD1([
      {
        match: "FROM api_keys",
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
        match: "SELECT id, key_prefix, name, owner_email, tier, traffic_class, rate_limit_per_minute, is_active, expires_at",
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

    const response = await handleApiKeyRotate(
      db,
      7,
      true,
      makeApiRequest("/api/api-keys/7/rotate", {
        method: "POST",
        adminKey: "secret-key",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expiresAt: 1 }),
      }),
      "pepper",
    );
    const body = await response.json() as { key: { expiresAt: number | null } };

    expect(response.status).toBe(200);
    expect(body.key.expiresAt).toBe(5_000);
  });

  it("rejects expired keys in the real public fetch gate", async () => {
    const secret = "abcdefghijklmnopqrstuvwxyzABCDEF";
    const secretHash = await hmacSha256Hex("pepper", secret);
    const db = mockD1([
      {
        match: "FROM api_keys",
        matchBinds: ["0123456789abcdef"],
        first: {
          id: 7,
          key_prefix: "0123456789abcdef",
          secret_hash: secretHash,
          name: "Expired",
          owner_email: null,
          tier: "standard",
          traffic_class: "external",
          rate_limit_per_minute: 120,
          is_active: 1,
          expires_at: 1,
          created_at: 1,
          updated_at: 1,
          last_used_at: null,
          last_used_route: null,
        },
        rows: [],
      },
      {
        match: "INSERT INTO api_request_consumer_stats",
        rows: [],
        runMeta: { changes: 1 },
      },
      {
        match: "DELETE FROM api_request_consumer_stats",
        rows: [],
        runMeta: { changes: 0 },
      },
    ], { requireMatch: true });
    const { ctx, waits } = makeCtx();

    const response = await worker.fetch(
      new Request("https://api.pharos.watch/api/stablecoins", {
        headers: { "X-API-Key": "ph_live_0123456789abcdef_abcdefghijklmnopqrstuvwxyzABCDEF" },
      }),
      makeEnv(db) as never,
      ctx,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    await Promise.all(waits);
  });
});
