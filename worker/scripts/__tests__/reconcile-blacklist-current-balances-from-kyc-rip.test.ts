import { describe, expect, it, vi } from "vitest";
import {
  parseCurrentBalanceArgs,
  runCurrentBalanceReconciliation,
} from "../reconcile-blacklist-current-balances-from-kyc-rip";
import { sqlString, type RemoteD1Client } from "../lib/remote-d1";

type D1Mock = RemoteD1Client & {
  queryMock: ReturnType<typeof vi.fn>;
  executeStatementsMock: ReturnType<typeof vi.fn>;
};

function okPayload(data: unknown[]): Response {
  return new Response(JSON.stringify({ data }), { status: 200 });
}

function createD1Mock(): D1Mock {
  const queryMock = vi.fn(() => [{ count: 3 }]);
  const executeStatementsMock = vi.fn();
  return {
    query: queryMock as RemoteD1Client["query"],
    executeStatements: executeStatementsMock as RemoteD1Client["executeStatements"],
    queryMock,
    executeStatementsMock,
  };
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
    expect(parseCurrentBalanceArgs(["--apply", "--timeout-ms", "1000", "--min-rows", "2"]).apply).toBe(true);
    expect(() => parseCurrentBalanceArgs(["--bogus"])).toThrow(/Unknown argument/);
  });

  it("does not query or execute D1 in dry-run mode", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okPayload(currentRows));
    const d1 = createD1Mock();

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
    const d1 = createD1Mock();

    const summary = await runCurrentBalanceReconciliation(
      { apply: true, remote: true, database: "stablecoin-db", timeoutMs: 1000, minRows: 1 },
      { fetchImpl, d1, now: () => 1_700_000_000_000 },
    );

    expect(summary.targetRowsToDelete).toBe(3);
    expect(d1.queryMock).toHaveBeenCalledTimes(1);
    expect(d1.executeStatementsMock).toHaveBeenCalledTimes(1);
    const [statements, prefix] = d1.executeStatementsMock.mock.calls[0]!;
    expect(prefix).toBe("blacklist-kyc-rip-reconcile");
    expect(statements.join("\n")).not.toContain("BEGIN TRANSACTION;");
    expect(statements.join("\n")).not.toContain("COMMIT;");
    expect(statements.join("\n")).toContain("CREATE TEMP TABLE kyc_rip_current_balance_stage");
    expect(statements.join("\n")).toContain("DELETE FROM blacklist_current_balances");
  });

  it("blocks destructive replacement when normalized rows are below the minimum", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okPayload([currentRows[0]]));
    const d1 = createD1Mock();

    await expect(runCurrentBalanceReconciliation(
      { apply: true, remote: true, database: "stablecoin-db", timeoutMs: 1000, minRows: 2 },
      { fetchImpl, d1 },
    )).rejects.toThrow(/below minimum/);

    expect(d1.queryMock).not.toHaveBeenCalled();
    expect(d1.executeStatementsMock).not.toHaveBeenCalled();
  });

  it("keeps SQL string escaping centralized", () => {
    expect(sqlString("O'Hara")).toBe("'O''Hara'");
    expect(sqlString(null)).toBe("NULL");
  });
});
