import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_SQL_SAFETY_ROOTS,
  findInsertArityMismatches,
  scanSqlInterpolationSafety,
  scanSqlSafetySource,
  sqlArityMismatches,
} from "../ci/check-sql-interpolation-safety.ts";

import { withTempRepo } from "./helpers/test-state";
const FIXTURE_ROOT = new URL("./fixtures/sql-safety/", import.meta.url);

describe("DEFAULT_SQL_SAFETY_ROOTS", () => {
  it("covers worker runtime, worker scripts, and root scripts", () => {
    expect(DEFAULT_SQL_SAFETY_ROOTS).toEqual(["worker/src", "worker/scripts", "scripts"]);
  });
});

describe("INSERT arity", () => {
  it("ignores quoted punctuation while counting a tuple", () => {
    expect(sqlArityMismatches("INSERT INTO t(a) VALUES ('x,y'), ('it''s ) fine')")).toEqual([]);
  });

  it("checks later tuples while ignoring SQL comments and nested expressions", () => {
    expect(sqlArityMismatches("INSERT INTO t(a) VALUES (coalesce(1, 2)), /* , ) */ (2,3)"))
      .toEqual([{ columns: 1, values: 2 }]);
  });

  it("ignores TypeScript comments but checks executable literals", () => {
    expect(findInsertArityMismatches(
      '// INSERT INTO t(a) VALUES (1,2)\nconst sql = `INSERT INTO t(a) VALUES (1), (2,3)`;',
      "fixture.ts",
    )).toEqual([{ line: 2, columns: 1, values: 2 }]);
  });

  it("routes static INSERT arity mismatches through the scan report", () => {
    withTempRepo("pharos-sql-safety", {
      "worker/src/insert.ts": "const good = `INSERT INTO t(a, b) VALUES (1, 2)`;\nconst bad = `INSERT INTO t(a) VALUES (1, 2)`;",
    }, (cwd) => {
      expect(scanSqlInterpolationSafety(["worker/src"], cwd).violations).toEqual([
        expect.objectContaining({ file: "worker/src/insert.ts", line: 2, rule: "insert-arity" }),
      ]);
    });
  });
});

