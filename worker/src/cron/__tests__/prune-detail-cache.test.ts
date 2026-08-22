import { describe, expect, it } from "vitest";
import { runPruneDetailCache } from "../prune-detail-cache";
import { READABLE_IDS } from "@shared/lib/stablecoins/registry";

interface FakeRow {
  key: string;
  updated_at: number;
}

function fakeDb(rows: FakeRow[], deleted: string[], selectBinds: unknown[][] = []): D1Database {
  return {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        all: async () => {
          if (sql.startsWith("SELECT")) {
            selectBinds.push(args);
            const prefix = String(args[0]).replace(/%$/, "");
            const lastKey = String(args[1]);
            const pageSize = Number(args[2]);
            return {
              results: rows
                .filter((row) => row.key.startsWith(prefix) && row.key > lastKey)
                .sort((a, b) => a.key.localeCompare(b.key))
                .slice(0, pageSize),
            };
          }
          return { results: rows };
        },
        run: async () => {
          if (sql.startsWith("DELETE")) deleted.push(args[0] as string);
          return { meta: { changes: 1 } };
        },
      }),
    }),
    batch: async (statements: Array<{ run?: unknown }>) => {
      // batchExecute passes prepared statements; our fake `bind` returns an
      // object whose `run` records the key, so emulate D1 batch by running.
      return Promise.all(
        (statements as Array<{ run: () => Promise<unknown> }>).map((statement) => statement.run()),
      );
    },
  } as unknown as D1Database;
}

describe("runPruneDetailCache", () => {
  it("deletes orphaned and week-stale rows, keeps fresh readable rows", async () => {
    const liveId = [...READABLE_IDS][0];
    const otherLiveId = [...READABLE_IDS][1];
    const nowSec = Math.floor(Date.now() / 1000);
    const deleted: string[] = [];
    const db = fakeDb(
      [
        { key: "detail:146", updated_at: nowSec - 3600 }, // legacy orphan, fresh but unreadable
        { key: "detail:retired-coin-id", updated_at: nowSec - 3600 },
        { key: `detail:${liveId}`, updated_at: nowSec - 8 * 24 * 3600 }, // readable but week-stale
        { key: `detail:${otherLiveId}`, updated_at: nowSec - 3600 }, // keep
      ],
      deleted,
    );

    const result = await runPruneDetailCache(db);
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      orphansDeleted: number;
      staleDeleted: number;
      scanned: number;
    };

    expect(result.status).toBe("ok");
    expect(result.itemCount).toBe(3);
    expect(metadata.scanned).toBe(4);
    expect(metadata.orphansDeleted).toBe(2);
    expect(metadata.staleDeleted).toBe(1);
    expect(deleted.sort()).toEqual(["detail:146", `detail:${liveId}`, "detail:retired-coin-id"].sort());
  });

  it("keyset-paginates through every detail-cache page", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const rows = Array.from({ length: 501 }, (_, index) => ({
      key: `detail:orphan-${String(index).padStart(3, "0")}`,
      updated_at: nowSec - 8 * 24 * 3600,
    }));
    const deleted: string[] = [];
    const selectBinds: unknown[][] = [];
    const db = fakeDb(rows, deleted, selectBinds);

    const result = await runPruneDetailCache(db);
    const metadata = JSON.parse(result.metadata ?? "{}") as { scanned: number };

    expect(result.itemCount).toBe(501);
    expect(metadata.scanned).toBe(501);
    expect(deleted).toHaveLength(501);
    expect(selectBinds).toEqual([
      ["detail:%", "", 500],
      ["detail:%", "detail:orphan-499", 500],
    ]);
  });
});
