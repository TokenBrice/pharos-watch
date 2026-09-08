import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const WORKER_SRC = path.resolve(__dirname, "..");
const INSERT_PATTERN =
  /INSERT\s+(?:OR\s+(?:IGNORE|REPLACE|ABORT|FAIL|ROLLBACK)\s+|)INTO\s+[\w.]+\s*\(([^()]*)\)\s*VALUES\s*\(/gi;

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "__tests__" && entry !== "test-helpers" && entry !== "node_modules") listSourceFiles(full, out);
      continue;
    }
    if (/\.(?:ts|mts)$/.test(entry) && !/\.test\.m?ts$/.test(entry)) out.push(full);
  }
  return out;
}

/** Preserve offsets but hide SQL strings, quoted identifiers and comments from structure counting. */
function structuralSql(sql: string): string {
  return sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]/g,
    (token) => (token.startsWith("--") || token.startsWith("/*") ? " " : "x").repeat(token.length));
}

function splitTopLevel(text: string): string[] {
  const structure = structuralSql(text);
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < structure.length; index++) {
    const char = structure[index];
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (char === "," && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.filter((part) => structuralSql(part).trim().length > 0);
}

function readTuple(source: string, openIndex: number): string | null {
  const structure = structuralSql(source);
  let depth = 0;
  for (let index = openIndex; index < structure.length; index++) {
    if (structure[index] === "(") depth++;
    if (structure[index] === ")" && --depth === 0) return source.slice(openIndex + 1, index);
  }
  return null;
}

function sqlArityMismatches(sql: string): Array<{ columns: number; values: number }> {
  const mismatches: Array<{ columns: number; values: number }> = [];
  const structure = structuralSql(sql);
  for (const match of structure.matchAll(INSERT_PATTERN)) {
    const columns = splitTopLevel(match[1]!).length;
    let open = match.index + match[0].length - 1;
    while (structure[open] === "(") {
      const tuple = readTuple(sql, open);
      if (tuple === null) break;
      const values = splitTopLevel(tuple).length;
      if (columns !== values) mismatches.push({ columns, values });
      const next = /^\s*,\s*(\()/.exec(structure.slice(open + tuple.length + 2));
      if (!next) break;
      open += tuple.length + 2 + next[0].length - 1;
    }
  }
  return mismatches;
}

// Only standalone TS string/no-substitution template literals are supported.
// Dynamic templates, concatenated SQL and INSERT ... SELECT require runtime SQLite coverage.
function scanSource(source: string, file: string) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const mismatches: Array<{ file: string; line: number; columns: number; values: number }> = [];
  function visit(node: ts.Node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
      for (const mismatch of sqlArityMismatches(node.text)) mismatches.push({ file, line, ...mismatch });
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return mismatches;
}

describe("worker INSERT statements", () => {
  it("ignores quoted punctuation while counting a tuple", () => {
    expect(splitTopLevel("'x,y', 'it''s ) fine', coalesce(?, ?)")).toHaveLength(3);
    expect(readTuple("(')')", 0)).toBe("')'");
    expect(sqlArityMismatches("INSERT INTO t(a) VALUES ('x,y'), ('it''s ) fine')")).toEqual([]);
  });

  it("checks later tuples while ignoring SQL comments and nested expressions", () => {
    expect(sqlArityMismatches("INSERT INTO t(a) VALUES (coalesce(1, 2)), /* , ) */ (2,3)"))
      .toEqual([{ columns: 1, values: 2 }]);
  });

  it("ignores TypeScript comments but checks executable literals", () => {
    expect(scanSource('// INSERT INTO t(a) VALUES (1,2)\nconst sql = `INSERT INTO t(a) VALUES (1), (2,3)`;', "fixture.ts"))
      .toEqual([{ file: "fixture.ts", line: 2, columns: 1, values: 2 }]);
  });

  it("binds the same number of values as named columns in supported literals", () => {
    expect(listSourceFiles(WORKER_SRC).flatMap((file) =>
      scanSource(readFileSync(file, "utf8"), path.relative(WORKER_SRC, file)))).toEqual([]);
    // Parses every worker source file; the budget covers the scan, not assertions.
  }, 60_000);
});
