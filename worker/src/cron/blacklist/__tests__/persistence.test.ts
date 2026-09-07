import { afterEach, describe, expect, it, vi } from "vitest";
import { insertBlacklistRows } from "../persistence";
import type { BlacklistRow } from "../../../lib/blacklist/shared";
import { createLatestSchemaFixtureTracker } from "../../../test-helpers/latest-schema-sqlite";
import { makeNoopD1 } from "../../../test-helpers/noop-d1";

const fixtures = createLatestSchemaFixtureTracker();

afterEach(() => fixtures.closeAll());

function makeRow(overrides: Partial<BlacklistRow> = {}): BlacklistRow {
  return {
    id: "usdc:ethereum:0xhash:0",
    stablecoin: "USDC",
    chain_id: "ethereum",
    chain_name: "Ethereum",
    event_type: "blacklist",
    address: "0x0000000000000000000000000000000000000001",
    amount_native: null,
    amount_usd_at_event: null,
    amount_source: "unavailable",
    amount_status: "recoverable_pending",
    tx_hash: "0xhash",
    block_number: 123,
    timestamp: 1_710_000_000,
    methodology_version: "v1",
    contract_address: "0x0000000000000000000000000000000000000002",
    config_key: "ethereum-usdc",
    event_signature: "blacklist(address)",
    event_topic0: "0xtopic",
    suppression_reason: null,
    amount_attempt_count: 0,
    amount_last_attempted_at: null,
    amount_last_error_class: null,
    amount_last_provider: null,
    explorer_tx_url: "https://etherscan.io/tx/0xhash",
    explorer_address_url: "https://etherscan.io/address/0x0000000000000000000000000000000000000001",
    ...overrides,
  };
}

describe("insertBlacklistRows", () => {
  // 2026-08-29 dropped the legacy `amount` column from the statement but left its
  // placeholder behind; production rejected every new event for four days with
  // `D1_ERROR: 26 values for 25 columns`. Run the real statement against the
  // migrated schema so bind/column arity drift fails here, not in the cron.
  it("persists rows through the migrated schema and ignores duplicates", async () => {
    const { db, sqlite } = fixtures.open();
    const rows = [
      makeRow({ id: "usdt:ethereum:0xa:0", amount_native: 1_000, amount_usd_at_event: 1_000 }),
      makeRow({ id: "usdt:ethereum:0xb:0" }),
    ];

    await expect(insertBlacklistRows(db, rows)).resolves.toBe(2);
    await expect(insertBlacklistRows(db, [rows[1]!, makeRow({ id: "usdt:ethereum:0xc:0" })])).resolves.toBe(1);

    expect(
      sqlite.prepare("SELECT id, amount_native, amount_status FROM blacklist_events ORDER BY id").all(),
    ).toEqual([
      { id: "usdt:ethereum:0xa:0", amount_native: 1_000, amount_status: "recoverable_pending" },
      { id: "usdt:ethereum:0xb:0", amount_native: null, amount_status: "recoverable_pending" },
      { id: "usdt:ethereum:0xc:0", amount_native: null, amount_status: "recoverable_pending" },
    ]);
  });

  it("writes amount_native once without the deployed legacy amount column", async () => {
    const sqls: string[] = [];
    const binds: unknown[][] = [];
    const row = makeRow({ amount_native: 42.5 });
    const db = makeNoopD1({
      prepare: vi.fn((sql: string) => {
        sqls.push(sql);
        return {
          bind: (...values: unknown[]) => {
            binds.push(values);
            return {};
          },
        };
      }),
      batch: async () => [{ success: true, meta: { changes: 1 } }],
    });

    await expect(insertBlacklistRows(db, [row])).resolves.toBe(1);

    expect(sqls[0]).toContain("amount_native, amount_usd_at_event");
    expect(sqls[0]).not.toContain(" amount, ");
    expect(sqls[0]).not.toContain("amount =");
    expect(binds[0]?.filter((value) => value === row.amount_native)).toHaveLength(1);
    const columnCount = /\(([^()]*)\)\s*VALUES/i.exec(sqls[0]!)![1]!.split(",").length;
    const placeholderCount = /VALUES\s*\(([^()]*)\)/i.exec(sqls[0]!)![1]!.split(",").length;
    expect(columnCount).toBe(25);
    expect(placeholderCount).toBe(columnCount);
    expect(binds[0]).toHaveLength(columnCount);
  });

  it("retries transient D1 overloads through batchExecute", async () => {
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

    const inserted = await insertBlacklistRows(db, [makeRow()]);

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

    await expect(insertBlacklistRows(db, [makeRow()], controller.signal)).rejects.toThrow("stop-blacklist");
    expect(prepare).not.toHaveBeenCalled();
  });
});
