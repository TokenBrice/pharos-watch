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
          }
          return { success: true, meta: { changes: 1 } };
        }
        if (sql.includes("DELETE FROM admin_idempotency_keys")) {
          return { success: true, meta: { changes: 0 } };
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
});