describe("scanSqlInterpolationSafety", () => {
  it.each([
    "if (!allowedKinds.has(kind)) throw new Error('bad kind');\nreturn `SELECT id FROM records WHERE id = '${requestValue}'`;",
    "const query = `SELECT id FROM records WHERE id = '${requestValue}'`;\nif (!allowedKinds.has(kind)) throw new Error('bad kind');\nreturn query;",
    "throw new Error('unrelated');\nreturn `SELECT id FROM records WHERE id = '${requestValue}'`;",
    "const query = `SELECT id FROM records WHERE id = '${requestValue}'`;\nthrow new Error('unrelated');",
    "if (!allowedValues.has(requestValue)) { console.log('bad value'); }\nreturn `SELECT id FROM records WHERE id = '${requestValue}'`;",
    "if (!allowedValues.has(requestValue)) throw new Error('bad value');\nrequestValue = replacement;\nreturn `SELECT id FROM records WHERE id = '${requestValue}'`;",
    "if (!allowedValues.has(requestValue)) throw new Error('bad value');\nconst callback = (requestValue) => `SELECT id FROM records WHERE id = '${requestValue}'`;",
  ])("does not exempt SQL because of unrelated or non-guarding validation: %s", (body) => {
    withTempRepo("pharos-sql-safety", {
      "worker/src/query.ts": `function query(requestValue, kind) {\n${body}\n}`,
    }, (cwd) => {
      expect(scanSqlInterpolationSafety(["worker/src"], cwd).violations).toHaveLength(1);
    });
  });

  it("accepts a directly guarded value interpolation", () => {
    withTempRepo("pharos-sql-safety", {
      "worker/src/query.ts": [
        "function query(requestValue) {",
        "  if (!allowedValues.has(requestValue)) throw new Error('bad value');",
        "  return `SELECT id FROM records WHERE id = '${requestValue}'`;",
        "}",
      ].join("\n"),
    }, (cwd) => {
      expect(scanSqlInterpolationSafety(["worker/src"], cwd).violations).toEqual([]);
    });
  });

  it.each([
    "// SAFETY: fixed table only.\nconst safe = `SELECT * FROM ${fixedTable}`;\nconst unsafe = `SELECT * FROM ${requestTable}`;",
    "const unsafe = `SELECT * FROM ${requestTable}`;\n// SAFETY: fixed table only.\nconst safe = `SELECT * FROM ${fixedTable}`;",
    "const note = '// SAFETY: not a review comment';\nconst unsafe = `SELECT * FROM ${requestTable}`;",
    "// SAFETY: reviews the outer statement, not a statement inside the callback.\nconst query = () => { return `SELECT * FROM ${requestTable}`; };",
    "const queries = {\n// SAFETY: fixed table only.\nsafe: `SELECT * FROM ${fixedTable}`,\nunsafe: `SELECT * FROM ${requestTable}`,\n};",
  ])("does not let a SAFETY review exempt an unrelated SQL site: %s", (source) => {
    withTempRepo("pharos-sql-safety", { "worker/src/query.ts": source }, (cwd) => {
      expect(scanSqlInterpolationSafety(["worker/src"], cwd).violations).toHaveLength(1);
    });
  });

  it.each([
    "// SAFETY: fixed table only.\nconst query = `SELECT * FROM ${fixedTable}`;",
    "const query = (\n// SAFETY: fixed table only.\n`SELECT * FROM ${fixedTable}`);",
    "const queries = {\n// SAFETY: fixed table only.\nsafe: { sql: `SELECT * FROM ${fixedTable}` },\n};",
    "// SAFETY: fixed table in this concise callback.\nconst query = () => `SELECT * FROM ${fixedTable}`;",
    "const query = db\n// SAFETY: fixed table only.\n.prepare(`SELECT * FROM ${fixedTable}`);",
  ])("accepts a review attached to the SQL template or its own statement: %s", (source) => {
    withTempRepo("pharos-sql-safety", { "worker/src/query.ts": source }, (cwd) => {
      expect(scanSqlInterpolationSafety(["worker/src"], cwd).violations).toEqual([]);
    });
  });

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

  it.each([
    ["a", "worker/src/cron/mint-burn/f.ts", 'await db.prepare("SELECT 1").all(); await runWithOverloadRetry(() => db.prepare("SELECT 1").all());\n// pharos-allow-d1-overload: bounded ok\nawait db.prepare("SELECT 1").first();', ["d1-overload-unguarded"]],
    ["b/c/d", "worker/src/api/f.ts", 'const SQL="a=1 OR b=2",p=`SELECT id FROM t WHERE ${SQL} AND c=3`,ok=`SELECT id FROM t WHERE (${SQL}) AND c=3`,u="SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6",a="DELETE FROM cron_runs WHERE started_at<?",b="SELECT * FROM depeg_events WHERE s=1",c="SELECT j FROM cron_runs WHERE COALESCE(slot_started_at,started_at)>=?",d="SELECT key FROM cache WHERE key LIKE \'p:%\'",ok1="SELECT j FROM cron_runs WHERE started_at>=? AND COALESCE(slot_started_at,started_at)>=?";\n// pharos-allow-d1-scan: narrow ok\nconst ok2="SELECT key FROM cache WHERE key LIKE \'p:%\'";', ["sql-unparenthesized-or", "sql-compound-select-limit", ...Array(4).fill("d1-heavy-table-scan")]],
    ["e", "worker/src/lib/f.ts", 'for (const x of xs) await db.prepare("INSERT INTO t(a) VALUES (?)").bind(x).run(); while (true) await db.prepare("DELETE FROM t WHERE rowid IN (SELECT rowid FROM t LIMIT ?)").bind(10).run();', ["d1-unbatched-loop-write"]],
  ] as const)("G3 %s", (_n, file, src, expected) => {
    expect(scanSqlSafetySource(file, src, { orPredicateNames: new Set() }).map((v) => v.rule)).toEqual(expected);
  });

  it("enforces baseline and stale check", () => {
    const b = '{"schemaVersion":1,"guards":{"g1-fail-open-reads":{},"g2-freshness-clock-hygiene":{},"g3-sql-d1-safety":{"worker/src/a.ts":{"d1-heavy-table-scan":1}}}}';
    for (const [pred, exp] of [["LIKE 'x:%'", []], ["GLOB 'x:*'", ["stale-baseline"]]] as const) {
      withTempRepo("sql-b", { ".ci/static-guard-baselines.json": b, "worker/src/a.ts": `const q = "SELECT key FROM cache WHERE key ${pred}";` }, (cwd) => {
        expect(scanSqlInterpolationSafety(["worker/src"], cwd, { checkRatchet: false }).violations.map((v) => v.rule)).toEqual(exp);
      });
    }
  });
});
