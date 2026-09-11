import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../index";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { createWorkerEnv } from "../../test-helpers/__shared/worker-env";
import {
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
import {
  makeApiKeyMutationTables,
  makeApiKeyPrefixLookup,
  makeAuthenticatedApiKeyRow,
  makeRequestAttributionTables,
} from "../../test-helpers/api-key-test-support";
import { resetApiKeyStateForTests } from "../../lib/api-keys";
import { resetRequestAttributionStateForTests } from "../../lib/request-source-attribution";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => {
  fixtures.closeAll();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

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
    const body = (await readJsonResponse(response, 200)) as { keys: Array<{ expiresAt: number | null }> };

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
    const body = (await readJsonResponse(response, 200)) as Record<string, unknown>;

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
    const { sqlite, db } = fixtures.open();

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
    const body = (await readJsonResponse(response, 201)) as { key: { expiresAt: number | null } };

    expect(body.key.expiresAt).toBe(nowSec + 90 * 24 * 60 * 60);
    expect(sqlite.prepare("SELECT expires_at FROM api_keys").get()).toEqual({
      expires_at: nowSec + 90 * 24 * 60 * 60,
    });
    vi.useRealTimers();
  });

  it("updates expiresAt through the admin handler", async () => {
    const { sqlite, db } = fixtures.open();
    sqlite.exec(`INSERT INTO api_keys
      (id, key_prefix, secret_hash, name, created_at, updated_at, expires_at)
      VALUES (7, '0011223344556677', 'hash', 'Ops', 1000, 1000, 3000)`);

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
    const body = (await readJsonResponse(response, 200)) as { key: { expiresAt: number | null } };

    expect(body.key.expiresAt).toBe(5_000);
    expect(sqlite.prepare("SELECT expires_at FROM api_keys WHERE id = 7").get()).toEqual({ expires_at: 5_000 });
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
    const { sqlite, db } = fixtures.open();
    sqlite.exec(`INSERT INTO api_keys
      (id, key_prefix, secret_hash, name, created_at, updated_at, expires_at)
      VALUES (7, '0011223344556677', 'hash', 'Ops', 1000, 1000, 5000)`);

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
    const body = (await readJsonResponse(response, 200)) as { key: { expiresAt: number | null } };

    expect(body.key.expiresAt).toBe(5_000);
    expect(sqlite.prepare("SELECT expires_at FROM api_keys WHERE id = 7").get()).toEqual({ expires_at: 5_000 });
  });

  it("reports rotation readback failure as unknown without exposing a replacement token", async () => {
    const db = mockD1(
      [
        ...makeApiKeyMutationTables({
          existingRow: { owner_email: "ops@pharos.watch" },
          postMutationRow: null,
        }),
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
    const body = (await readJsonResponse(response, 503)) as Record<string, unknown>;

    expect(response.headers.get("X-Execution-Certainty")).toBe("unknown");
    expect(body).toMatchObject({
      error: "api_key_post_write_readback_failed",
      recovery: expect.stringMatching(/prior token is revoked/i),
    });
    expect(body).not.toHaveProperty("token");
  });

  it("rejects expired keys in the real public fetch gate", async () => {
    const secret = "abcdefghijklmnopqrstuvwxyzABCDEF";
    const db = mockD1(
      [
        makeApiKeyPrefixLookup({
          prefix: "0123456789abcdef",
          row: await makeAuthenticatedApiKeyRow({
            pepper: "pepper",
            secret,
            name: "Expired",
            expires_at: 1,
          }),
        }),
        ...makeRequestAttributionTables(),
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

    const body = (await readJsonResponse(response, 401)) as { error: string };
    expect(body.error).toMatch(/Unauthorized/);
    await Promise.all(waits);
  });
});
