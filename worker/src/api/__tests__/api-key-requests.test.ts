import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  handleApiKeyRequest,
  handleApiKeyRequestReject,
  handleApiKeyRequestsAdmin,
  handleApiKeyRequestVerify,
} from "../api-key-requests";
import type { ApiKeySelfServeEnv } from "../api-key-requests/types";

interface SqliteD1Statement {
  bind(...values: unknown[]): SqliteD1Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}

function createSqliteD1(sqlite: DatabaseSync): D1Database {
  function makeStatement(sql: string, values: unknown[] = []): SqliteD1Statement {
    return {
      bind: (...nextValues: unknown[]) => makeStatement(sql, nextValues),
      first: async <T>() => (sqlite.prepare(sql).get(...(values as never[])) ?? null) as T | null,
      all: async <T>() => ({ results: sqlite.prepare(sql).all(...(values as never[])) as T[] }),
      run: async () => {
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
      last_used_route TEXT
    );

    CREATE TABLE api_key_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      api_key_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      detail_json TEXT,
      created_at INTEGER NOT NULL
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
      email_provider_message_id TEXT,
      issued_at INTEGER,
      rejected_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE api_key_request_rate_limit (
      scope TEXT NOT NULL CHECK (scope IN ('ip', 'email', 'token')),
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
  const match = text.match(/https:\/\/pharos\.watch\/api\/\?verify=([A-Za-z0-9_-]+)/);
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
    const body = await response.json() as { status: string; requestId: string };

    expect(response.status).toBe(202);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body.status).toBe("pending_verification");
    expect(body.requestId).toMatch(/^akr_/);
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
    const body = await response.json() as { token: string; key: { tier: string; rateLimitPerMinute: number; expiresAt: number } };

    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body.token).toMatch(/^ph_live_[0-9a-f]{16}_[A-Za-z0-9_-]{32}$/);
    expect(body.key.tier).toBe("self-serve");
    expect(body.key.rateLimitPerMinute).toBe(30);
    expect(body.key.expiresAt).toBe(2_000_000_000 + (60 * 24 * 60 * 60));

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

  it("prevents duplicate pending or active keys for the same normalized email", async () => {
    const first = await handleApiKeyRequest(db, postRequest("/api/api-key-requests", validBody()), env());
    expect(first.status).toBe(202);

    const second = await handleApiKeyRequest(db, postRequest("/api/api-key-requests", validBody({
      email: "builder@example.com",
    })), env());

    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toEqual({
      error: "An active or pending self-serve key already exists for this email.",
    });
  });

  it("returns honeypot success without creating a request", async () => {
    const response = await handleApiKeyRequest(db, postRequest("/api/api-key-requests", validBody({
      website: "https://bot.example",
    })), env());

    expect(response.status).toBe(200);
    expect(sentEmails).toHaveLength(0);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM api_key_requests").get()).toEqual({ count: 0 });
  });

  it("fails closed when required email provider config is missing", async () => {
    const response = await handleApiKeyRequest(db, postRequest("/api/api-key-requests", validBody()), env({
      RESEND_API_KEY: undefined,
    }));

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM api_key_requests").get()).toEqual({ count: 0 });
  });

  it("does not return a token and deactivates the created key on post-insert consistency failure", async () => {
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
    expect(sqlite.prepare("SELECT is_active FROM api_keys").get()).toEqual({ is_active: 0 });
    expect(sqlite.prepare("SELECT status FROM api_key_requests").get()).toEqual({ status: "blocked" });
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
    const { requestId } = await pending.json() as { requestId: string };

    const response = await handleApiKeyRequestReject(
      db,
      requestId,
      true,
      postRequest(`/api/api-key-requests-admin/${requestId}/reject`, {}, { "X-Pharos-Admin": "1" }),
    );

    expect(response.status).toBe(200);
    expect(sqlite.prepare("SELECT status FROM api_key_requests").get()).toEqual({ status: "rejected" });
    expect(sqlite.prepare("SELECT status FROM api_key_self_serve_email_claims").get()).toEqual({ status: "released" });
  });
});
