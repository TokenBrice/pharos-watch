import { describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/structured-log", () => ({
  logWorkerEvent: vi.fn(),
}));

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

    await expect(writeDexSourcePaginationState({
      db,
      sourceKey: "orca:solana",
      cursor: "next-tail",
      cycleStartedAt: 90,
      nowSec: 110,
      completed: false,
      pagesFetched: 4,
      diagnostics: Array.from({ length: 20 }, (_, index) => `failure-${index}`),
    })).resolves.toEqual({ written: true, errorClass: null });

    const writeBinds = bind.mock.calls[bind.mock.calls.length - 1] ?? [];
    expect(writeBinds[0]).toBe("orca:solana");
    expect(JSON.parse(String(writeBinds[6]))).toHaveLength(12);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("returns a bounded write failure and lets the same cursor retry", async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error("D1 write unavailable: raw provider detail"))
      .mockResolvedValueOnce({ success: true, meta: { changes: 1 } });
    const bind = vi.fn((..._values: unknown[]) => ({ run }));
    const db = { prepare: vi.fn(() => ({ bind })) } as unknown as D1Database;
    const write = () => writeDexSourcePaginationState({
      db,
      sourceKey: "orca:solana",
      cursor: "retryable-tail",
      cycleStartedAt: 90,
      nowSec: 110,
      completed: false,
      pagesFetched: 4,
    });

    await expect(write()).resolves.toEqual({ written: false, errorClass: "write-failed" });
    await expect(write()).resolves.toEqual({ written: true, errorClass: null });

    expect(run).toHaveBeenCalledTimes(2);
    expect(bind.mock.calls[0]?.[1]).toBe("retryable-tail");
    expect(bind.mock.calls[1]?.[1]).toBe("retryable-tail");
  });

  it("reports missing-table rollout compatibility explicitly", async () => {
    const run = vi.fn(async () => {
      throw new Error("D1_ERROR: no such table: dex_source_pagination_state");
    });
    const db = {
      prepare: vi.fn(() => ({ bind: vi.fn(() => ({ run })) })),
    } as unknown as D1Database;

    await expect(writeDexSourcePaginationState({
      db,
      sourceKey: "pancakeswap-v3:bsc",
      cursor: "500",
      cycleStartedAt: 90,
      nowSec: 110,
      completed: false,
      pagesFetched: 3,
    })).resolves.toEqual({ written: false, errorClass: "missing-table" });
  });

  it("marks optional no-database usage without throwing", async () => {
    await expect(writeDexSourcePaginationState({
      sourceKey: "orca:solana",
      cursor: "tail",
      cycleStartedAt: 90,
      nowSec: 110,
      completed: false,
      pagesFetched: 4,
    })).resolves.toEqual({ written: false, errorClass: "not-configured" });
  });
});
