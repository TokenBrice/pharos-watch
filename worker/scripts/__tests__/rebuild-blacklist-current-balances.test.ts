import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../rebuild-blacklist-current-balances";

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

  it("prints help with exit 0 and reports usage mistakes with exit 2", () => {
    const tsx = join(process.cwd(), "node_modules/.bin/tsx");
    const help = spawnSync(tsx, ["worker/scripts/rebuild-blacklist-current-balances.ts", "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Usage: tsx worker/scripts/rebuild-blacklist-current-balances.ts");

    const invalid = spawnSync(tsx, ["worker/scripts/rebuild-blacklist-current-balances.ts", "--bogus"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(invalid.status).toBe(2);
    expect(invalid.stderr).toContain("Unknown option '--bogus'");
  });
});
