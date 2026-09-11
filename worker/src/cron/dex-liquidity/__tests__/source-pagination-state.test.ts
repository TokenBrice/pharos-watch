import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/structured-log", () => ({
  logWorkerEvent: vi.fn(),
}));

import {
  readDexSourcePaginationState,
  writeDexSourcePaginationState,
} from "../source-pagination-state";
import { makeNoopD1 } from "../../../test-helpers/noop-d1";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

describe("DEX source pagination state", () => {
  it("round-trips opaque cursors and bounds persisted diagnostics", async () => {
    const { db, sqlite } = fixtures.open();
    const sourceKey = "orca:solana";
    await writeDexSourcePaginationState({
      db, sourceKey, cursor: "opaque-tail", cycleStartedAt: 90, nowSec: 100,
      completed: false, pagesFetched: 4,
    });
    await expect(readDexSourcePaginationState(db, sourceKey)).resolves.toEqual({
      cursor: "opaque-tail", cycleStartedAt: 90, updatedAt: 100, completedAt: null, pagesFetched: 4,
    });
    await expect(writeDexSourcePaginationState({
      db, sourceKey, cursor: "next-tail", cycleStartedAt: 95, nowSec: 110,
      completed: true, pagesFetched: 7,
      diagnostics: ["x".repeat(250), ...Array.from({ length: 19 }, (_, index) => `failure-${index}`)],
    })).resolves.toEqual({ written: true, errorClass: null });
    await expect(readDexSourcePaginationState(db, sourceKey)).resolves.toEqual({
      cursor: "next-tail", cycleStartedAt: 95, updatedAt: 110, completedAt: 110, pagesFetched: 7,
    });
    const rows = sqlite.prepare("SELECT source_key, diagnostics_json FROM dex_source_pagination_state").all();
    expect(rows).toEqual([{
      source_key: sourceKey,
      diagnostics_json: JSON.stringify(["x".repeat(240), ...Array.from({ length: 11 }, (_, index) => `failure-${index}`)]),
    }]);
  });

  it("returns a bounded write failure and lets the same cursor retry", async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error("D1 write unavailable: raw provider detail"))
      .mockResolvedValueOnce({ success: true, meta: { changes: 1 } });
    const bind = vi.fn((..._values: unknown[]) => ({ run }));
    const db = makeNoopD1({ prepare: vi.fn(() => ({ bind })) });
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

  it("reports a missing mandatory table as a degrading write failure", async () => {
    const run = vi.fn(async () => {
      throw new Error("D1_ERROR: no such table: dex_source_pagination_state");
    });
    const db = makeNoopD1({
      prepare: vi.fn(() => ({ bind: vi.fn(() => ({ run })) })),
    });

    await expect(writeDexSourcePaginationState({
      db,
      sourceKey: "pancakeswap-v3:bsc",
      cursor: "500",
      cycleStartedAt: 90,
      nowSec: 110,
      completed: false,
      pagesFetched: 3,
    })).resolves.toEqual({ written: false, errorClass: "write-failed" });
  });

  it("surfaces a missing mandatory table on reads", async () => {
    const first = vi.fn(async () => {
      throw new Error("D1_ERROR: no such table: dex_source_pagination_state");
    });
    const db = makeNoopD1({
      prepare: vi.fn(() => ({ bind: vi.fn(() => ({ first })) })),
    });

    await expect(
      readDexSourcePaginationState(db, "orca:solana"),
    ).rejects.toThrow("no such table: dex_source_pagination_state");
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
