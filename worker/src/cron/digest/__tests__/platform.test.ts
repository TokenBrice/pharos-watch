import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { insertDigestRecord, markDigestMetaBlocked } from "../platform";
import { createLatestSchemaSqlite } from "../../../test-helpers/latest-schema-sqlite";

describe("insertDigestRecord", () => {
  function makeOptions(db: D1Database, signal?: AbortSignal) {
    return {
      db,
      generatedAt: 1_710_000_000,
      digestText: "Digest body",
      digestTitle: "Digest title",
      inputData: { ok: true },
      digestExtended: "Extended body",
      digestMeta: JSON.stringify({ type: "daily" }),
      signal,
    };
  }

  function setupDigestSqlite(): DatabaseSync {
    const sqlite = createLatestSchemaSqlite().sqlite;
    return sqlite;
  }

  function sqliteD1(
    sqlite: DatabaseSync,
    throwAfterRun?: (runCount: number) => Error | null,
  ): D1Database & { getRunCount: () => number; getHistory: () => Array<{ sql: string; binds: unknown[] }> } {
    let runCount = 0;
    const history: Array<{ sql: string; binds: unknown[] }> = [];

    return {
      prepare: (sql: string) => ({
        bind: (...binds: unknown[]) => ({
          run: async () => {
            runCount++;
            history.push({ sql, binds: [...binds] });
            const result = sqlite.prepare(sql).run(...(binds as never[]));
            const error = throwAfterRun?.(runCount);
            if (error) throw error;
            return { success: true, meta: { changes: Number(result.changes) } };
          },
        }),
      }),
      getRunCount: () => runCount,
      getHistory: () => history.map((entry) => ({ sql: entry.sql, binds: [...entry.binds] })),
    } as D1Database & {
      getRunCount: () => number;
      getHistory: () => Array<{ sql: string; binds: unknown[] }>;
    };
  }

  it("retries transient D1 overloads", async () => {
    let attempts = 0;
    const db = {
      prepare: () => ({
        bind: () => ({
          run: async () => {
            attempts++;
            if (attempts === 1) throw new Error("D1 DB is overloaded");
            return { success: true, meta: { changes: 1 } };
          },
        }),
      }),
    } as unknown as D1Database;

    await insertDigestRecord(makeOptions(db));

    expect(attempts).toBe(2);
  });

  it("does not duplicate the digest row when a retried D1 write already committed", async () => {
    const sqlite = setupDigestSqlite();
    const db = sqliteD1(sqlite, (runCount) =>
      runCount === 1 ? new Error("D1 DB storage operation exceeded timeout") : null,
    );

    try {
      await insertDigestRecord(makeOptions(db));

      const rows = sqlite
        .prepare("SELECT generated_at, digest_text, digest_title, input_data, digest_extended, digest_meta FROM daily_digest")
        .all();
      const history = db.getHistory();

      expect(db.getRunCount()).toBe(2);
      expect(rows).toHaveLength(1);
      expect(history[0]?.sql).toContain("WHERE NOT EXISTS");
      expect(history[0]?.binds.slice(0, 6)).toEqual(history[0]?.binds.slice(6));
    } finally {
      sqlite.close();
    }
  });

  it("honors an already-aborted signal before preparing the insert", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop-digest"));
    const prepare = vi.fn();
    const db = {
      prepare,
    } as unknown as D1Database;

    await expect(insertDigestRecord(makeOptions(db, controller.signal))).rejects.toThrow("stop-digest");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("honors an abort that fires while the D1 insert is in flight", async () => {
    const controller = new AbortController();
    const prepare = vi.fn(() => ({
      bind: () => ({
        run: async () => {
          controller.abort(new Error("stop-after-insert"));
          return { success: true, meta: { changes: 1 } };
        },
      }),
    }));
    const db = {
      prepare,
    } as unknown as D1Database;

    await expect(insertDigestRecord(makeOptions(db, controller.signal))).rejects.toThrow("stop-after-insert");
    expect(prepare).toHaveBeenCalledTimes(1);
  });
});

describe("markDigestMetaBlocked", () => {
  it("preserves existing meta fields and adds the blocked flag", () => {
    const marked = JSON.parse(
      markDigestMetaBlocked(JSON.stringify({ type: "weekly", leadSignalId: "depeg:x:active" })),
    ) as Record<string, unknown>;
    expect(marked.qualityGate).toBe("blocked");
    expect(marked.type).toBe("weekly");
    expect(marked.leadSignalId).toBe("depeg:x:active");
  });

  it("wraps null and unparseable meta in a valid blocked payload", () => {
    expect(JSON.parse(markDigestMetaBlocked(null))).toEqual({ qualityGate: "blocked" });
    expect(JSON.parse(markDigestMetaBlocked("not-json{"))).toEqual({ qualityGate: "blocked" });
  });
});
