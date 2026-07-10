import { describe, expect, it, vi } from "vitest";
import { runIdempotentAdminAction } from "../idempotency";

interface TestIdempotencyRecord {
  request_hash: string;
  response_status: number;
  response_body: string;
  created_at: number;
  reservation_owner: string | null;
  reservation_generation: number;
  execution_started_at: number | null;
}

interface TestDbOptions {
  failBeginOnce?: boolean;
  failTerminalUpdates?: boolean;
  ambiguousTerminalCommitOnce?: boolean;
  beforeTerminalUpdate?: (record: TestIdempotencyRecord) => void;
}

function makeIdempotencyDb(options: TestDbOptions = {}): D1Database & {
  getHistory(): Array<{ sql: string; binds: unknown[] }>;
  getRecord(action: string, key: string): TestIdempotencyRecord | undefined;
} {
  const store = new Map<string, TestIdempotencyRecord>();
  const history: Array<{ sql: string; binds: unknown[] }> = [];
  let failBeginOnce = options.failBeginOnce ?? false;
  let ambiguousTerminalCommitOnce = options.ambiguousTerminalCommitOnce ?? false;

  const stmt = (sql: string) => ({
    bind: (...args: unknown[]) => ({
      first: async <T>() => {
        history.push({ sql, binds: [...args] });
        if (sql.includes("FROM admin_idempotency_keys")) {
          return (store.get(`${args[0]}:${args[1]}`) ?? null) as T | null;
        }
        return null as T | null;
      },
      run: async () => {
        history.push({ sql, binds: [...args] });
        if (sql.includes("INSERT OR IGNORE INTO admin_idempotency_keys")) {
          const [action, idempotencyKey, requestHash, responseStatus, responseBody, createdAt, owner] = args as [
            string,
            string,
            string,
            number,
            string,
            number,
            string,
          ];
          const mapKey = `${action}:${idempotencyKey}`;
          if (store.has(mapKey)) return { success: true, meta: { changes: 0 } };
          store.set(mapKey, {
            request_hash: requestHash,
            response_status: responseStatus,
            response_body: responseBody,
            created_at: createdAt,
            reservation_owner: owner,
            reservation_generation: 1,
            execution_started_at: null,
          });
          return { success: true, meta: { changes: 1 } };
        }

        if (sql.includes("reservation_generation = reservation_generation + 1")) {
          const [owner, createdAt, action, idempotencyKey, requestHash, expectedStatus, expectedGeneration, cutoff] =
            args as [string, number, string, string, string, number, number, number];
          const mapKey = `${action}:${idempotencyKey}`;
          const record = store.get(mapKey);
          if (
            !record ||
            record.request_hash !== requestHash ||
            record.response_status !== expectedStatus ||
            record.execution_started_at != null ||
            record.reservation_generation !== expectedGeneration ||
            record.created_at >= cutoff
          ) {
            return { success: true, meta: { changes: 0 } };
          }
          Object.assign(record, {
            reservation_owner: owner,
            reservation_generation: expectedGeneration + 1,
            response_body: "",
            created_at: createdAt,
          });
          return { success: true, meta: { changes: 1 } };
        }

        if (sql.includes("SET execution_started_at = ?")) {
          if (failBeginOnce) {
            failBeginOnce = false;
            return { success: true, meta: { changes: 0 } };
          }
          const [startedAt, action, idempotencyKey, requestHash, expectedStatus, owner, generation] = args as [
            number,
            string,
            string,
            string,
            number,
            string,
            number,
          ];
          const record = store.get(`${action}:${idempotencyKey}`);
          if (
            !record ||
            record.request_hash !== requestHash ||
            record.response_status !== expectedStatus ||
            record.execution_started_at != null ||
            record.reservation_owner !== owner ||
            record.reservation_generation !== generation
          ) {
            return { success: true, meta: { changes: 0 } };
          }
          record.execution_started_at = startedAt;
          return { success: true, meta: { changes: 1 } };
        }

        if (sql.includes("SET response_status = ?")) {
          const [status, body, createdAt, action, idempotencyKey, requestHash, expectedStatus, owner, generation] =
            args as [number, string, number, string, string, string, number, string, number];
          const record = store.get(`${action}:${idempotencyKey}`);
          if (record) options.beforeTerminalUpdate?.(record);
          if (options.failTerminalUpdates) throw new Error("terminal persistence unavailable");
          if (
            !record ||
            record.request_hash !== requestHash ||
            record.response_status !== expectedStatus ||
            record.execution_started_at == null ||
            record.reservation_owner !== owner ||
            record.reservation_generation !== generation
          ) {
            return { success: true, meta: { changes: 0 } };
          }
          Object.assign(record, {
            response_status: status,
            response_body: body,
            created_at: createdAt,
          });
          if (ambiguousTerminalCommitOnce) {
            ambiguousTerminalCommitOnce = false;
            throw new Error("D1 DB storage operation exceeded timeout");
          }
          return { success: true, meta: { changes: 1 } };
        }

        if (sql.includes("DELETE FROM admin_idempotency_keys")) {
          const [cutoff, pendingStatus] = args as [number, number];
          let changes = 0;
          for (const [key, record] of store) {
            if (record.created_at < cutoff && record.response_status !== pendingStatus) {
              store.delete(key);
              changes++;
            }
          }
          return { success: true, meta: { changes } };
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
  } as unknown as D1Database & {
    getHistory(): Array<{ sql: string; binds: unknown[] }>;
    getRecord(action: string, key: string): TestIdempotencyRecord | undefined;
  };
}

function request(key: string, query = "batch=1"): Request {
  return new Request(`https://x/api/backfill-depegs?${query}`, {
    method: "POST",
    headers: { "Idempotency-Key": key },
    body: JSON.stringify({ batch: 1 }),
  });
}

describe("runIdempotentAdminAction", () => {
  it("replays a stored terminal response", async () => {
    const db = makeIdempotencyDb();
    let calls = 0;
    const execute = async () => Response.json({ ok: true, calls: ++calls });

    const first = await runIdempotentAdminAction(db, "backfill-depegs", request("replay"), execute);
    const second = await runIdempotentAdminAction(db, "backfill-depegs", request("replay"), execute);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers.get("X-Idempotent-Replay")).toBe("true");
    expect(calls).toBe(1);
  });

  it("keeps one-time secrets out of stored and replayed sensitive responses", async () => {
    const db = makeIdempotencyDb();
    const plaintextToken = "ph_live_secret_that_must_not_be_persisted";
    let calls = 0;
    const execute = async () => {
      calls++;
      return Response.json({ key: { id: 7, name: "Ops Key" }, token: plaintextToken }, { status: 201 });
    };
    const options = {
      sensitiveReplayBody: (body: string) => {
        const parsed = JSON.parse(body) as { key: unknown };
        return JSON.stringify({
          key: parsed.key,
          tokenUnavailableOnReplay: true,
          recovery: "Rotate the identified API key.",
        });
      },
    };

    const first = await runIdempotentAdminAction(db, "api-key-create", request("sensitive"), execute, options);
    const replay = await runIdempotentAdminAction(db, "api-key-create", request("sensitive"), execute, options);
    const storedBody = db.getRecord("api-key-create", "sensitive")?.response_body ?? "";

    expect(await first.json()).toMatchObject({ token: plaintextToken });
    expect(storedBody).not.toContain(plaintextToken);
    expect(JSON.parse(storedBody)).toMatchObject({ tokenUnavailableOnReplay: true, key: { id: 7 } });
    await expect(replay.json()).resolves.toMatchObject({
      tokenUnavailableOnReplay: true,
      key: { id: 7, name: "Ops Key" },
    });
    expect(calls).toBe(1);
  });

  it("fails closed when sensitive replay redaction throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = makeIdempotencyDb();
    const plaintextToken = "ph_live_secret_that_must_never_escape_redaction_failure";
    let calls = 0;
    const execute = async () => {
      calls++;
      return Response.json({ key: { id: 9 }, token: plaintextToken }, { status: 201 });
    };
    const options = {
      sensitiveReplayBody: () => {
        throw new Error("redactor failed");
      },
    };

    const first = await runIdempotentAdminAction(db, "api-key-rotate", request("redactor-failure"), execute, options);
    const replay = await runIdempotentAdminAction(db, "api-key-rotate", request("redactor-failure"), execute, options);
    const stored = db.getRecord("api-key-rotate", "redactor-failure");

    expect(first.status).toBe(503);
    expect(await first.json()).toMatchObject({ error: "execution_unknown" });
    expect(stored?.response_status).toBe(-2);
    expect(stored?.response_body).not.toContain(plaintextToken);
    expect(replay.status).toBe(503);
    expect(replay.headers.get("X-Idempotent-Replay")).toBe("true");
    expect(await replay.text()).not.toContain(plaintextToken);
    expect(calls).toBe(1);
    errorSpy.mockRestore();
  });

  it("does not replay while an execution is in flight", async () => {
    const db = makeIdempotencyDb();
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    let finish!: (response: Response) => void;
    const gate = new Promise<Response>((resolve) => { finish = resolve; });
    let calls = 0;
    const execute = async () => {
      calls++;
      started();
      return gate;
    };

    const firstPromise = runIdempotentAdminAction(db, "backfill-depegs", request("in-flight"), execute);
    await startedPromise;
    const duplicate = await runIdempotentAdminAction(db, "backfill-depegs", request("in-flight"), execute);

    expect(duplicate.status).toBe(503);
    expect(await duplicate.json()).toMatchObject({ error: "execution_unknown" });
    expect(calls).toBe(1);
    finish(Response.json({ ok: true }));
    await expect(firstPromise).resolves.toHaveProperty("status", 200);
  });

  it("recovers an abandoned reservation only before execution starts", async () => {
    const now = 1_800_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const db = makeIdempotencyDb({ failBeginOnce: true });
    const first = await runIdempotentAdminAction(
      db,
      "backfill-depegs",
      request("unstarted"),
      async () => Response.json({ impossible: true }),
    );
    expect(first.status).toBe(409);
    const pending = db.getRecord("backfill-depegs", "unstarted")!;
    pending.created_at = now - 20 * 60 - 1;

    let calls = 0;
    const recovered = await runIdempotentAdminAction(
      db,
      "backfill-depegs",
      request("unstarted"),
      async () => Response.json({ calls: ++calls }, { status: 202 }),
    );

    expect(recovered.status).toBe(202);
    expect(calls).toBe(1);
    expect(pending.reservation_generation).toBe(2);
    expect(pending.response_status).toBe(202);
    vi.restoreAllMocks();
  });

  it("compatibly takes over a stranded legacy generation-zero reservation", async () => {
    const now = 1_800_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const db = makeIdempotencyDb({ failBeginOnce: true });
    await runIdempotentAdminAction(
      db,
      "reset-blacklist-sync",
      request("legacy-generation-zero"),
      async () => Response.json({ impossible: true }),
    );
    const pending = db.getRecord("reset-blacklist-sync", "legacy-generation-zero")!;
    pending.reservation_generation = 0;
    pending.reservation_owner = null;
    pending.created_at = now - 20 * 60 - 1;

    let calls = 0;
    const recovered = await runIdempotentAdminAction(
      db,
      "reset-blacklist-sync",
      request("legacy-generation-zero"),
      async () => Response.json({ calls: ++calls }, { status: 202 }),
    );

    expect(recovered.status).toBe(202);
    expect(calls).toBe(1);
    expect(pending.reservation_generation).toBe(1);
    expect(pending.response_status).toBe(202);
    vi.restoreAllMocks();
  });

  it("suppresses retry after a crash immediately after execution-start was persisted", async () => {
    const db = makeIdempotencyDb();
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const first = runIdempotentAdminAction(db, "backfill-depegs", request("crash-before-effect"), async () => {
      started();
      return new Promise<Response>(() => {});
    });
    void first;
    await startedPromise;

    let calls = 0;
    const retry = await runIdempotentAdminAction(
      db,
      "backfill-depegs",
      request("crash-before-effect"),
      async () => Response.json({ calls: ++calls }),
    );

    expect(retry.status).toBe(503);
    expect(calls).toBe(0);
  });

  it("stores and replays execution_unknown when execution throws", async () => {
    const db = makeIdempotencyDb();
    let calls = 0;
    const execute = async (): Promise<Response> => {
      calls++;
      throw new Error("effect may have happened");
    };

    const first = await runIdempotentAdminAction(db, "backfill-depegs", request("throws"), execute);
    const second = await runIdempotentAdminAction(db, "backfill-depegs", request("throws"), execute);

    expect(first.status).toBe(503);
    expect(second.status).toBe(503);
    expect(second.headers.get("X-Idempotent-Replay")).toBe("true");
    expect(db.getRecord("backfill-depegs", "throws")?.response_status).toBe(-2);
    expect(calls).toBe(1);
  });

  it("does not replay a successful side effect when terminal persistence fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = makeIdempotencyDb({ failTerminalUpdates: true });
    let effects = 0;
    const execute = async () => Response.json({ effects: ++effects });

    const first = await runIdempotentAdminAction(db, "backfill-depegs", request("persist-fail"), execute);
    const retry = await runIdempotentAdminAction(db, "backfill-depegs", request("persist-fail"), execute);

    expect(first.status).toBe(503);
    expect(retry.status).toBe(503);
    expect(effects).toBe(1);
    expect(db.getRecord("backfill-depegs", "persist-fail")).toMatchObject({
      response_status: -1,
      execution_started_at: expect.any(Number),
    });
    errorSpy.mockRestore();
  });

  it("confirms an ambiguous terminal commit without replaying execution", async () => {
    const db = makeIdempotencyDb({ ambiguousTerminalCommitOnce: true });
    let effects = 0;
    const response = await runIdempotentAdminAction(
      db,
      "backfill-depegs",
      request("ambiguous-commit"),
      async () => Response.json({ effects: ++effects }),
    );

    expect(response.status).toBe(200);
    expect(effects).toBe(1);
    expect(db.getRecord("backfill-depegs", "ambiguous-commit")?.response_status).toBe(200);
  });

  it("fences a late original terminal write after ownership changes", async () => {
    const db = makeIdempotencyDb({
      beforeTerminalUpdate: (record) => {
        record.reservation_owner = "new-owner";
        record.reservation_generation += 1;
      },
    });
    const response = await runIdempotentAdminAction(
      db,
      "backfill-depegs",
      request("late-owner"),
      async () => Response.json({ ok: true }),
    );

    expect(response.status).toBe(503);
    expect(db.getRecord("backfill-depegs", "late-owner")).toMatchObject({
      response_status: -1,
      reservation_owner: "new-owner",
      reservation_generation: 2,
    });
  });

  it("rejects key reuse with a different request fingerprint", async () => {
    const db = makeIdempotencyDb();
    const first = await runIdempotentAdminAction(
      db,
      "backfill-depegs",
      request("conflict", "batch=1"),
      async () => Response.json({ ok: true }),
    );
    const second = await runIdempotentAdminAction(
      db,
      "backfill-depegs",
      request("conflict", "batch=2"),
      async () => Response.json({ impossible: true }),
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
  });

  it("canonicalizes query ordering in the request fingerprint", async () => {
    const db = makeIdempotencyDb();
    let calls = 0;
    const execute = async () => Response.json({ calls: ++calls });
    await runIdempotentAdminAction(db, "backfill-depegs", request("ordered", "batch=1&dryRun=false"), execute);
    const replay = await runIdempotentAdminAction(
      db,
      "backfill-depegs",
      request("ordered", "dryRun=false&batch=1"),
      execute,
    );

    expect(replay.status).toBe(200);
    expect(replay.headers.get("X-Idempotent-Replay")).toBe("true");
    expect(calls).toBe(1);
  });
});
