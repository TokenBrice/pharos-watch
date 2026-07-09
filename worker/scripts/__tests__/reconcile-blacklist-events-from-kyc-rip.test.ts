import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseEventArgs, runEventReconciliation } from "../reconcile-blacklist-events-from-kyc-rip";
import { createRemoteD1Mock } from "../../../scripts/test-utils/d1";

const SCRIPT_NAME = "worker/scripts/reconcile-blacklist-events-from-kyc-rip.ts";

function okPayload(data: unknown[]): Response {
  return new Response(JSON.stringify({ data }), { status: 200 });
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
      help: false,
      remote: true,
      database: "stablecoin-db",
      timeoutMs: 15_000,
      minRows: 100,
    });
    expect(parseEventArgs(["--execute", "--confirm", SCRIPT_NAME]).apply).toBe(true);
    expect(parseEventArgs(["--apply", "--confirm", SCRIPT_NAME]).apply).toBe(true);
    expect(() => parseEventArgs(["--apply"])).toThrow(/live mutation requires/);
    expect(parseEventArgs(["--remote"]).remote).toBe(true);
  });

  it("rejects malformed operator arguments and supports short help", () => {
    expect(parseEventArgs(["-h"])).toMatchObject({ apply: false, help: true, remote: true });
    expect(() => parseEventArgs(["--bogus"])).toThrow(/Unknown option/);
    expect(() =>
      parseEventArgs([
        "--provider-url",
        "https://example.com/one",
        "--provider-url",
        "https://example.com/two",
      ]),
    ).toThrow(/may only be specified once/);
    expect(() => parseEventArgs(["--execute", "--apply", "--confirm", SCRIPT_NAME])).toThrow(
      /mutually exclusive/,
    );
    expect(() => parseEventArgs(["--local"])).toThrow(/not supported/);
    expect(() => parseEventArgs(["unexpected"])).toThrow(/Unexpected argument/);
  });

  it("prints direct-run help with exit 0", () => {
    const tsx = join(process.cwd(), "node_modules/.bin/tsx");
    const result = spawnSync(tsx, [SCRIPT_NAME, "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Usage: tsx ${SCRIPT_NAME}`);
    expect(result.stderr).toBe("");
  });

  it("does not query or execute D1 in dry-run mode", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okPayload(eventRows));
    const d1 = createRemoteD1Mock([
      {
        stablecoin: "USDT",
        chain_id: "ethereum",
        address: "0x0000000000000000000000000000000000000001",
      },
    ]);

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

  it("skips a candidate (and logs) when its receipt fetch fails instead of aborting the run", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okPayload(eventRows));
    const d1 = createRemoteD1Mock([]);
    const client = {
      getTransactionReceipt: vi.fn().mockRejectedValue(new Error("rate limited")),
      getBlock: vi.fn(),
    } as never;
    const log = vi.fn();

    const summary = await runEventReconciliation(
      { apply: true, remote: true, database: "stablecoin-db", timeoutMs: 1000, minRows: 1 },
      { fetchImpl, d1, client, log },
    );

    expect(summary.mode).toBe("apply");
    expect(summary.candidates).toBe(1);
    expect(summary.inserted).toBe(0);
    expect(d1.executeStatementsMock).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("receipt fetch failed"));
  });

  it("redacts secret-bearing RPC URLs from receipt fetch errors", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okPayload(eventRows));
    const d1 = createRemoteD1Mock([]);
    const client = {
      getTransactionReceipt: vi.fn().mockRejectedValue(
        new Error(
          "HTTP request failed. URL: https://eth-mainnet.g.alchemy.com/v2/LEAKED_ALCHEMY_KEY?token=LEAKED_QUERY_SECRET Status: 429",
        ),
      ),
      getBlock: vi.fn(),
    } as never;
    const log = vi.fn();

    await runEventReconciliation(
      { apply: true, remote: true, database: "stablecoin-db", timeoutMs: 1000, minRows: 1 },
      { fetchImpl, d1, client, log },
    );

    const receiptFailureLog = log.mock.calls
      .map(([message]) => String(message))
      .find((message) => message.includes("receipt fetch failed"));

    expect(receiptFailureLog).toContain("https://eth-mainnet.g.alchemy.com/[redacted]");
    expect(receiptFailureLog).toContain("Status: 429");
    expect(receiptFailureLog).not.toContain("LEAKED_ALCHEMY_KEY");
    expect(receiptFailureLog).not.toContain("LEAKED_QUERY_SECRET");
  });

  it("queries D1 in apply mode and skips inserts for already-known addresses", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okPayload(eventRows));
    const d1 = createRemoteD1Mock([
      {
        stablecoin: "USDT",
        chain_id: "ethereum",
        address: "0x0000000000000000000000000000000000000001",
      },
    ]);

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
