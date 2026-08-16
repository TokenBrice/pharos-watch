import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_SQL_SAFETY_ROOTS,
  scanSqlInterpolationSafety,
} from "../ci/check-sql-interpolation-safety.ts";

const FIXTURE_ROOT = new URL("./fixtures/sql-safety/", import.meta.url);

describe("DEFAULT_SQL_SAFETY_ROOTS", () => {
  it("covers worker runtime, worker scripts, and root scripts", () => {
    expect(DEFAULT_SQL_SAFETY_ROOTS).toEqual(["worker/src", "worker/scripts", "scripts"]);
  });
});

describe("scanSqlInterpolationSafety", () => {
  it("accepts safe fixtures and flags unsafe worker and root script interpolation", () => {
    const report = scanSqlInterpolationSafety([fileURLToPath(FIXTURE_ROOT)], process.cwd());

    expect(report.scannedFiles).toHaveLength(6);
    expect(report.violations).toHaveLength(3);
    expect(report.violations.map((violation) => violation.file)).toEqual([
      "scripts/__tests__/fixtures/sql-safety/scripts/unsafe-root-script.ts",
      "scripts/__tests__/fixtures/sql-safety/worker/scripts/unsafe-worker-scripts.ts",
      "scripts/__tests__/fixtures/sql-safety/worker/src/unsafe-worker-src.ts",
    ]);
    expect(report.violations.map((violation) => violation.line)).toEqual([2, 2, 2]);
    expect(report.violations.map((violation) => violation.text)).toEqual([
      "return `SELECT id FROM depeg_events WHERE peg_type = '${pegType}'`;",
      "return `DELETE FROM ${tableName} WHERE archived = 0`;",
      "return `SELECT * FROM ${tableName} WHERE deleted_at IS NULL`;",
    ]);
  });
});
