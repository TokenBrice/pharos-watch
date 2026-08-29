import { describe, expect, it, vi } from "vitest";
import { insertBlacklistRows } from "../persistence";
import type { BlacklistRow } from "../../../lib/blacklist/shared";

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
  it("writes amount_native once without the deployed legacy amount column", async () => {
    const sqls: string[] = [];
    const binds: unknown[][] = [];
    const row = makeRow({ amount_native: 42.5 });
    const db = {
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
    } as unknown as D1Database;

    await expect(insertBlacklistRows(db, [row])).resolves.toBe(1);

    expect(sqls[0]).toContain("amount_native, amount_usd_at_event");
    expect(sqls[0]).not.toContain(" amount, ");
    expect(sqls[0]).not.toContain("amount =");
    expect(binds[0]?.filter((value) => value === row.amount_native)).toHaveLength(1);
  });

  it("retries transient D1 overloads through batchExecute", async () => {
    let attempts = 0;
    const db = {
      prepare: () => ({
        bind: () => ({}),
      }),
      batch: async () => {
        attempts++;
        if (attempts === 1) throw new Error("D1 DB is overloaded");
        return [{ success: true, meta: { changes: 1 } }];
      },
    } as unknown as D1Database;

    const inserted = await insertBlacklistRows(db, [makeRow()]);

    expect(inserted).toBe(1);
    expect(attempts).toBe(2);
  });

  it("honors an already-aborted signal before preparing rows", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop-blacklist"));
    const prepare = vi.fn();
    const db = {
      prepare,
      batch: async () => [],
    } as unknown as D1Database;

    await expect(insertBlacklistRows(db, [makeRow()], controller.signal)).rejects.toThrow("stop-blacklist");
    expect(prepare).not.toHaveBeenCalled();
  });
});
