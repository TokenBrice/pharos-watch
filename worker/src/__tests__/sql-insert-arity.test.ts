import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const WORKER_SRC = path.resolve(__dirname, "..");
const INSERT_PATTERN =
  /INSERT\s+(?:OR\s+(?:IGNORE|REPLACE|ABORT|FAIL|ROLLBACK)\s+)?INTO\s+[\w.]+\s*\(([^()]*)\)\s*VALUES\s*\(/gi;

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- repo-local source scan.
    if (statSync(full).isDirectory()) {
      if (entry !== "__tests__" && entry !== "test-helpers" && entry !== "node_modules") listSourceFiles(full, out);
      continue;
    }
    if (/\.(?:ts|mts)$/.test(entry) && !/\.test\.m?ts$/.test(entry)) out.push(full);
  }
  return out;
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/** Return the text of the first balanced `( ... )` tuple starting at `openIndex`. */
function readTuple(source: string, openIndex: number): string | null {
  let depth = 0;
  for (let index = openIndex; index < source.length; index++) {
    const char = source[index];
    if (char === "(") depth++;
    if (char === ")") {
      depth--;
      if (depth === 0) return source.slice(openIndex + 1, index);
    }
  }
  return null;
}

interface InsertSite {
  file: string;
  line: number;
  columns: number;
  values: number;
}

function scanInsertArity(): InsertSite[] {
  const mismatches: InsertSite[] = [];
  for (const file of listSourceFiles(WORKER_SRC)) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- repo-local source scan.
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(INSERT_PATTERN)) {
      const columnList = match[1]!;
      // Column lists interpolated from JS arrays cannot be counted statically.
      if (columnList.includes("${")) continue;
      const tupleOpen = match.index! + match[0].length - 1;
      const tuple = readTuple(source, tupleOpen);
      if (tuple === null || tuple.includes("${")) continue;
      const columns = splitTopLevel(columnList).length;
      const values = splitTopLevel(tuple).length;
      if (columns === values) continue;
      mismatches.push({
        file: path.relative(WORKER_SRC, file),
        line: source.slice(0, match.index).split("\n").length,
        columns,
        values,
      });
    }
  }
  return mismatches;
}

describe("worker INSERT statements", () => {
  // `INSERT ... (cols) VALUES (?, ...)` arity drift only surfaces as a runtime
  // D1 SQLITE_ERROR (`N values for M columns`), and mock-backed tests never
  // prepare the statement. Count both sides statically for every literal
  // INSERT in worker/src.
  it("bind the same number of values as named columns", () => {
    expect(scanInsertArity()).toEqual([]);
  });
});
