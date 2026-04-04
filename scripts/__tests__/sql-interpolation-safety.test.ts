import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_SQL_SAFETY_ROOTS,
  scanSqlInterpolationSafety,
} from "../check-sql-interpolation-safety.mjs";

const FIXTURE_ROOT = new URL("./fixtures/sql-safety/", import.meta.url);

describe("DEFAULT_SQL_SAFETY_ROOTS", () => {
  it("covers both worker/src and worker/scripts", () => {
    expect(DEFAULT_SQL_SAFETY_ROOTS).toEqual(["worker/src", "worker/scripts"]);
  });
});

describe("scanSqlInterpolationSafety", () => {
  it("accepts the safe allowlist and SAFETY-comment fixtures and flags the unsafe worker/src and worker/scripts fixtures", () => {
    const report = scanSqlInterpolationSafety([fileURLToPath(FIXTURE_ROOT)], process.cwd());

    expect(report.violations).toHaveLength(2);
    expect(report.violations.map((violation) => violation.file)).toEqual([
      "scripts/__tests__/fixtures/sql-safety/worker/scripts/unsafe-worker-scripts.ts",
      "scripts/__tests__/fixtures/sql-safety/worker/src/unsafe-worker-src.ts",
    ]);
    expect(report.violations.map((violation) => violation.line)).toEqual([2, 2]);
    expect(report.violations.map((violation) => violation.text)).toEqual([
      "return `DELETE FROM ${tableName} WHERE archived = 0`;",
      "return `SELECT * FROM ${tableName} WHERE deleted_at IS NULL`;",
    ]);
  });
});
