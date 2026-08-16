import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../index";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { createWorkerEnv } from "../../test-helpers/__shared/worker-env";
import {
  hmacSha256Hex,
  makeApiRequest,
  makeExecutionContext,
  stubCryptoForAuth,
} from "../../test-helpers/__shared/auth";
import { makeApiKeyRow } from "../../test-helpers/__shared/fixtures";
import {
  handleApiKeyRotate,
  handleApiKeyUpdate,
  handleApiKeys,
  handleCredentialLifecycleSummary,
} from "./api-keys.test-helpers";
import { resetApiKeyStateForTests } from "../../lib/api-keys";
import { resetRequestAttributionStateForTests } from "../../lib/request-source-attribution";

stubCryptoForAuth();

function makeEnv(db: D1Database) {
  return createWorkerEnv({
    DB: db,
    API_KEY_HASH_PEPPER: "pepper",
    SITE_API_SHARED_SECRET: "site-secret",
  });
}

describe("api key handlers", () => {
  beforeEach(() => {
    resetApiKeyStateForTests();
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
          ],
        },
      ],
      { requireMatch: true },
    );

    const response = await handleApiKeys(
      db,
      true,
      makeApiRequest("/api/api-keys", { adminKey: "secret-key" }),
      "pepper",
    );
    const body = (await response.json()) as { keys: Array<{ expiresAt: number | null }> };

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]?.expiresAt).toBe(900);
  });

  it("returns counts-only credential lifecycle summary", async () => {
    const nowSec = 10_000;
    const db = mockD1(
      [
        {
          match: "ORDER BY created_at DESC, id DESC",
          rows: [
            makeApiKeyRow({ id: 1, is_active: 1, expires_at: nowSec + 90 * 86_400 }),
            makeApiKeyRow({ id: 2, is_active: 1, expires_at: nowSec + 2 * 86_400 }),
            makeApiKeyRow({ id: 3, is_active: 1, expires_at: nowSec - 86_400 }),
            makeApiKeyRow({ id: 4, is_active: 0, expires_at: null }),
          ],
        },
        {
          match: "SELECT COUNT(*) AS count",
          matchBinds: ["rotated", "deactivated", nowSec - 7 * 86_400],
          rows: [{ count: 2 }],
          first: { count: 2 },
        },
      ],
      { requireMatch: true },
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date(nowSec * 1000));

    const response = await handleCredentialLifecycleSummary(db, true);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toEqual({
      generatedAt: nowSec,
      totalKeys: 4,
      active: 3,
      expiringSoon: 1,
      expired: 1,
      nonExpiring: 1,
      auditAnomalies7d: 2,
    });
    expect(JSON.stringify(body)).not.toContain("ownerEmail");
    expect(JSON.stringify(body)).not.toContain("maskedToken");

    vi.useRealTimers();
  });

  it("creates keys with the default 90-day expiry when expiresAt is omitted", async () => {
    const nowSec = 2_000;
    const db = mockD1(
      [
        {
          match: "INSERT INTO api_keys",
          first: makeApiKeyRow({
            id: 5,
            key_prefix: "0011223344556677",
            name: "Default",
            expires_at: nowSec + 90 * 24 * 60 * 60,
            created_at: nowSec,
            updated_at: nowSec,
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
    const body = (await response.json()) as { key: { expiresAt: number | null } };

    expect(response.status).toBe(201);
    expect(body.key.expiresAt).toBe(nowSec + 90 * 24 * 60 * 60);
    vi.useRealTimers();
  });

  it("updates expiresAt through the admin handler", async () => {
    const db = mockD1(
      [
        {
          match: "key_prefix,\n       secret_hash,\n       name",
          matchBinds: [7],
          first: makeApiKeyRow({
            owner_email: "ops@pharos.watch",
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
            expires_at: 5_000,
            updated_at: 2_000,
          }),
          rows: [],
        },
      ],
      { requireMatch: true },
    );

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
    const body = (await response.json()) as { key: { expiresAt: number | null } };

    expect(response.status).toBe(200);
    expect(body.key.expiresAt).toBe(5_000);
  });

  it("rejects partially numeric rate-limit updates", async () => {
    const db = mockD1(
      [
        {
          match: "key_prefix,\n       secret_hash,\n       name",
          matchBinds: [7],
          first: makeApiKeyRow({
            owner_email: "ops@pharos.watch",
          }),
          rows: [],
        },
      ],
      { requireMatch: true },
    );

    const response = await handleApiKeyUpdate(
      db,
      7,
      true,
      makeApiRequest("/api/api-keys/7/update", {
        method: "POST",
        adminKey: "secret-key",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rateLimitPerMinute: "120abc" }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "rateLimitPerMinute must be an integer between 1 and 10000",
    });
  });

  it("preserves the current expiry when rotating a key", async () => {
    const db = mockD1(
      [
        {
          match: "FROM api_keys",
          matchBinds: [7],
          first: makeApiKeyRow({
            owner_email: "ops@pharos.watch",
            expires_at: 5_000,
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
    const body = (await response.json()) as { key: { expiresAt: number | null } };

    expect(response.status).toBe(200);
    expect(body.key.expiresAt).toBe(5_000);
  });

  it("reports rotation readback failure as unknown without exposing a replacement token", async () => {
    const db = mockD1(
      [
        {
          match: "key_prefix,\n       name,\n       owner_email",
          matchBinds: [7],
          first: null,
          rows: [],
        },
        {
          match: "key_prefix,\n       secret_hash,\n       name",
          matchBinds: [7],
          first: makeApiKeyRow({ owner_email: "ops@pharos.watch" }),
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
      ],
      { requireMatch: true },
    );

    const response = await handleApiKeyRotate(
      db,
      7,
      true,
      makeApiRequest("/api/api-keys/7/rotate", {
        method: "POST",
        adminKey: "secret-key",
      }),
      "pepper",
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(503);
    expect(response.headers.get("X-Execution-Certainty")).toBe("unknown");
    expect(body).toMatchObject({
      error: "api_key_post_write_readback_failed",
      recovery: expect.stringMatching(/prior token is revoked/i),
    });
    expect(body).not.toHaveProperty("token");
  });

  it("rejects expired keys in the real public fetch gate", async () => {
    const secret = "abcdefghijklmnopqrstuvwxyzABCDEF";
    const secretHash = await hmacSha256Hex("pepper", secret);
    const db = mockD1(
      [
        {
          match: "FROM api_keys",
          matchBinds: ["0123456789abcdef"],
          first: makeApiKeyRow({
            secret_hash: secretHash,
            name: "Expired",
            expires_at: 1,
          }),
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
        {
          match: "DELETE FROM api_key_request_stats",
          rows: [],
          runMeta: { changes: 0 },
        },
      ],
      { requireMatch: true },
    );
    const { ctx, waits } = makeExecutionContext();

    const response = await worker.fetch(
      new Request("https://api.pharos.watch/api/stablecoins", {
        headers: { "X-API-Key": "ph_live_0123456789abcdef_abcdefghijklmnopqrstuvwxyzABCDEF" },
      }),
      makeEnv(db),
      ctx,
    );

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/Unauthorized/);
    await Promise.all(waits);
  });
});
