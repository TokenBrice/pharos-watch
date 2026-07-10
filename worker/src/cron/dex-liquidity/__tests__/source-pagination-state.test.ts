import { describe, expect, it, vi } from "vitest";
import {
  readDexSourcePaginationState,
  writeDexSourcePaginationState,
} from "../source-pagination-state";

describe("DEX source pagination state", () => {
  it("round-trips opaque cursors and bounds persisted diagnostics", async () => {
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const first = vi.fn(async () => ({
      cursor: "opaque-tail",
      cycle_started_at: 90,
      updated_at: 100,
      completed_at: null,
      pages_fetched: 4,
    }));
    const bind = vi.fn((..._values: unknown[]) => ({ first, run }));
    const db = { prepare: vi.fn(() => ({ bind })) } as unknown as D1Database;

    await expect(readDexSourcePaginationState(db, "orca:solana")).resolves.toEqual({
      cursor: "opaque-tail",
      cycleStartedAt: 90,
      updatedAt: 100,
      completedAt: null,
      pagesFetched: 4,
    });

    await writeDexSourcePaginationState({
      db,
      sourceKey: "orca:solana",
      cursor: "next-tail",
      cycleStartedAt: 90,
      nowSec: 110,
      completed: false,
      pagesFetched: 4,
      diagnostics: Array.from({ length: 20 }, (_, index) => `failure-${index}`),
    });

    const writeBinds = bind.mock.calls[bind.mock.calls.length - 1] ?? [];
    expect(writeBinds[0]).toBe("orca:solana");
    expect(JSON.parse(String(writeBinds[6]))).toHaveLength(12);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
