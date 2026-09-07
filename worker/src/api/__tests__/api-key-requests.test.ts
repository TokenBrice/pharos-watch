import { makeJsonRequest, readJsonResponse } from "../../test-helpers/__shared/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  handleApiKeyRequest,
  handleApiKeyRequestReject,
  handleApiKeyRequestsAdmin,
  handleApiKeyRequestVerify,
} from "../api-key-requests";
import { redactProviderBody } from "../api-key-requests/email";
import type { ApiKeySelfServeEnv } from "../api-key-requests/types";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";
import { makeNoopD1 } from "../../test-helpers/noop-d1";
import { mockFetch } from "@shared/test-utils/mock-fetch";

function setupSqlite(): DatabaseSync {
  return createLatestSchemaSqlite().sqlite;
}

function env(overrides: Partial<ApiKeySelfServeEnv> = {}): ApiKeySelfServeEnv {
  return {
    API_KEY_SELF_SERVE_IP_SALT: "ip-salt",
    API_KEY_SELF_SERVE_EMAIL_HASH_PEPPER: "email-pepper",
    API_KEY_SELF_SERVE_REQUEST_PEPPER: "request-pepper",
    API_KEY_SELF_SERVE_EMAIL_FROM: "Pharos API <api@mail.pharos.watch>",
    API_KEY_SELF_SERVE_EMAIL_REPLY_TO: "api@mail.pharos.watch",
    API_KEY_SELF_SERVE_PUBLIC_BASE_URL: "https://pharos.watch/api",
    RESEND_API_KEY: "re_test",
    ...overrides,
  };
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    email: "Builder@Example.com",
    requesterName: "Builder",
    organization: "Example Lab",
    projectUrl: "https://example.com",
    useCase: "I am building a stablecoin monitoring dashboard and need periodic read access.",
    expectedCadence: "hourly",
    expectedVolume: "A few hundred reads per day.",
    acceptedTerms: true,
    ...overrides,
  };
}

function postRequest(path: string, body: unknown, headers: Record<string, string> = {}) {
  return makeJsonRequest(`https://api.pharos.watch${path}`, body, {
    headers: { "CF-Connecting-IP": "203.0.113.10", "User-Agent": "vitest", ...headers },
  });
}

