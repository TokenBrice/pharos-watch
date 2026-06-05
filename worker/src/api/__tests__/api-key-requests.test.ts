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

interface SqliteD1Statement {
  bind(...values: unknown[]): SqliteD1Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}

function createSqliteD1(sqlite: DatabaseSync, runSqlLog: string[] = []): D1Database {
  function makeStatement(sql: string, values: unknown[] = []): SqliteD1Statement {
    return {
      bind: (...nextValues: unknown[]) => makeStatement(sql, nextValues),
      first: async <T>() => (sqlite.prepare(sql).get(...(values as never[])) ?? null) as T | null,
      all: async <T>() => ({ results: sqlite.prepare(sql).all(...(values as never[])) as T[] }),
      run: async () => {
        runSqlLog.push(sql);
        const result = sqlite.prepare(sql).run(...(values as never[]));
        return { meta: { changes: Number(result.changes) } };
      },
    };
  }
  return {
    prepare: (sql: string) => makeStatement(sql),
    batch: async (statements: D1PreparedStatement[]) => Promise.all(statements.map((statement) => statement.run())),
    exec: async (sql: string) => {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;
}

function setupSqlite(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_prefix TEXT NOT NULL,
      secret_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      owner_email TEXT,
      tier TEXT NOT NULL,
      traffic_class TEXT NOT NULL,
      rate_limit_per_minute INTEGER NOT NULL,
      is_active INTEGER NOT NULL,
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_used_at INTEGER,
      last_used_route TEXT,
      pepper_version INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE api_key_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      api_key_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      detail_json TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE admin_action_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT,
      result TEXT NOT NULL CHECK (result IN ('ok', 'error')),
      http_status INTEGER,
      details_json TEXT
    );

    CREATE TABLE admin_idempotency_keys (
      action TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      response_status INTEGER NOT NULL,
      response_body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (action, idempotency_key)
    );

    CREATE TABLE api_key_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL UNIQUE,
      api_key_id INTEGER,
      status TEXT NOT NULL CHECK (status IN ('pending_verification', 'issued', 'rejected', 'blocked', 'expired')),
      normalized_email TEXT NOT NULL,
      email_hash TEXT NOT NULL,
      email_verified INTEGER NOT NULL DEFAULT 0,
      requester_name TEXT,
      organization TEXT,
      project_url TEXT,
      use_case TEXT NOT NULL,
      intended_endpoints_json TEXT,
      expected_cadence TEXT,
      expected_volume TEXT,
      accepted_terms INTEGER NOT NULL DEFAULT 0,
      self_serve_rate_limit_per_minute INTEGER NOT NULL,
      self_serve_expires_at INTEGER,
      ip_hash TEXT NOT NULL,
      user_agent_hash TEXT,
      honeypot_triggered INTEGER NOT NULL DEFAULT 0,
      risk_score INTEGER NOT NULL DEFAULT 0,
      risk_reasons_json TEXT,
      verification_token_hash TEXT,
      verification_sent_at INTEGER,
      verification_expires_at INTEGER,
      issuance_locked_at INTEGER,
      email_provider_message_id TEXT,
      issued_at INTEGER,
      rejected_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE api_key_request_rate_limit_v2 (
      scope TEXT NOT NULL CHECK (scope IN ('ip', 'email', 'token', 'submission_ip', 'submission_email', 'verification_ip', 'verification_token')),
      subject_hash TEXT NOT NULL,
      bucket_start INTEGER NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      last_seen_at INTEGER NOT NULL,
      PRIMARY KEY (scope, subject_hash, bucket_start)
    );

    CREATE TABLE api_key_self_serve_email_claims (
      email_hash TEXT PRIMARY KEY,
      normalized_email TEXT NOT NULL,
      api_key_id INTEGER,
      request_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending_verification', 'issued', 'released')),
      claimed_at INTEGER NOT NULL,
      released_at INTEGER,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE api_key_self_serve_revocations (
      key_prefix TEXT PRIMARY KEY,
      api_key_id INTEGER NOT NULL,
      request_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      revoked_at INTEGER NOT NULL
    );

    CREATE TABLE api_key_self_serve_issuance_limits (
      scope TEXT NOT NULL CHECK (scope IN ('submission_ip_daily')),
      subject_hash TEXT NOT NULL,
      bucket_start INTEGER NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (scope, subject_hash, bucket_start)
    );
  `);
  return sqlite;
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
    intendedEndpoints: ["/api/stablecoins", "/api/peg-summary"],
    expectedCadence: "hourly",
    expectedVolume: "A few hundred reads per day.",
    acceptedTerms: true,
    ...overrides,
  };
}

function postRequest(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://api.pharos.watch${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": "203.0.113.10",
      "User-Agent": "vitest",
      ...headers,
    },
    body: JSON.stringify(body),
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
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      sentEmails.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: "email_123" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }));
  });

  afterEach(() => {
    sqlite.close();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("creates only a pending verification request and email claim on initial request", async () => {
    const response = await handleApiKeyRequest(db, postRequest("/api/api-key-requests", validBody()), env());
    const body = await response.json() as { status: string; requestId?: string };

    expect(response.status).toBe(202);
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

  it("accepts concise human-readable use cases", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const response = await handleApiKeyRequest(db, postRequest("/api/api-key-requests", validBody({
      email: `concise-${suffix}@example.com`,
      useCase: `index QA workflow ${suffix}`,
    })), env());

    expect(response.status).toBe(202);
    expect(sentEmails).toHaveLength(1);
  });

  it("accepts known dynamic endpoint templates from the public form", async () => {
    const response = await handleApiKeyRequest(db, postRequest("/api/api-key-requests", validBody({
      email: "template@example.com",
      intendedEndpoints: ["/api/stablecoin/:id"],
    })), env());

    expect(response.status).toBe(202);
    expect(sqlite.prepare("SELECT intended_endpoints_json FROM api_key_requests").get()).toEqual({
      intended_endpoints_json: JSON.stringify(["/api/stablecoin/:id"]),
    });
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
    const body = await response.json() as {
      requestId?: string;
      token: string;
      key: Record<string, unknown> & { tier: string; rateLimitPerMinute: number; expiresAt: number };
    };

    expect(response.status).toBe(201);
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
    db = createSqliteD1(sqlite, runSqlLog);
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
    const body = await response.json() as { token?: string };

    expect(response.status).toBe(503);
    expect(body.token).toBeUndefined();
    expect(sqlite.prepare("SELECT is_active FROM api_keys").get()).toEqual({ is_active: 0 });
    expect(sqlite.prepare("SELECT status, verification_token_hash, issuance_locked_at FROM api_key_requests").get()).toEqual({
      status: "blocked",
      verification_token_hash: null,
      issuance_locked_at: null,
    });
    expect(sqlite.prepare("SELECT status FROM api_key_self_serve_email_claims").get()).toEqual({ status: "released" });
    expect(errorSpy).toHaveBeenCalledWith(
      "[api-key-requests] issuance consistency write failed:",
      expect.any(Error),
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

  it("releases stale orphan pending claims before acquiring a new claim", async () => {
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

    const response = await handleApiKeyRequest(db, postRequest("/api/api-key-requests", validBody()), env());

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
    const body = await response.json() as { token?: string };

    expect(response.status).toBe(503);
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
    const body = await response.json() as { requests: Array<{ email: string; token?: string; useCase: string }> };

    expect(response.status).toBe(200);
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
});
