import { describe, expect, it, vi } from "vitest";
import {
  parseEventArgs,
  runEventReconciliation,
} from "../reconcile-blacklist-events-from-kyc-rip";
import type { RemoteD1Client } from "../lib/remote-d1";

type D1Mock = RemoteD1Client & {
  queryMock: ReturnType<typeof vi.fn>;
  executeStatementsMock: ReturnType<typeof vi.fn>;
};

function okPayload(data: unknown[]): Response {
  return new Response(JSON.stringify({ data }), { status: 200 });
}

function createD1Mock(): D1Mock {
  const queryMock = vi.fn(() => [
    {
      stablecoin: "USDT",
      chain_id: "ethereum",
      address: "0x0000000000000000000000000000000000000001",
    },
  ]);
  const executeStatementsMock = vi.fn();
  return {
    query: queryMock as RemoteD1Client["query"],
    executeStatements: executeStatementsMock as RemoteD1Client["executeStatements"],
    queryMock,
    executeStatementsMock,
  };
}

const eventRows = [
  {
    address: "0x0000000000000000000000000000000000000001",
    asset: "USDT",
    chain: "ETH",
    tx_hash: "0x1111111111111111111111111111111111111111111111111111111111111111",
  },
];

describe("event kyc.rip reconciliation", () => {
  it("defaults to dry-run and rejects invalid flags", () => {
    expect(parseEventArgs([])).toEqual({
      apply: false,
      remote: true,
      database: "stablecoin-db",
      timeoutMs: 15_000,
      minRows: 100,
    });
    expect(parseEventArgs(["--apply"]).apply).toBe(true);
    expect(parseEventArgs(["--remote"]).remote).toBe(true);
  });

  it("does not query or execute D1 in dry-run mode", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okPayload(eventRows));
    const d1 = createD1Mock();

    const summary = await runEventReconciliation(
      { apply: false, remote: true, database: "stablecoin-db", timeoutMs: 1000, minRows: 1 },
      { fetchImpl, d1 },
    );

    expect(summary.mode).toBe("dry-run");
    expect(summary.candidates).toBe(1);
    expect(summary.dryRunD1Skipped).toBe(true);
    expect(d1.queryMock).not.toHaveBeenCalled();
    expect(d1.executeStatementsMock).not.toHaveBeenCalled();
  });

  it("queries D1 in apply mode and skips inserts for already-known addresses", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okPayload(eventRows));
    const d1 = createD1Mock();

    const summary = await runEventReconciliation(
      { apply: true, remote: true, database: "stablecoin-db", timeoutMs: 1000, minRows: 1 },
      { fetchImpl, d1 },
    );

    expect(summary.mode).toBe("apply");
    expect(summary.candidates).toBe(0);
    expect(d1.queryMock).toHaveBeenCalledTimes(1);
    expect(d1.executeStatementsMock).not.toHaveBeenCalled();
  });
});
