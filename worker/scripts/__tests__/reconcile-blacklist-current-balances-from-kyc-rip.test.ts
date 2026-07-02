import { describe, expect, it, vi } from "vitest";
import {
  parseCurrentBalanceArgs,
  runCurrentBalanceReconciliation,
} from "../reconcile-blacklist-current-balances-from-kyc-rip";
import { createRemoteD1Mock } from "../../../scripts/test-utils/d1";
import { sqlString } from "../lib/remote-d1";

const SCRIPT_NAME = "worker/scripts/reconcile-blacklist-current-balances-from-kyc-rip.ts";

function okPayload(data: unknown[]): Response {
  return new Response(JSON.stringify({ data }), { status: 200 });
}

const currentRows = [
  {
    address: "0x0000000000000000000000000000000000000001",
    asset: "USDT",
    chain: "ETH",
    frozen_balance: "100",
  },
  {
    address: "0x0000000000000000000000000000000000000002",
    asset: "USDC",
    chain: "ETH",
    frozen_balance: "50",
  },
];

describe("current-balance kyc.rip reconciliation", () => {
  it("defaults to dry-run and parses apply mode", () => {
    expect(parseCurrentBalanceArgs([])).toEqual({
      apply: false,
      remote: true,
      database: "stablecoin-db",
      timeoutMs: 15_000,
      minRows: 100,
    });
    expect(
      parseCurrentBalanceArgs(["--execute", "--confirm", SCRIPT_NAME, "--timeout-ms", "1000", "--min-rows", "2"]).apply,
    ).toBe(true);
    expect(parseCurrentBalanceArgs(["--apply", "--confirm", SCRIPT_NAME]).apply).toBe(true);
    expect(() => parseCurrentBalanceArgs(["--apply"])).toThrow(/live mutation requires/);
    expect(() => parseCurrentBalanceArgs(["--bogus"])).toThrow(/Unknown argument/);
  });

  it("does not query or execute D1 in dry-run mode", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okPayload(currentRows));
    const d1 = createRemoteD1Mock([{ count: 3 }]);

    const summary = await runCurrentBalanceReconciliation(
      { apply: false, remote: true, database: "stablecoin-db", timeoutMs: 1000, minRows: 1 },
      { fetchImpl, d1 },
    );

    expect(summary.mode).toBe("dry-run");
    expect(summary.rowsToInsert).toBe(2);
    expect(d1.queryMock).not.toHaveBeenCalled();
    expect(d1.executeStatementsMock).not.toHaveBeenCalled();
  });

  it("executes one guarded replacement file in apply mode", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okPayload(currentRows));
    const d1 = createRemoteD1Mock([{ count: 3 }]);

    const summary = await runCurrentBalanceReconciliation(
      { apply: true, remote: true, database: "stablecoin-db", timeoutMs: 1000, minRows: 1 },
      { fetchImpl, d1, now: () => 1_700_000_000_000 },
    );

    expect(summary.targetRowsToDelete).toBe(3);
    expect(d1.queryMock).toHaveBeenCalledTimes(1);
    expect(d1.executeStatementsMock).toHaveBeenCalledTimes(1);
    const [rawStatements, prefix] = d1.executeStatementsMock.mock.calls[0]!;
    const statements = rawStatements as string[];
    expect(prefix).toBe("blacklist-kyc-rip-reconcile");
    expect(statements.join("\n")).not.toContain("BEGIN TRANSACTION;");
    expect(statements.join("\n")).not.toContain("COMMIT;");
    expect(statements.join("\n")).not.toContain("CREATE TEMP TABLE");
    expect(statements[0]).toContain("DELETE FROM blacklist_current_balances");
    expect(statements.slice(1)).toHaveLength(2);
    expect(statements.slice(1).every((statement) => statement.includes("INSERT OR REPLACE INTO"))).toBe(true);
  });

  it("emits direct replacement inserts for runs larger than the remote D1 default chunk size", async () => {
    const rows = Array.from({ length: 205 }, (_, index) => ({
      address: `0x${String(index + 1).padStart(40, "0")}`,
      asset: "USDT",
      chain: "ETH",
      frozen_balance: String(index + 1),
    }));
    const fetchImpl = vi.fn().mockResolvedValue(okPayload(rows));
    const d1 = createRemoteD1Mock([{ count: 3 }]);

    await runCurrentBalanceReconciliation(
      { apply: true, remote: true, database: "stablecoin-db", timeoutMs: 1000, minRows: 1 },
      { fetchImpl, d1, now: () => 1_700_000_000_000 },
    );

    const [rawStatements] = d1.executeStatementsMock.mock.calls[0]!;
    const statements = rawStatements as string[];
    expect(statements).toHaveLength(206);
    expect(statements.join("\n")).not.toContain("kyc_rip_current_balance_stage");
    expect(statements[0]).toContain("DELETE FROM blacklist_current_balances");
    expect(statements[200]).toContain("INSERT OR REPLACE INTO blacklist_current_balances");
  });

  it("blocks destructive replacement when normalized rows are below the minimum", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okPayload([currentRows[0]]));
    const d1 = createRemoteD1Mock([{ count: 3 }]);

    await expect(
      runCurrentBalanceReconciliation(
        { apply: true, remote: true, database: "stablecoin-db", timeoutMs: 1000, minRows: 2 },
        { fetchImpl, d1 },
      ),
    ).rejects.toThrow(/below minimum/);

    expect(d1.queryMock).not.toHaveBeenCalled();
    expect(d1.executeStatementsMock).not.toHaveBeenCalled();
  });

  it("blocks destructive replacement when normalized ids are duplicated", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okPayload([currentRows[0], currentRows[0]]));
    const d1 = createRemoteD1Mock([{ count: 3 }]);

    await expect(
      runCurrentBalanceReconciliation(
        { apply: true, remote: true, database: "stablecoin-db", timeoutMs: 1000, minRows: 1 },
        { fetchImpl, d1 },
      ),
    ).rejects.toThrow(/duplicates id/);

    expect(d1.queryMock).not.toHaveBeenCalled();
    expect(d1.executeStatementsMock).not.toHaveBeenCalled();
  });

  it("keeps SQL string escaping centralized", () => {
    expect(sqlString("O'Hara")).toBe("'O''Hara'");
    expect(sqlString(null)).toBe("NULL");
  });
});
