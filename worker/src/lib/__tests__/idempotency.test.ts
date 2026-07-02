import { describe, expect, it, vi } from "vitest";
import { runIdempotentAdminAction } from "../idempotency";

interface TestIdempotencyRecord {
  request_hash: string;
  response_status: number;
  response_body: string;
  created_at: number;
}

function makeIdempotencyDb(
  options: {
    failExecutionCleanupDeleteOnce?: boolean;
    failFailureStateUpdateOnce?: boolean;
  } = {},
): D1Database & {
  getHistory(): Array<{ sql: string; binds: unknown[] }>;
  getRecord(action: string, key: string): TestIdempotencyRecord | undefined;
  setRecord(action: string, key: string, record: TestIdempotencyRecord): void;
} {
  const store = new Map<
    string,
    {
      request_hash: string;
      response_status: number;
      response_body: string;
      created_at: number;
    }
  >();
  const history: Array<{ sql: string; binds: unknown[] }> = [];
  let failExecutionCleanupDeleteOnce = options.failExecutionCleanupDeleteOnce ?? false;
  let failFailureStateUpdateOnce = options.failFailureStateUpdateOnce ?? false;

  const stmt = (sql: string) => ({
    bind: (...args: unknown[]) => ({
      first: async <T>() => {
        history.push({ sql, binds: [...args] });
        if (sql.includes("FROM admin_idempotency_keys")) {
          const key = `${args[0]}:${args[1]}`;
          return (store.get(key) ?? null) as T | null;
        }
        return null as T | null;
      },
      run: async () => {
        history.push({ sql, binds: [...args] });
        if (sql.includes("INSERT OR IGNORE INTO admin_idempotency_keys")) {
          const [action, idemKey, requestHash, status, body, createdAt] = args as [
            string,
            string,
            string,
            number,
            string,
            number,
          ];
          const key = `${action}:${idemKey}`;
          if (!store.has(key)) {
            store.set(key, {
              request_hash: requestHash,
              response_status: status,
              response_body: body,
              created_at: createdAt,
            });
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 0 } };
        }
        if (sql.includes("UPDATE admin_idempotency_keys SET request_hash")) {
          const [requestHash, status, body, createdAt, action, idemKey, expectedStatus, createdBefore] = args as [
            string,
            number,
            string,
            number,
            string,
            string,
            number,
            number,
          ];
          const key = `${action}:${idemKey}`;
          const existing = store.get(key);
          if (!existing || existing.response_status !== expectedStatus || existing.created_at >= createdBefore) {
            return { success: true, meta: { changes: 0 } };
          }
          store.set(key, {
            request_hash: requestHash,
            response_status: status,
            response_body: body,
            created_at: createdAt,
          });
          return { success: true, meta: { changes: 1 } };
        }
        if (sql.includes("UPDATE admin_idempotency_keys SET response_status")) {
          const [status, body, createdAt, action, idemKey, requestHash, expectedStatus] = args as [
            number,
            string,
            number,
            string,
            string,
            string,
            number | undefined,
          ];
          if (status === -2 && failFailureStateUpdateOnce) {
            failFailureStateUpdateOnce = false;
            throw new Error("failure-state update failed");
          }
          const key = `${action}:${idemKey}`;
          const existing = store.get(key);
          if (
            !existing ||
            existing.request_hash !== requestHash ||
            (typeof expectedStatus === "number" && existing.response_status !== expectedStatus)
          ) {
            return { success: true, meta: { changes: 0 } };
          }
          store.set(key, {
            request_hash: existing.request_hash,
            response_status: status,
            response_body: body,
            created_at: createdAt,
          });
          return { success: true, meta: { changes: 1 } };
        }
        if (sql.includes("DELETE FROM admin_idempotency_keys")) {
          if (
            sql.includes("request_hash = ?") &&
            sql.includes("response_status = ?") &&
            failExecutionCleanupDeleteOnce
          ) {
            failExecutionCleanupDeleteOnce = false;
            throw new Error("pending cleanup delete failed");
          }
          const [action, idemKey, requestHash, expectedStatus] = args as [
            string,
            string,
            string | undefined,
            number | undefined,
          ];
          const key = `${action}:${idemKey}`;
          const existing = store.get(key);
          if (!existing) {
            return { success: true, meta: { changes: 0 } };
          }
          if (typeof requestHash === "string" && existing.request_hash !== requestHash) {
            return { success: true, meta: { changes: 0 } };
          }
          if (typeof expectedStatus === "number" && existing.response_status !== expectedStatus) {
            return { success: true, meta: { changes: 0 } };
          }
          store.delete(key);
          return { success: true, meta: { changes: 1 } };
        }
        return { success: true, meta: { changes: 0 } };
      },
    }),
  });

  return {
    prepare: (sql: string) => stmt(sql),
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
    getHistory: () => history.map((entry) => ({ sql: entry.sql, binds: [...entry.binds] })),
    getRecord: (action: string, key: string) => store.get(`${action}:${key}`),
    setRecord: (action: string, key: string, record: TestIdempotencyRecord) => {
      store.set(`${action}:${key}`, { ...record });
    },
  } as unknown as D1Database & {
    getHistory(): Array<{ sql: string; binds: unknown[] }>;
    getRecord(action: string, key: string): TestIdempotencyRecord | undefined;
    setRecord(action: string, key: string, record: TestIdempotencyRecord): void;
  };
}

