import { runOperatorCli } from "./operator-cli.test-support";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import type { BlacklistSummaryResponse } from "@shared/types/market";
import { handleBlacklistSummary, materializeBlacklistSummarySnapshot } from "../../src/lib/blacklist-summary-service";
import { getBlacklistConfigsForSymbolAndChain } from "../../src/lib/blacklist-contracts";
import {
  balanceId, derivedCacheRows, ledgerRows, seedDerivedCaches, seedLedger, sqliteRemoteD1,
} from "./blacklist-current-balance-maintenance.test-support";
import {
  parseCurrentBalanceArgs,
  runCurrentBalanceReconciliation,
} from "../reconcile-blacklist-current-balances-from-kyc-rip";
import { createRemoteD1Mock } from "../../../scripts/test-utils/d1";

const SCRIPT_NAME = "worker/scripts/reconcile-blacklist-current-balances-from-kyc-rip.ts";
const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

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
      help: false,
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
  });

  it("rejects unknown, duplicate, conflicting, local, and positional arguments", () => {
    expect(() => parseCurrentBalanceArgs(["--bogus"])).toThrow(/Unknown option/);
    expect(() => parseCurrentBalanceArgs(["--timeout-ms", "1000", "--timeout-ms", "2000"])).toThrow(
      /may only be specified once/,
    );
    expect(() =>
      parseCurrentBalanceArgs(["--execute", "--apply", "--confirm", SCRIPT_NAME]),
    ).toThrow(/mutually exclusive/);
    expect(() => parseCurrentBalanceArgs(["--local"])).toThrow(/not supported/);
    expect(() => parseCurrentBalanceArgs(["unexpected"])).toThrow(/Unexpected argument/);
  });

  it("[entrypoint integration] supports short help and direct-run usage exit codes", async () => {
    expect(parseCurrentBalanceArgs(["-h"])).toMatchObject({ apply: false, help: true, remote: true });

    const tsx = join(process.cwd(), "node_modules/.bin/tsx");
    const help = await runOperatorCli(tsx, [SCRIPT_NAME, "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain(`Usage: tsx ${SCRIPT_NAME}`);

    const unconfirmed = await runOperatorCli(tsx, [SCRIPT_NAME, "--apply"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(unconfirmed.status).toBe(2);
    expect(unconfirmed.stderr).toContain("live mutation requires");
    expect(unconfirmed.stderr).toContain(`Usage: tsx ${SCRIPT_NAME}`);
  });

  it("does not query or execute D1 in dry-run mode", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okPayload(currentRows));
    const d1 = createRemoteD1Mock([{ count: 3 }]);

    const summary = await runCurrentBalanceReconciliation(
      { apply: false, remote: true, database: "stablecoin-db", timeoutMs: 1000, minRows: 1 },
      { fetchImpl, d1 },
    );

    expect(summary.mode).toBe("dry-run");
    expect(summary.rowsToUpsert).toBe(2);
    expect(d1.queryMock).not.toHaveBeenCalled();
    expect(d1.executeStatementsMock).not.toHaveBeenCalled();
  });

  it("admits scoped observations while retaining released, destroyed, and other-contract rows and invalidating caches", async () => {
    const { sqlite, db } = fixtures.open();
    const seeded = seedLedger(sqlite);
    seedDerivedCaches(sqlite);
    const retained = ledgerRows(sqlite).filter((row) => row.id !== balanceId(seeded[0]!));
    const now = Math.floor(Date.now() / 1000);
    await materializeBlacklistSummarySnapshot(db, now, now);
    const before = await (await handleBlacklistSummary(db)).json() as BlacklistSummaryResponse;
    expect(before.stats.trackedFrozenTotal).toBe(300);
    const { d1, imports } = sqliteRemoteD1(sqlite);
    const summary = await runCurrentBalanceReconciliation(
      { apply: true, remote: true, database: "stablecoin-db", timeoutMs: 1000, minRows: 1 },
      { fetchImpl: vi.fn().mockResolvedValue(okPayload([{ ...currentRows[0], frozen_balance: "250" }, currentRows[1]])),
        d1, now: () => 1_700_000_000_000 },
    );
    expect(summary.existingTargetRows).toBe(6);
    expect(summary.rowsToUpsert).toBe(2);
    expect(imports).toHaveLength(2);
    expect(sqlite.prepare("SELECT * FROM blacklist_current_balances WHERE id = ?").get(balanceId(seeded[0]!)))
      .toMatchObject({ amount_usd: 250, config_key: seeded[0]!.configKey, contract_address: seeded[0]!.contractAddress,
        last_successful_observed_at: 1_700_000_000, consecutive_failures: 0, attempt_count: 4 });
    for (const row of retained) {
      expect(sqlite.prepare("SELECT * FROM blacklist_current_balances WHERE id = ?").get(row.id)).toEqual(row);
    }
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM blacklist_current_balances WHERE config_key IS NULL AND contract_address IS NULL")
      .get()).toEqual({ count: 0 });
    expect(derivedCacheRows(sqlite)).toEqual([]);
    expect(sqlite.prepare("SELECT value FROM cache WHERE key = 'unrelated-cache'").get()).toEqual({ value: "{}" });
    const after = await (await handleBlacklistSummary(db)).json() as BlacklistSummaryResponse;
    expect(after.stats.trackedFrozenTotal).toBe(500);
    expect(after.stats.trackedAddressCount).toBe(7);
  });

  it("keeps every retained scope intact when the second admission import fails beyond 200 statements", async () => {
    const { sqlite } = fixtures.open();
    seedLedger(sqlite);
    seedDerivedCaches(sqlite);
    const before = ledgerRows(sqlite);
    const cachesBefore = derivedCacheRows(sqlite);
    const rows = [
      ...Array.from({ length: 204 }, (_, index) => ({
        address: `0x${String(index + 1).padStart(40, "0")}`,
        asset: index % 2 === 0 ? "USDT" : "USDC", chain: "ETH", frozen_balance: "999",
      })),
      { address: getBlacklistConfigsForSymbolAndChain("USDT", "tron")[0]!.contractAddress,
        asset: "USDT", chain: "TRON", frozen_balance: "999" },
    ];
    const { d1, imports } = sqliteRemoteD1(sqlite, { failChunk: 2 });
    await expect(runCurrentBalanceReconciliation(
      { apply: true, remote: true, database: "stablecoin-db", timeoutMs: 1000, minRows: 1 },
      { fetchImpl: vi.fn().mockResolvedValue(okPayload(rows)), d1 },
    )).rejects.toThrow("simulated import failure");
    expect(imports[0]).toHaveLength(200);
    expect(imports[1]).toHaveLength(6);
    expect(ledgerRows(sqlite)).toEqual(before);
    expect(derivedCacheRows(sqlite)).toEqual(cachesBefore);
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'blacklist_balance_stage_%'").all()).toEqual([]);
  });

  it("publishes every admitted observation across more than one import chunk", async () => {
    const { sqlite } = fixtures.open();
    seedLedger(sqlite);
    seedDerivedCaches(sqlite);
    const rows = Array.from({ length: 205 }, (_, index) => ({
      address: `0x${String(index + 1).padStart(40, "0")}`,
      asset: "USDT", chain: "ETH", frozen_balance: "999",
    }));
    const { d1, imports } = sqliteRemoteD1(sqlite);
    const summary = await runCurrentBalanceReconciliation(
      { apply: true, remote: true, database: "stablecoin-db", timeoutMs: 1000, minRows: 1 },
      { fetchImpl: vi.fn().mockResolvedValue(okPayload(rows)), d1 },
    );
    expect(summary.rowsToUpsert).toBe(205);
    expect(imports.map((chunk) => chunk.length)).toEqual([200, 6, 1]);
    expect(sqlite.prepare("SELECT COUNT(*) AS count, SUM(amount_usd) AS total FROM blacklist_current_balances")
      .get()).toEqual({ count: 210, total: 205 * 999 + 200 });
    expect(derivedCacheRows(sqlite)).toEqual([]);
  });

  it("rolls back cache invalidation and ledger changes together when final publication fails", async () => {
    const { sqlite } = fixtures.open();
    seedLedger(sqlite);
    seedDerivedCaches(sqlite);
    const before = ledgerRows(sqlite);
    const cachesBefore = derivedCacheRows(sqlite);
    const { d1 } = sqliteRemoteD1(sqlite, { failPublish: true, batchSize: 1 });
    await expect(runCurrentBalanceReconciliation(
      { apply: true, remote: true, database: "stablecoin-db", timeoutMs: 1000, minRows: 1 },
      { fetchImpl: vi.fn().mockResolvedValue(okPayload(currentRows)), d1 },
    )).rejects.toThrow("simulated import failure");
    expect(ledgerRows(sqlite)).toEqual(before);
    expect(derivedCacheRows(sqlite)).toEqual(cachesBefore);
  });

  it("blocks admission when normalized rows are below the minimum", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okPayload([
      currentRows[0],
      { ...currentRows[0], chain: "TRON", address: "invalid-tron-address" },
    ]));
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

  it("blocks admission when normalized ids are duplicated", async () => {
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

});
