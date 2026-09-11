import { afterEach, describe, expect, it, vi } from "vitest";
import { insertBlacklistRows } from "../persistence";
import { makePendingBlacklistRow } from "./blacklist.test-support";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { makeNoopD1 } from "../../../test-helpers/noop-d1";

const fixtures = createLatestSchemaFixtureTracker();

afterEach(() => {
  fixtures.closeAll();
  vi.useRealTimers();
});


describe("insertBlacklistRows", () => {
  // 2026-08-29 dropped the legacy `amount` column from the statement but left its
  // placeholder behind; production rejected every new event for four days with
  // `D1_ERROR: 26 values for 25 columns`. Run the real statement against the
  // migrated schema so bind/column arity drift fails here, not in the cron.
  it("persists rows through the migrated schema and ignores duplicates", async () => {
    const { db, sqlite } = fixtures.open();
    const rows = [
      makePendingBlacklistRow({ id: "usdt:ethereum:0xa:0", amount_native: 1_000, amount_usd_at_event: 975 }),
      makePendingBlacklistRow({ id: "usdt:ethereum:0xb:0" }),
    ];

    await expect(insertBlacklistRows(db, rows)).resolves.toBe(2);
    await expect(insertBlacklistRows(db, [rows[1]!, makePendingBlacklistRow({ id: "usdt:ethereum:0xc:0" })])).resolves.toBe(1);

    expect(
      sqlite.prepare("SELECT id, amount_native, amount_usd_at_event, amount_status FROM blacklist_events ORDER BY id").all(),
    ).toEqual([
      { id: "usdt:ethereum:0xa:0", amount_native: 1_000, amount_usd_at_event: 975, amount_status: "recoverable_pending" },
      { id: "usdt:ethereum:0xb:0", amount_native: null, amount_usd_at_event: null, amount_status: "recoverable_pending" },
      { id: "usdt:ethereum:0xc:0", amount_native: null, amount_usd_at_event: null, amount_status: "recoverable_pending" },
    ]);
  });


  it("retries transient D1 overloads through batchExecute", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const db = makeNoopD1({
      prepare: () => ({
        bind: () => ({}),
      }),
      batch: async () => {
        attempts++;
        if (attempts === 1) throw new Error("D1 DB is overloaded");
        return [{ success: true, meta: { changes: 1 } }];
      },
    });

    const pending = insertBlacklistRows(db, [makePendingBlacklistRow()]);
    await vi.runAllTimersAsync();
    const inserted = await pending;

    expect(inserted).toBe(1);
    expect(attempts).toBe(2);
  });

  it("honors an already-aborted signal before preparing rows", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop-blacklist"));
    const prepare = vi.fn();
    const db = makeNoopD1({
      prepare,
      batch: async () => [],
    });

    await expect(insertBlacklistRows(db, [makePendingBlacklistRow()], controller.signal)).rejects.toThrow("stop-blacklist");
    expect(prepare).not.toHaveBeenCalled();
  });
});