describe("runIdempotentAdminAction", () => {
  it("replays stored response for repeated key + request", async () => {
    const db = makeIdempotencyDb();
    const request = new Request("https://x/api/backfill-depegs?batch=1", {
      method: "POST",
      headers: { "Idempotency-Key": "abc-123" },
    });

    let calls = 0;
    const execute = async () => {
      calls++;
      return new Response(JSON.stringify({ ok: true, calls }), {
        headers: { "Content-Type": "application/json" },
      });
    };

    const first = await runIdempotentAdminAction(db, "backfill-depegs", request, execute);
    const second = await runIdempotentAdminAction(db, "backfill-depegs", request, execute);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(calls).toBe(1);
    expect(second.headers.get("X-Idempotent-Replay")).toBe("true");
    const body = (await second.json()) as { ok: boolean; calls: number };
    expect(body.calls).toBe(1);
  });

  it("returns 409 for in-flight key and does not execute again", async () => {
    const db = makeIdempotencyDb();
    const makeRequest = () =>
      new Request("https://x/api/backfill-depegs?batch=1", {
        method: "POST",
        headers: { "Idempotency-Key": "abc-inflight" },
        body: JSON.stringify({ batch: 1 }),
      });

    let calls = 0;
    let markFirstStarted: (() => void) | null = null;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    let resolveGate: ((value: Response) => void) | null = null;
    const gate = new Promise<Response>((resolve) => {
      resolveGate = resolve;
    });
    const execute = async () => {
      calls++;
      markFirstStarted?.();
      return gate;
    };

    const first = runIdempotentAdminAction(db, "backfill-depegs", makeRequest(), execute);
    await firstStarted; // ensure first call reserved the key and entered execute

    const second = await runIdempotentAdminAction(db, "backfill-depegs", makeRequest(), execute);
    expect(second.status).toBe(409);
    expect(calls).toBe(1);

    resolveGate!(
      new Response(JSON.stringify({ ok: true, calls }), {
        headers: { "Content-Type": "application/json" },
      }),
    );

    const firstResponse = await first;
    expect(firstResponse.status).toBe(200);
    expect(calls).toBe(1);
  });

  it("takes over an abandoned pending reservation older than the execution window", async () => {
    const now = 1_800_000_000;
    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(now * 1000);

    try {
      const db = makeIdempotencyDb();
      db.setRecord("backfill-depegs", "abc-abandoned", {
        request_hash: "stale-request-hash",
        response_status: -1,
        response_body: "",
        created_at: now - 20 * 60 - 1,
      });

      const request = new Request("https://x/api/backfill-depegs?batch=2", {
        method: "POST",
        headers: { "Idempotency-Key": "abc-abandoned" },
        body: JSON.stringify({ batch: 2 }),
      });

      let calls = 0;
      const execute = async () => {
        calls++;
        return new Response(JSON.stringify({ ok: true, calls }), {
          status: 202,
          headers: { "Content-Type": "application/json" },
        });
      };

      const response = await runIdempotentAdminAction(db, "backfill-depegs", request, execute);

      expect(response.status).toBe(202);
      expect(response.headers.get("X-Idempotent-Replay")).toBe("false");
      expect(calls).toBe(1);

      const record = db.getRecord("backfill-depegs", "abc-abandoned");
      expect(record?.request_hash).not.toBe("stale-request-hash");
      expect(record?.response_status).toBe(202);
      expect(record?.created_at).toBe(now);

      const takeover = db
        .getHistory()
        .find((entry) => entry.sql.includes("UPDATE admin_idempotency_keys SET request_hash"));
      expect(takeover?.binds[3]).toBe(now);
      expect(takeover?.binds[4]).toBe("backfill-depegs");
      expect(takeover?.binds[5]).toBe("abc-abandoned");
      expect(takeover?.binds[6]).toBe(-1);
      expect(takeover?.binds[7]).toBe(now - 20 * 60);
    } finally {
      dateSpy.mockRestore();
    }
  });

  it("treats equivalent query params with different ordering as the same request", async () => {
    const db = makeIdempotencyDb();
    const requestA = new Request("https://x/api/backfill-depegs?batch=1&dry-run=false", {
      method: "POST",
      headers: { "Idempotency-Key": "abc-order" },
      body: JSON.stringify({ batch: 1 }),
    });
    const requestB = new Request("https://x/api/backfill-depegs?dry-run=false&batch=1", {
      method: "POST",
      headers: { "Idempotency-Key": "abc-order" },
      body: JSON.stringify({ batch: 1 }),
    });

    let calls = 0;
    const execute = async () => {
      calls++;
      return new Response(JSON.stringify({ ok: true, calls }), {
        headers: { "Content-Type": "application/json" },
      });
    };

    const first = await runIdempotentAdminAction(db, "backfill-depegs", requestA, execute);
    const second = await runIdempotentAdminAction(db, "backfill-depegs", requestB, execute);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(calls).toBe(1);
    expect(second.headers.get("X-Idempotent-Replay")).toBe("true");
  });

  it("cleans up pending reservations after execute throws so the same key can retry", async () => {
    const db = makeIdempotencyDb();
    const request = new Request("https://x/api/backfill-depegs?batch=1", {
      method: "POST",
      headers: { "Idempotency-Key": "abc-failure-retry" },
    });

    let calls = 0;
    const execute = async () => {
      calls++;
      if (calls === 1) {
        throw new Error("boom");
      }
      return new Response(JSON.stringify({ ok: true, calls }), {
        headers: { "Content-Type": "application/json" },
      });
    };

    await expect(runIdempotentAdminAction(db, "backfill-depegs", request, execute)).rejects.toThrow("boom");
    expect(db.getRecord("backfill-depegs", "abc-failure-retry")).toBeUndefined();

    const retry = await runIdempotentAdminAction(db, "backfill-depegs", request, execute);

    expect(retry.status).toBe(200);
    expect(retry.headers.get("X-Idempotent-Replay")).toBe("false");
    expect(calls).toBe(2);
  });

  it("stores a deterministic terminal failure replay when cleanup cannot be confirmed", async () => {
    const db = makeIdempotencyDb({ failExecutionCleanupDeleteOnce: true });
    const request = new Request("https://x/api/backfill-depegs?batch=1", {
      method: "POST",
      headers: { "Idempotency-Key": "abc-failure-replay" },
    });

    const execute = async () => {
      throw new Error("boom");
    };

    const first = await runIdempotentAdminAction(db, "backfill-depegs", request, execute);

    expect(first.status).toBe(500);
    expect(first.headers.get("Idempotency-Key")).toBe("abc-failure-replay");
    expect(first.headers.get("X-Idempotent-Replay")).toBe("false");
    expect(db.getRecord("backfill-depegs", "abc-failure-replay")?.response_status).toBe(-2);

    const second = await runIdempotentAdminAction(db, "backfill-depegs", request, execute);

    expect(second.status).toBe(500);
    expect(second.headers.get("X-Idempotent-Replay")).toBe("true");
    expect(await second.json()).toEqual({
      error: "Previous idempotent attempt failed before cleanup could be confirmed. Retry with a new Idempotency-Key.",
    });
  });

  it("returns 409 when the same key is reused with a different payload", async () => {
    const db = makeIdempotencyDb();
    const requestA = new Request("https://x/api/backfill-depegs?batch=1", {
      method: "POST",
      headers: { "Idempotency-Key": "abc-conflict" },
      body: JSON.stringify({ batch: 1 }),
    });
    const requestB = new Request("https://x/api/backfill-depegs?batch=2", {
      method: "POST",
      headers: { "Idempotency-Key": "abc-conflict" },
      body: JSON.stringify({ batch: 2 }),
    });

    const execute = async () =>
      new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });

    const first = await runIdempotentAdminAction(db, "backfill-depegs", requestA, execute);
    const second = await runIdempotentAdminAction(db, "backfill-depegs", requestB, execute);

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({
      error: "Idempotency key reuse with different request payload",
    });
  });

  it("attempts final cleanup and logs clearly when the failure-state write also fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = makeIdempotencyDb({
      failExecutionCleanupDeleteOnce: true,
      failFailureStateUpdateOnce: true,
    });
    const request = new Request("https://x/api/backfill-depegs?batch=1", {
      method: "POST",
      headers: { "Idempotency-Key": "abc-final-cleanup" },
    });

    let calls = 0;
    const execute = async () => {
      calls++;
      if (calls === 1) {
        throw new Error("boom");
      }
      return new Response(JSON.stringify({ ok: true, calls }), {
        headers: { "Content-Type": "application/json" },
      });
    };

    await expect(runIdempotentAdminAction(db, "backfill-depegs", request, execute)).rejects.toThrow("boom");

    const history = db.getHistory();
    expect(
      history.some(
        (entry) => entry.sql.includes("UPDATE admin_idempotency_keys SET response_status") && entry.binds[0] === -2,
      ),
    ).toBe(true);
    expect(
      history.filter(
        (entry) => entry.sql.includes("DELETE FROM admin_idempotency_keys") && entry.sql.includes("request_hash = ?"),
      ).length,
    ).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(warnSpy.mock.calls[0]?.[0] as string)).toMatchObject({
      scope: "admin",
      level: "warn",
      event: "idempotency_execution_cleanup_failed",
      route: "backfill-depegs",
      source: "admin_idempotency_keys",
      errorMessage: "pending cleanup delete failed",
    });
    expect(JSON.parse(errorSpy.mock.calls[0]?.[0] as string)).toMatchObject({
      scope: "admin",
      level: "error",
      event: "idempotency_terminal_failure_replay_persist_failed",
      route: "backfill-depegs",
      source: "admin_idempotency_keys",
      errorMessage: "failure-state [sql]",
    });
    expect(db.getRecord("backfill-depegs", "abc-final-cleanup")).toBeUndefined();

    const retry = await runIdempotentAdminAction(db, "backfill-depegs", request, execute);
    expect(retry.status).toBe(200);
    expect(calls).toBe(2);
  });
});
