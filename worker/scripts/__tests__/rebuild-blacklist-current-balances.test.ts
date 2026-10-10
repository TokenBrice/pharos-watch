import { runOperatorCli } from "./operator-cli.test-support";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { BLACKLIST_CURRENT_BALANCE_WRITER_PAUSE_KEY, upsertBlacklistCurrentBalance } from "../../src/lib/blacklist-current-balances";
import { handleBlacklistSummary, materializeBlacklistSummarySnapshot } from "../../src/lib/blacklist-summary-service";
import type { BlacklistSummaryResponse } from "@shared/types/market";
import {
  balanceId, derivedCacheRows, ledgerRows, observation, seedDerivedCaches, seedLedger, sqliteRemoteD1,
} from "./blacklist-current-balance-maintenance.test-support";
import {
  assertBlacklistRebuildFailureRate,
  assertBlacklistRebuildWriterGuard,
  applyCurrentBalanceRebuild,
  parseArgs,
} from "../rebuild-blacklist-current-balances";

const SCRIPT_NAME = "rebuild-blacklist-current-balances";
const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

function armPause(sqlite: DatabaseSync): void {
  sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, '{}', 1)")
    .run(BLACKLIST_CURRENT_BALANCE_WRITER_PAUSE_KEY);
}

describe("rebuild blacklist current balances script args", () => {
  it("defaults to a local dry-run and requires the script confirmation for live mode", () => {
    expect(parseArgs([])).toMatchObject({ dryRun: true, remote: false, help: false });
    expect(parseArgs(["--remote"])).toMatchObject({ dryRun: true, remote: true });
    expect(parseArgs(["--execute", "--confirm", SCRIPT_NAME])).toMatchObject({
      dryRun: false,
      remote: false,
    });
    expect(() => parseArgs(["--execute"])).toThrow(/live mutation requires/);
    expect(parseArgs(["--force"])).toMatchObject({ dryRun: true, force: true });
  });

  it("parses numeric flags as positive integers", () => {
    expect(parseArgs(["--concurrency", "4", "--requests-per-second", "3"])).toMatchObject({
      concurrency: 4,
      requestsPerSecond: 3,
    });
    expect(parseArgs(["--concurrency=5", "--requests-per-second=6"])).toMatchObject({
      concurrency: 5,
      requestsPerSecond: 6,
    });
  });

  it.each([
    ["--concurrency", "NaN"],
    ["--concurrency", "0"],
    ["--concurrency", "1.5"],
    ["--requests-per-second", "NaN"],
    ["--requests-per-second", "0"],
    ["--requests-per-second", "1.5"],
  ])("rejects invalid numeric flag %s %s", (flag, value) => {
    expect(() => parseArgs([flag, value])).toThrow(`${flag} must be a positive integer`);
  });

  it("rejects missing numeric flag values", () => {
    expect(() => parseArgs(["--concurrency"])).toThrow(/--concurrency.*argument missing/);
    expect(() => parseArgs(["--requests-per-second"])).toThrow(/--requests-per-second.*argument missing/);
  });

  it("rejects unknown, duplicate, conflicting, and positional arguments", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(/Unknown option/);
    expect(() => parseArgs(["--chain", "tron", "--chain", "ethereum"])).toThrow(/may only be specified once/);
    expect(() => parseArgs(["--local", "--remote"])).toThrow(/mutually exclusive/);
    expect(() => parseArgs(["--execute", "--dry-run"])).toThrow(/mutually exclusive/);
    expect(() => parseArgs(["tron"])).toThrow(/Unexpected argument/);
  });

  it("preserves scoped last-known values and retained history with the runtime failure policy", async () => {
    const { sqlite } = fixtures.open();
    const runtime = fixtures.open();
    const seeded = seedLedger(sqlite);
    seedLedger(runtime.sqlite);
    armPause(sqlite);
    const retained = ledgerRows(sqlite).filter((row) => row.id !== balanceId(seeded[0]!));
    const failed = observation({
      amountNative: null, amountUsd: null, status: "provider_failed", source: "failed_provider",
      observedAt: 200, lastSuccessfulObservedAt: null, attemptCount: 1,
      lastAttemptedAt: 200, lastErrorClass: "HTTP 500", consecutiveFailures: 1,
    });
    const { d1 } = sqliteRemoteD1(sqlite);
    applyCurrentBalanceRebuild(d1, [failed]);
    await upsertBlacklistCurrentBalance(runtime.db, failed);
    expect(ledgerRows(sqlite)).toEqual(ledgerRows(runtime.sqlite));
    expect(sqlite.prepare("SELECT * FROM blacklist_current_balances WHERE id = ?").get(balanceId(failed)))
      .toMatchObject({
        amount_native: 100, amount_usd: 100, source: "current_balance",
        observed_at: 100, last_successful_observed_at: 100, attempt_count: 4,
        status: "provider_failed", last_attempted_at: 200, last_error_class: "HTTP 500", consecutive_failures: 1,
      });
    applyCurrentBalanceRebuild(d1, [failed]);
    expect(sqlite.prepare("SELECT attempt_count, consecutive_failures FROM blacklist_current_balances WHERE id = ?")
      .get(balanceId(failed))).toEqual({ attempt_count: 5, consecutive_failures: 2 });
    applyCurrentBalanceRebuild(d1, [observation({ amountNative: 125, amountUsd: 125, observedAt: 300, lastAttemptedAt: 300 })]);
    expect(sqlite.prepare("SELECT * FROM blacklist_current_balances WHERE id = ?").get(balanceId(failed)))
      .toMatchObject({ amount_usd: 125, observed_at: 300, last_successful_observed_at: 300, consecutive_failures: 0 });
    expect(ledgerRows(sqlite).filter((row) => row.id !== balanceId(failed))).toEqual(retained);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM blacklist_current_balances WHERE config_key IS NULL AND contract_address IS NULL")
      .get()).toEqual({ count: 0 });
  });

  it("keeps the full ledger intact when the second admission chunk fails beyond 200 statements", () => {
    const { sqlite } = fixtures.open();
    seedLedger(sqlite);
    seedDerivedCaches(sqlite);
    armPause(sqlite);
    const before = ledgerRows(sqlite);
    const cachesBefore = derivedCacheRows(sqlite);
    const { d1, imports } = sqliteRemoteD1(sqlite, { failChunk: 2 });
    const rows = Array.from({ length: 205 }, (_, index) => observation({
      address: `0x${String(index + 1).padStart(40, "0")}`, amountNative: 999, amountUsd: 999,
    }));
    expect(() => applyCurrentBalanceRebuild(d1, rows)).toThrow("simulated import failure");
    expect(imports[0]).toHaveLength(200);
    expect(imports[1]).toHaveLength(6);
    expect(ledgerRows(sqlite)).toEqual(before);
    expect(derivedCacheRows(sqlite)).toEqual(cachesBefore);
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'blacklist_balance_stage_%'").all()).toEqual([]);
  });

  it("invalidates derived caches and serves updated producer-backed totals after a scoped rebuild", async () => {
    const { sqlite, db } = fixtures.open();
    seedLedger(sqlite);
    seedDerivedCaches(sqlite);
    armPause(sqlite);
    const now = Math.floor(Date.now() / 1000);
    await materializeBlacklistSummarySnapshot(db, now, now);
    const before = await (await handleBlacklistSummary(db)).json() as BlacklistSummaryResponse;
    expect(before.stats.trackedFrozenTotal).toBe(300);
    applyCurrentBalanceRebuild(sqliteRemoteD1(sqlite).d1, [observation({ amountNative: 200, amountUsd: 200 })]);
    expect(derivedCacheRows(sqlite)).toEqual([]);
    expect(sqlite.prepare("SELECT value FROM cache WHERE key = 'unrelated-cache'").get()).toEqual({ value: "{}" });
    const after = await (await handleBlacklistSummary(db)).json() as BlacklistSummaryResponse;
    expect(after.stats.trackedFrozenTotal).toBe(400);
    expect(after.stats.trackedAddressCount).toBe(6);
  });

  it("fails closed on excessive provider failures unless force is explicit", () => {
    expect(() => assertBlacklistRebuildFailureRate(2, 10, false)).toThrow(/Refusing rebuild/);
    expect(() => assertBlacklistRebuildFailureRate(2, 10, true)).not.toThrow();
    expect(() => assertBlacklistRebuildFailureRate(1, 10, false)).not.toThrow();
  });

  it("requires the writer pause and rejects an active sync-blacklist lease", () => {
    expect(() => assertBlacklistRebuildWriterGuard({
      query: (sql: string) => sql.includes("FROM cache") ? [{ paused: 1 }] : [{ lease_until: 1_001 }],
    } as never, 1_000)).toThrow(/sync-blacklist lease is active/);
    expect(() => assertBlacklistRebuildWriterGuard({
      query: () => [],
    } as never, 1_000)).toThrow(/writer pause is not armed/);
    expect(() => assertBlacklistRebuildWriterGuard({
      query: (sql: string) => sql.includes("FROM cache") ? [{ paused: 1 }] : [{ lease_until: 999 }],
    } as never, 1_000)).not.toThrow();
  });

  it("[entrypoint integration] prints help with exit 0 and reports usage mistakes with exit 2", async () => {
    const tsx = join(process.cwd(), "node_modules/.bin/tsx");
    const help = await runOperatorCli(tsx, ["worker/scripts/rebuild-blacklist-current-balances.ts", "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Usage: tsx worker/scripts/rebuild-blacklist-current-balances.ts");

    const invalid = await runOperatorCli(tsx, ["worker/scripts/rebuild-blacklist-current-balances.ts", "--bogus"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(invalid.status).toBe(2);
    expect(invalid.stderr).toContain("Unknown option '--bogus'");
  });
});
