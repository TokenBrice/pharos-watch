import { runOperatorCli } from "./operator-cli.test-support";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertBlacklistRebuildFailureRate,
  assertBlacklistRebuildWriterGuard,
  buildCurrentBalanceMutationStatements,
  parseArgs,
} from "../rebuild-blacklist-current-balances";

const SCRIPT_NAME = "rebuild-blacklist-current-balances";

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

  it("preserves resolved amounts when a provider failure is rebuilt", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE blacklist_current_balances (
          id TEXT PRIMARY KEY,
          stablecoin TEXT NOT NULL,
          chain_id TEXT NOT NULL,
          address TEXT NOT NULL,
          amount_native REAL,
          amount_usd REAL,
          source TEXT NOT NULL,
          status TEXT NOT NULL,
          observed_at INTEGER NOT NULL,
          attempt_count INTEGER NOT NULL,
          last_attempted_at INTEGER,
          last_error_class TEXT
        );
        INSERT INTO blacklist_current_balances VALUES
          ('USDT:tron:TExisting', 'USDT', 'tron', 'TExisting', 12.5, 12.5, 'current_balance', 'resolved', 100, 3, 100, NULL);
      `);
      const statements = buildCurrentBalanceMutationStatements("USDT", "tron", [{
        id: "USDT:tron:TExisting",
        stablecoin: "USDT",
        chainId: "tron",
        address: "TExisting",
        amountNative: null,
        amountUsd: null,
        source: "current_balance",
        status: "provider_failed",
        observedAt: 200,
        attemptCount: 1,
        lastAttemptedAt: 200,
        lastErrorClass: "HTTP 500",
      }]);

      db.exec(statements.join("\n"));

      expect(db.prepare(
        "SELECT amount_native, amount_usd, source, status, observed_at, attempt_count FROM blacklist_current_balances",
      ).get()).toEqual({
        amount_native: 12.5,
        amount_usd: 12.5,
        source: "current_balance",
        status: "provider_failed",
        observed_at: 100,
        attempt_count: 4,
      });
    } finally {
      db.close();
    }
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
