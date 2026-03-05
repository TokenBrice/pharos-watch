import { describe, expect, it } from "vitest";
import { runIdempotentAdminAction } from "../idempotency";

function makeIdempotencyDb(): D1Database {
  const store = new Map<string, {
    request_hash: string;
    response_status: number;
    response_body: string;
    created_at: number;
  }>();

  const stmt = (sql: string) => ({
    bind: (...args: unknown[]) => ({
      first: async <T>() => {
        if (sql.includes("FROM admin_idempotency_keys")) {
          const key = `${args[0]}:${args[1]}`;
          return (store.get(key) ?? null) as T | null;
        }
        return null as T | null;
      },
      run: async () => {
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
        if (sql.includes("UPDATE admin_idempotency_keys SET response_status")) {
          const [status, body, createdAt, action, idemKey, requestHash] = args as [
            number,
            string,
            number,
            string,
            string,
            string,
          ];
          const key = `${action}:${idemKey}`;
          const existing = store.get(key);
          if (!existing || existing.request_hash !== requestHash) {
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
          const [action, idemKey] = args as [string, string];
          const key = `${action}:${idemKey}`;
          const had = store.delete(key);
          return { success: true, meta: { changes: had ? 1 : 0 } };
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
  } as unknown as D1Database;
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
    const makeRequest = () => new Request("https://x/api/backfill-depegs?batch=1", {
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
});
