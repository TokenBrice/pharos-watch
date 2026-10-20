import { afterEach, describe, expect, it, vi } from "vitest";
import { parseEventArgs, runEventReconciliation } from "../reconcile-blacklist-events-from-kyc-rip";
import { createRemoteD1Mock } from "../../../scripts/test-utils/d1";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import type { RemoteD1Client } from "../lib/remote-d1";
import { buildBlacklistActiveRecords } from "@shared/lib/blacklist-active-records";
import { mapBlacklistEventRow, type BlacklistEventRow } from "../../src/lib/blacklist-api";
import { getBlacklistConfigsForSymbolAndChain } from "../../src/lib/blacklist-contracts";

const databases = createLatestSchemaFixtureTracker();
afterEach(() => databases.closeAll());

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
  it.each(["matching", "address", "transaction", "event", "contract", "partial-failure"])(
    "persists only matching blacklist receipts: %s",
    async (scenario) => {
      const { sqlite } = databases.open();
      sqlite.exec("ALTER TABLE blacklist_events DROP COLUMN amount");
      const candidate = eventRows[0]!;
      const txHash = candidate.tx_hash as `0x${string}`;
      const contract = "0xdac17f958d2ee523a2206206994597c13d831ec7" as const;
      const receipt = {
        blockNumber: 20_000_000n,
        logs: [{
          address: scenario === "contract" ? "0x0000000000000000000000000000000000000002" as const : contract,
          topics: [scenario === "event"
            ? "0xd7e9ec6e6ecd65492dce6bf513cd6867560d49544421d0783ddf06e76c24470c"
            : "0x42e160154868087d6bfdc0ca23d96a1c1cfa32f1b72ba9ba27b69b98a0d819dc"] as `0x${string}`[],
          data: `0x${"0".repeat(63)}${scenario === "address" ? "2" : "1"}` as `0x${string}`,
          blockNumber: 20_000_000n,
          transactionHash: scenario === "transaction" ? `0x${"2".repeat(64)}` as `0x${string}` : txHash,
          logIndex: 7,
        }],
      };
      const getTransactionReceipt = vi.fn().mockResolvedValue(receipt);
      const rows = [candidate];
      if (scenario === "partial-failure") {
        rows.unshift({ ...candidate, address: "0x0000000000000000000000000000000000000002", tx_hash: `0x${"2".repeat(64)}` });
        getTransactionReceipt.mockRejectedValueOnce(new Error("receipt unavailable"));
      }
      const d1: RemoteD1Client = {
        query: <T,>(sql: string) => sqlite.prepare(sql).all() as T[],
        queryRaw: () => "[]",
        executeStatements: (statements) => { for (const sql of statements) sqlite.exec(sql); },
      };
      const summary = await runEventReconciliation(
        { apply: true, remote: true, database: "stablecoin-db", timeoutMs: 1000, minRows: 1 },
        { d1, fetchImpl: vi.fn().mockResolvedValue(okPayload(rows)),
          client: { getTransactionReceipt, getBlock: vi.fn().mockResolvedValue({ timestamp: 1_700_000_000n }) } },
      );
      const stored = sqlite.prepare("SELECT id, address, tx_hash, event_type, timestamp, block_number, contract_address, stablecoin, chain_id, amount_native, amount_usd_at_event FROM blacklist_events").all();
      const success = scenario === "matching" || scenario === "partial-failure";
      expect(stored).toEqual(success ? [{
        id: `ethereum-${txHash}-0x7`, address: candidate.address, tx_hash: txHash,
        event_type: "blacklist", timestamp: 1_700_000_000, block_number: 20_000_000,
        contract_address: contract, stablecoin: "USDT", chain_id: "ethereum",
        amount_native: null, amount_usd_at_event: null,
      }] : []);
      expect(summary.inserted).toBe(success ? 1 : 0);
    },
  );

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

  it("queries D1 in apply mode and skips the exact known contract/transaction/address freeze", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okPayload(eventRows));
    const d1 = createRemoteD1Mock([
      {
        stablecoin: "USDT",
        chain_id: "ethereum",
        address: "0x0000000000000000000000000000000000000001",
        contract_address: "0xDAC17F958D2EE523A2206206994597C13D831EC7",
        tx_hash: eventRows[0]!.tx_hash,
      },
    ]);
    const client = { getTransactionReceipt: vi.fn(), getBlock: vi.fn() };

    const summary = await runEventReconciliation(
      { apply: true, remote: true, database: "stablecoin-db", timeoutMs: 1000, minRows: 1 },
      { fetchImpl, d1, client },
    );

    expect(summary.mode).toBe("apply");
    expect(summary.candidates).toBe(0);
    expect(d1.queryMock).toHaveBeenCalledTimes(1);
    expect(d1.executeStatementsMock).not.toHaveBeenCalled();
    expect(client.getTransactionReceipt).not.toHaveBeenCalled();
  });

  it("repairs freeze A/release B/refreeze C and keeps repeated C idempotent", async () => {
    const { sqlite } = databases.open();
    const candidate = eventRows[0]!;
    const config = getBlacklistConfigsForSymbolAndChain("USDT", "ethereum")[0]!;
    const contract = "0xdac17f958d2ee523a2206206994597c13d831ec7" as const;
    const freezeA = `0x${"a".repeat(64)}`;
    const releaseB = `0x${"b".repeat(64)}`;
    const insert = sqlite.prepare(`INSERT INTO blacklist_events
      (id, stablecoin, chain_id, chain_name, event_type, address, contract_address, config_key,
       tx_hash, block_number, timestamp, explorer_tx_url, explorer_address_url)
      VALUES (?, 'USDT', 'ethereum', 'Ethereum', ?, ?, ?, ?, ?, ?, ?, '', '')`);
    insert.run(`ethereum-${freezeA}-0x1`, "blacklist", candidate.address, contract, config.configKey, freezeA, 100, 100);
    insert.run(`ethereum-${releaseB}-0x1`, "unblacklist", candidate.address, contract, config.configKey, releaseB, 200, 200);
    // A matching transaction at a different contract must not suppress the requested freeze.
    insert.run(`ethereum-${candidate.tx_hash}-0x8`, "blacklist", candidate.address, "0xother", "other-contract", candidate.tx_hash, 300, 300);
    const history = () => (sqlite.prepare("SELECT * FROM blacklist_events").all() as BlacklistEventRow[]).map(mapBlacklistEventRow);
    expect(buildBlacklistActiveRecords(history()).filter((row) => row.key.includes(config.configKey))).toEqual([]);
    const retained = sqlite.prepare("SELECT * FROM blacklist_events ORDER BY id").all();
    const d1: RemoteD1Client = {
      query: <T,>(sql: string) => sqlite.prepare(sql).all() as T[],
      queryRaw: () => "[]",
      executeStatements: (statements) => { for (const sql of statements) sqlite.exec(sql); },
    };
    const client = {
      getTransactionReceipt: vi.fn().mockResolvedValue({
        blockNumber: 300n,
        logs: [{
          address: contract,
          topics: ["0x42e160154868087d6bfdc0ca23d96a1c1cfa32f1b72ba9ba27b69b98a0d819dc"],
          data: `0x${"0".repeat(63)}1`, blockNumber: 300n,
          transactionHash: candidate.tx_hash, logIndex: 7,
        }],
      }),
      getBlock: vi.fn().mockResolvedValue({ timestamp: 300n }),
    };
    const options = { apply: true, remote: true, database: "stablecoin-db", timeoutMs: 1000, minRows: 1 } as const;
    const run = () => runEventReconciliation(options, {
      d1, client, fetchImpl: vi.fn().mockResolvedValue(okPayload([candidate, candidate])),
    });
    expect(await run()).toMatchObject({ candidates: 2, inserted: 2 });
    const addedId = `ethereum-${candidate.tx_hash}-0x7`;
    expect(sqlite.prepare("SELECT id, event_type, tx_hash FROM blacklist_events WHERE id = ?").get(addedId))
      .toEqual({ id: addedId, event_type: "blacklist", tx_hash: candidate.tx_hash });
    expect(sqlite.prepare("SELECT * FROM blacklist_events WHERE id != ? ORDER BY id").all(addedId)).toEqual(retained);
    expect(buildBlacklistActiveRecords(history()).filter((row) => row.key.includes(config.configKey)))
      .toMatchObject([{ address: candidate.address, blacklistedAt: 300, destroyedAt: null }]);
    expect(await run()).toMatchObject({ candidates: 0, inserted: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM blacklist_events").get()).toEqual({ count: 4 });
    expect(client.getTransactionReceipt).toHaveBeenCalledTimes(2);
  });
});