function rawPostRequest(path: string, body: BodyInit, headers: Record<string, string> = {}) {
  return new Request(`https://api.pharos.watch${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": "203.0.113.10",
      "User-Agent": "vitest",
      ...headers,
    },
    body,
  });
}

function throwingD1(): D1Database {
  const reject = () => {
    throw new Error("D1 should not be touched");
  };
  return makeNoopD1({
    prepare: reject,
    batch: reject,
    exec: reject,
    dump: reject,
  });
}

function extractVerificationToken(sentBody: unknown): string {
  const text = (sentBody as { text: string }).text;
  const match = text.match(/https:\/\/pharos\.watch\/api\/#(akv_[A-Za-z0-9_-]+)/);
  if (!match?.[1]) throw new Error(`verification URL missing from email body: ${text}`);
  return match[1];
}

describe("api key self-serve request handlers", () => {
  let sqlite: DatabaseSync;
  let db: D1Database;
  let sentEmails: unknown[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2_000_000_000 * 1000));
    sqlite = setupSqlite();
    db = createSqliteD1(sqlite);
    sentEmails = [];
    mockFetch([{
      match: "https://api.resend.com/emails",
      respond: async (request) => {
        sentEmails.push(await request.clone().json());
        return { body: { id: "email_123" } };
      },
    }], { requireMatch: true });
  });

  afterEach(() => {
    sqlite.close();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("creates only a pending verification request and email claim on initial request", async () => {
    const response = await handleApiKeyRequest(db, postRequest("/api/api-key-requests", validBody()), env());
    const body = await readJsonResponse(response, 202) as { status: string; requestId?: string };

    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body.status).toBe("pending_verification");
    expect(body.requestId).toBeUndefined();
    expect(sentEmails).toHaveLength(1);

    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM api_keys").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT status, normalized_email, email_verified, email_provider_message_id FROM api_key_requests").get()).toEqual({
      status: "pending_verification",
      normalized_email: "builder@example.com",
      email_verified: 0,
      email_provider_message_id: "email_123",
    });
    expect(sqlite.prepare("SELECT status FROM api_key_self_serve_email_claims").get()).toEqual({
      status: "pending_verification",
    });
    expect((sentEmails[0] as { text: string }).text).toContain("https://pharos.watch/api/#akv_");
  });

  it("returns no-store 400 for invalid initial request JSON", async () => {
    const response = await handleApiKeyRequest(
      throwingD1(),
      rawPostRequest("/api/api-key-requests", "{"),
      env(),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "Invalid JSON body" });
    expect(sentEmails).toHaveLength(0);
  });

  it("returns no-store 400 for invalid verify request JSON", async () => {
    const response = await handleApiKeyRequestVerify(
      throwingD1(),
      rawPostRequest("/api/api-key-requests/verify", "{"),
      env(),
      "api-key-pepper",
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "Invalid JSON body" });
    expect(sentEmails).toHaveLength(0);
  });

  it("returns no-store 413 for oversized initial request bodies before side effects", async () => {
    const response = await handleApiKeyRequest(
      throwingD1(),
      rawPostRequest(
        "/api/api-key-requests",
        JSON.stringify(validBody()),
        { "Content-Length": String(17 * 1024) },
      ),
      env(),
    );

    expect(response.status).toBe(413);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "Request body too large" });
    expect(sentEmails).toHaveLength(0);
  });

  it("returns no-store 413 for oversized verify bodies before side effects", async () => {
    const response = await handleApiKeyRequestVerify(
      throwingD1(),
      rawPostRequest(
        "/api/api-key-requests/verify",
        JSON.stringify({ token: "akv_example_verification_token" }),
        { "Content-Length": "2048" },
      ),
      env(),
      "api-key-pepper",
    );

    expect(response.status).toBe(413);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "Request body too large" });
    expect(sentEmails).toHaveLength(0);
  });

  it("accepts concise human-readable use cases", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const response = await handleApiKeyRequest(db, postRequest("/api/api-key-requests", validBody({
      email: `concise-${suffix}@example.com`,
      useCase: `index QA workflow ${suffix}`,
    })), env());

    expect(response.status).toBe(202);
    expect(sentEmails).toHaveLength(1);
  });

  it("accepts and ignores the legacy intendedEndpoints note from stale bundles", async () => {
    // The note had no reader left and was removed 2026-08-10, but the request
    // schema is `.strict()` and the site is a static export: a browser holding
    // the old bundle must still submit successfully.
    const response = await handleApiKeyRequest(db, postRequest("/api/api-key-requests", validBody({
      email: "template@example.com",
      intendedEndpoints: ["/api/stablecoin/:id", "whatever I plan to call"],
    })), env());

    expect(response.status).toBe(202);
  });

  it("issues a constrained self-serve key only after token verification", async () => {
    const pending = await handleApiKeyRequest(db, postRequest("/api/api-key-requests", validBody()), env());
    expect(pending.status).toBe(202);
    const token = extractVerificationToken(sentEmails[0]);

    const response = await handleApiKeyRequestVerify(
      db,
      postRequest("/api/api-key-requests/verify", { token }),
      env(),
      "api-key-pepper",
    );
    const body = await readJsonResponse(response, 201) as {
      requestId?: string;
      token: string;
      key: Record<string, unknown> & { tier: string; rateLimitPerMinute: number; expiresAt: number };
    };

    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body.requestId).toBeUndefined();
    expect(body.token).toMatch(/^ph_live_[0-9a-f]{16}_[A-Za-z0-9_-]{32}$/);
    expect(body.key.tier).toBe("self-serve");
    expect(body.key.rateLimitPerMinute).toBe(30);
    expect(body.key.expiresAt).toBe(2_000_000_000 + (60 * 24 * 60 * 60));
    expect(body.key).not.toHaveProperty("id");
    expect(body.key).not.toHaveProperty("name");
    expect(body.key).not.toHaveProperty("ownerEmail");
    expect(body.key).not.toHaveProperty("isActive");
    expect(body.key).not.toHaveProperty("createdAt");
    expect(body.key).not.toHaveProperty("updatedAt");
    expect(body.key).not.toHaveProperty("lastUsedAt");
    expect(body.key).not.toHaveProperty("lastUsedRoute");

    expect(sqlite.prepare("SELECT tier, traffic_class, rate_limit_per_minute, is_active FROM api_keys").get()).toEqual({
      tier: "self-serve",
      traffic_class: "external",
      rate_limit_per_minute: 30,
      is_active: 1,
    });
    expect(sqlite.prepare("SELECT status, email_verified, verification_token_hash FROM api_key_requests").get()).toEqual({
      status: "issued",
      email_verified: 1,
      verification_token_hash: null,
    });
    expect(sqlite.prepare("SELECT status FROM api_key_self_serve_email_claims").get()).toEqual({ status: "issued" });
    expect(sqlite.prepare("SELECT actor FROM api_key_audit_log").get()).toEqual({ actor: "self-serve" });
  });

  it("finalizes the self-serve request before activating the returned key", async () => {
    const runSqlLog: string[] = [];
    db = createSqliteD1(sqlite, { onRun: (sql) => runSqlLog.push(sql) });
    await handleApiKeyRequest(db, postRequest("/api/api-key-requests", validBody()), env());
    const token = extractVerificationToken(sentEmails[0]);

    const response = await handleApiKeyRequestVerify(
      db,
      postRequest("/api/api-key-requests/verify", { token }),
      env(),
      "api-key-pepper",
    );

    expect(response.status).toBe(201);
    const requestFinalizeIndex = runSqlLog.findIndex((sql) =>
      sql.includes("UPDATE api_key_requests")
      && sql.includes("SET status = 'issued'")
    );
    const keyActivationIndex = runSqlLog.findIndex((sql) =>
      sql.includes("UPDATE api_keys SET is_active = 1")
    );
    expect(requestFinalizeIndex).toBeGreaterThan(-1);
    expect(keyActivationIndex).toBeGreaterThan(-1);
    expect(keyActivationIndex).toBeGreaterThan(requestFinalizeIndex);
  });

  it("fails closed without an active orphan when final activation fails", async () => {
    await handleApiKeyRequest(db, postRequest("/api/api-key-requests", validBody()), env());
    const token = extractVerificationToken(sentEmails[0]);
    sqlite.exec(`
      CREATE TRIGGER deny_self_serve_activation
      BEFORE UPDATE OF is_active ON api_keys
      WHEN NEW.is_active = 1
      BEGIN
        SELECT RAISE(IGNORE);
      END;
    `);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await handleApiKeyRequestVerify(
      db,
      postRequest("/api/api-key-requests/verify", { token }),
      env(),
      "api-key-pepper",
    );
    const body = await readJsonResponse(response, 503) as { token?: string };

    expect(body.token).toBeUndefined();
    expect(sqlite.prepare("SELECT is_active FROM api_keys").get()).toEqual({ is_active: 0 });
    expect(sqlite.prepare("SELECT status, verification_token_hash, issuance_locked_at FROM api_key_requests").get()).toEqual({
      status: "blocked",
      verification_token_hash: null,
      issuance_locked_at: null,
    });
    expect(sqlite.prepare("SELECT status FROM api_key_self_serve_email_claims").get()).toEqual({ status: "released" });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("\"event\":\"api_key_request_issuance_consistency_failed\""),
    );
    errorSpy.mockRestore();
  });

  it("returns a non-enumerating pending response for duplicate pending emails", async () => {
    const first = await handleApiKeyRequest(db, postRequest("/api/api-key-requests", validBody()), env());
    expect(first.status).toBe(202);

    const second = await handleApiKeyRequest(db, postRequest("/api/api-key-requests", validBody({
      email: "builder@example.com",
    })), env());

    expect(second.status).toBe(202);
    await expect(second.json()).resolves.toEqual({
      status: "pending_verification",
      message: "If this address can receive verification email, check your inbox to continue.",
    });
    expect(sentEmails).toHaveLength(1);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM api_key_requests").get()).toEqual({ count: 1 });
  });

  it("returns honeypot success without creating a request", async () => {
    const response = await handleApiKeyRequest(db, postRequest("/api/api-key-requests", validBody({
      website: "https://bot.example",
    })), env());

    expect(response.status).toBe(200);
    expect(sentEmails).toHaveLength(0);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM api_key_requests").get()).toEqual({ count: 0 });
  });

  it("rejects oversized honeypot fields before side effects", async () => {
    const response = await handleApiKeyRequest(
      throwingD1(),
      postRequest("/api/api-key-requests", validBody({
        website: "x".repeat(301),
      })),
      env(),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(sentEmails).toHaveLength(0);
  });

  it("releases stale orphan pending claims via the deferred waitUntil sweep", async () => {
    sqlite.prepare(
      `INSERT INTO api_key_self_serve_email_claims (
        email_hash,
        normalized_email,
        api_key_id,
        request_id,
        status,
        claimed_at,
        released_at,
        updated_at
      ) VALUES (?, ?, NULL, ?, 'pending_verification', ?, NULL, ?)`,
    ).run("orphan-hash", "orphan@example.com", "akr_orphan", 2_000_000_000 - 601, 2_000_000_000 - 601);

    const deferred: Promise<unknown>[] = [];
    const execCtx = { waitUntil: (promise: Promise<unknown>) => deferred.push(promise) } as unknown as ExecutionContext;
    const response = await handleApiKeyRequest(db, postRequest("/api/api-key-requests", validBody()), env(), execCtx);
    await Promise.all(deferred);

    expect(response.status).toBe(202);
    expect(sqlite.prepare("SELECT status FROM api_key_self_serve_email_claims WHERE request_id = 'akr_orphan'").get()).toEqual({
      status: "released",
    });
  });

  it("fails closed when required email provider config is missing", async () => {
    const response = await handleApiKeyRequest(db, postRequest("/api/api-key-requests", validBody()), env({
      RESEND_API_KEY: undefined,
    }));

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM api_key_requests").get()).toEqual({ count: 0 });
  });

  it("adds Retry-After on submission throttles", async () => {
    for (let index = 0; index < 5; index += 1) {
      const response = await handleApiKeyRequest(db, postRequest("/api/api-key-requests", validBody({
        email: `builder-${index}@example.com`,
      })), env());
      expect(response.status).toBe(202);
    }

    const throttled = await handleApiKeyRequest(db, postRequest("/api/api-key-requests", validBody({
      email: "builder-over-limit@example.com",
    })), env());

    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("Retry-After")).toBe("1600");
  });

  it("denies the fixed-window issuance IP cap without burning the verification token", async () => {
    await handleApiKeyRequest(db, postRequest("/api/api-key-requests", validBody({
      email: "first@example.com",
    })), env());
    const firstToken = extractVerificationToken(sentEmails[0]);
    const firstIssued = await handleApiKeyRequestVerify(
      db,
      postRequest("/api/api-key-requests/verify", { token: firstToken }),
      env(),
      "api-key-pepper",
    );
    expect(firstIssued.status).toBe(201);

    await handleApiKeyRequest(db, postRequest("/api/api-key-requests", validBody({
      email: "second@example.com",
    })), env());
    const secondToken = extractVerificationToken(sentEmails[1]);
    const denied = await handleApiKeyRequestVerify(
      db,
      postRequest("/api/api-key-requests/verify", { token: secondToken }),
      env(),
      "api-key-pepper",
    );

    expect(denied.status).toBe(429);
    expect(denied.headers.get("Retry-After")).toBe("73600");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM api_keys").get()).toEqual({ count: 1 });
    const secondRequest = sqlite.prepare(
      "SELECT verification_token_hash, status FROM api_key_requests WHERE normalized_email = 'second@example.com'",
    ).get() as { verification_token_hash: string | null; status: string };
    expect(secondRequest.status).toBe("pending_verification");
    expect(secondRequest.verification_token_hash).not.toBeNull();
  });

  it("releases active but expired issued claims before accepting a new same-email request", async () => {
    await handleApiKeyRequest(db, postRequest("/api/api-key-requests", validBody()), env());
    const token = extractVerificationToken(sentEmails[0]);
    const issued = await handleApiKeyRequestVerify(
      db,
      postRequest("/api/api-key-requests/verify", { token }),
      env(),
      "api-key-pepper",
    );
    expect(issued.status).toBe(201);
    sqlite.prepare("UPDATE api_keys SET expires_at = ? WHERE tier = 'self-serve'").run(2_000_000_000 - 1);

    const next = await handleApiKeyRequest(db, postRequest("/api/api-key-requests", validBody()), env());

    expect(next.status).toBe(202);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM api_key_requests").get()).toEqual({ count: 2 });
    expect(sqlite.prepare("SELECT status FROM api_key_self_serve_email_claims").get()).toEqual({
      status: "pending_verification",
    });
  });

  it("redacts sensitive provider error details before logging", () => {
    expect(redactProviderBody(
      "builder@example.com https://pharos.watch/api/#akv_secret ph_live_0123456789abcdef_abcdefghijklmnopqrstuvwxyzABCDEF",
    )).toBe("[redacted-email] [redacted-url] [redacted-api-key]");
  });

  it("does not create or return a token when claim validation storage fails", async () => {
    await handleApiKeyRequest(db, postRequest("/api/api-key-requests", validBody()), env());
    const token = extractVerificationToken(sentEmails[0]);
    sqlite.exec("DROP TABLE api_key_self_serve_email_claims");

    const response = await handleApiKeyRequestVerify(
      db,
      postRequest("/api/api-key-requests/verify", { token }),
      env(),
      "api-key-pepper",
    );
    const body = await readJsonResponse(response, 503) as { token?: string };

    expect(body.token).toBeUndefined();
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM api_keys").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT status FROM api_key_requests").get()).toEqual({ status: "pending_verification" });
  });

  it("lists private request rows through the admin handler without plaintext tokens", async () => {
    await handleApiKeyRequest(db, postRequest("/api/api-key-requests", validBody()), env());

    const response = await handleApiKeyRequestsAdmin(
      db,
      true,
      new Request("https://api.pharos.watch/api/api-key-requests-admin"),
    );
    const body = await readJsonResponse(response, 200) as { requests: Array<{ email: string; token?: string; useCase: string }> };

    expect(body.requests).toHaveLength(1);
    expect(body.requests[0]?.email).toBe("builder@example.com");
    expect(body.requests[0]?.useCase).toContain("stablecoin monitoring");
    expect(body.requests[0]?.token).toBeUndefined();
  });

  it("lets admins reject a pending request and releases its claim", async () => {
    const pending = await handleApiKeyRequest(db, postRequest("/api/api-key-requests", validBody()), env());
    expect(pending.status).toBe(202);
    const { request_id: requestId } = sqlite.prepare("SELECT request_id FROM api_key_requests").get() as { request_id: string };

    const response = await handleApiKeyRequestReject(
      db,
      requestId,
      true,
      postRequest(`/api/api-key-requests-admin/${requestId}/reject`, {}, { "X-Pharos-Admin": "1" }),
    );

    expect(response.status).toBe(200);
    expect(sqlite.prepare("SELECT status FROM api_key_requests").get()).toEqual({ status: "rejected" });
    expect(sqlite.prepare("SELECT status FROM api_key_self_serve_email_claims").get()).toEqual({ status: "released" });
    const audit = sqlite.prepare("SELECT action, target, details_json FROM admin_action_audit").get() as {
      action: string;
      target: string;
      details_json: string;
    };
    expect(audit.action).toBe("api_key_request_reject");
    expect(audit.target).toBe(requestId);
    expect(JSON.parse(audit.details_json)).toMatchObject({ status: "rejected", claimStatus: "released" });
  });

  it("replays admin reject through the idempotency layer", async () => {
    const pending = await handleApiKeyRequest(db, postRequest("/api/api-key-requests", validBody()), env());
    expect(pending.status).toBe(202);
    const { request_id: requestId } = sqlite.prepare("SELECT request_id FROM api_key_requests").get() as { request_id: string };
    const rejectRequest = () => postRequest(
      `/api/api-key-requests-admin/${requestId}/reject`,
      { reason: "duplicate submission" },
      { "X-Pharos-Admin": "1", "Idempotency-Key": "reject-once" },
    );

    const first = await handleApiKeyRequestReject(db, requestId, true, rejectRequest());
    const second = await handleApiKeyRequestReject(db, requestId, true, rejectRequest());

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers.get("X-Idempotent-Replay")).toBe("true");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM admin_action_audit").get()).toEqual({ count: 1 });
  });

  it("records admin audit rows when retrying an already rejected request", async () => {
    const pending = await handleApiKeyRequest(db, postRequest("/api/api-key-requests", validBody()), env());
    expect(pending.status).toBe(202);
    const { request_id: requestId } = sqlite.prepare("SELECT request_id FROM api_key_requests").get() as { request_id: string };

    const first = await handleApiKeyRequestReject(
      db,
      requestId,
      true,
      postRequest(`/api/api-key-requests-admin/${requestId}/reject`, { reason: "policy mismatch" }, { "X-Pharos-Admin": "1" }),
    );
    const second = await handleApiKeyRequestReject(
      db,
      requestId,
      true,
      postRequest(`/api/api-key-requests-admin/${requestId}/reject`, { reason: "retry after timeout" }, { "X-Pharos-Admin": "1" }),
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const audits = sqlite.prepare(
      "SELECT action, target, details_json FROM admin_action_audit ORDER BY id",
    ).all() as Array<{ action: string; target: string; details_json: string }>;
    expect(audits).toHaveLength(2);
    expect(audits[1]?.action).toBe("api_key_request_reject");
    expect(audits[1]?.target).toBe(requestId);
    expect(JSON.parse(audits[1]?.details_json ?? "{}")).toMatchObject({
      status: "rejected",
      claimStatus: "released",
      reason: "retry after timeout",
    });
  });

  it("leaves the linked key active when the status flip loses a race (0 rows changed)", async () => {
    await handleApiKeyRequest(db, postRequest("/api/api-key-requests", validBody()), env());
    const token = extractVerificationToken(sentEmails[0]);
    const issued = await handleApiKeyRequestVerify(
      db,
      postRequest("/api/api-key-requests/verify", { token }),
      env(),
      "api-key-pepper",
    );
    expect(issued.status).toBe(201);
    const { request_id: requestId } = sqlite.prepare("SELECT request_id FROM api_key_requests").get() as { request_id: string };

    // Simulate a concurrent status change between the initial select and the
    // status-flip UPDATE: the moment the reject UPDATE is prepared, flip the
    // request to a terminal status so the WHERE clause matches 0 rows.
    const racingDb = makeNoopD1({
      ...db,
      prepare: (sql: string) => {
        if (sql.includes("UPDATE api_key_requests SET status = 'rejected'")) {
          sqlite.prepare("UPDATE api_key_requests SET status = 'expired' WHERE request_id = ?").run(requestId);
        }
        return db.prepare(sql);
      },
    });

    const response = await handleApiKeyRequestReject(
      racingDb,
      requestId,
      true,
      postRequest(`/api/api-key-requests-admin/${requestId}/reject`, {}, { "X-Pharos-Admin": "1" }),
    );

    expect(response.status).toBe(409);
    // The key must NOT have been deactivated and no revocation marker written,
    // because the status flip short-circuited before any key mutation.
    expect(sqlite.prepare("SELECT is_active FROM api_keys").get()).toEqual({ is_active: 1 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM api_key_self_serve_revocations").get()).toEqual({ count: 0 });
  });

  it("deactivates and records a revocation marker when admins reject an issued self-serve request", async () => {
    await handleApiKeyRequest(db, postRequest("/api/api-key-requests", validBody()), env());
    const token = extractVerificationToken(sentEmails[0]);
    const issued = await handleApiKeyRequestVerify(
      db,
      postRequest("/api/api-key-requests/verify", { token }),
      env(),
      "api-key-pepper",
    );
    expect(issued.status).toBe(201);
    const { request_id: requestId } = sqlite.prepare("SELECT request_id FROM api_key_requests").get() as { request_id: string };

    const response = await handleApiKeyRequestReject(
      db,
      requestId,
      true,
      postRequest(`/api/api-key-requests-admin/${requestId}/reject`, {}, { "X-Pharos-Admin": "1" }),
    );

    expect(response.status).toBe(200);
    expect(sqlite.prepare("SELECT status FROM api_key_requests").get()).toEqual({ status: "rejected" });
    expect(sqlite.prepare("SELECT is_active FROM api_keys").get()).toEqual({ is_active: 0 });
    expect(sqlite.prepare("SELECT reason FROM api_key_self_serve_revocations").get()).toEqual({ reason: "admin_reject" });
    expect(sqlite.prepare("SELECT status FROM api_key_self_serve_email_claims").get()).toEqual({ status: "released" });
  });

  it("repairs linked key revocation when retrying a partially failed reject", async () => {
    await handleApiKeyRequest(db, postRequest("/api/api-key-requests", validBody()), env());
    const token = extractVerificationToken(sentEmails[0]);
    const issued = await handleApiKeyRequestVerify(
      db,
      postRequest("/api/api-key-requests/verify", { token }),
      env(),
      "api-key-pepper",
    );
    expect(issued.status).toBe(201);
    const { request_id: requestId } = sqlite.prepare("SELECT request_id FROM api_key_requests").get() as { request_id: string };

    const failRevocationDb = makeNoopD1({
      ...db,
      prepare: (sql: string) => {
        const statement = db.prepare(sql);
        if (!sql.includes("INSERT INTO api_key_self_serve_revocations")) {
          return statement;
        }
        return {
          ...statement,
          bind: (...values: unknown[]) => {
            const bound = statement.bind(...values);
            return {
              ...bound,
              run: async () => {
                throw new Error("injected revocation write failure");
              },
            };
          },
        };
      },
    });

    const failedReject = await handleApiKeyRequestReject(
      failRevocationDb,
      requestId,
      true,
      postRequest(`/api/api-key-requests-admin/${requestId}/reject`, {}, { "X-Pharos-Admin": "1" }),
    );
    expect(failedReject.status).toBe(500);
    expect(sqlite.prepare("SELECT status FROM api_key_requests").get()).toEqual({ status: "rejected" });
    expect(sqlite.prepare("SELECT is_active FROM api_keys").get()).toEqual({ is_active: 1 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM api_key_self_serve_revocations").get()).toEqual({ count: 0 });

    const retry = await handleApiKeyRequestReject(
      db,
      requestId,
      true,
      postRequest(`/api/api-key-requests-admin/${requestId}/reject`, {}, { "X-Pharos-Admin": "1" }),
    );

    expect(retry.status).toBe(200);
    expect(sqlite.prepare("SELECT status FROM api_key_requests").get()).toEqual({ status: "rejected" });
    expect(sqlite.prepare("SELECT is_active FROM api_keys").get()).toEqual({ is_active: 0 });
    expect(sqlite.prepare("SELECT reason FROM api_key_self_serve_revocations").get()).toEqual({ reason: "admin_reject" });
    expect(sqlite.prepare("SELECT status FROM api_key_self_serve_email_claims").get()).toEqual({ status: "released" });
  });
});
