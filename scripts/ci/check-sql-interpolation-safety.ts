#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { retentionPolicyRegistry, RETENTION_NON_APPEND_TABLES } from "@shared/lib/retention-policy";
import { reportViolations } from "../lib/report-violations.mts";
import { scanSourceGate } from "../lib/source-gate.mts";
import { collectSourceFilesUnderRoots } from "../lib/source-files.mts";
import {
  applyGuardBaselineToViolations,
  normalizeBaselineFilePath,
  STATIC_GUARD_BASELINE_PATH,
  verifyStaticGuardBaselineRatchet,
} from "../lib/static-guard-baseline.mjs";
import { runDirectCli } from "../lib/cli-args.mjs";
import ts from "typescript";

export const DEFAULT_SQL_SAFETY_ROOTS = ["worker/src", "worker/scripts", "scripts"];
export const SQL_INTERPOLATION_PATTERN = /`\s*(?:(?:SELECT|DELETE|UPDATE|INSERT)[^`]*(?:FROM|INTO|UPDATE|JOIN)\s+\$\{|(?:SELECT|DELETE|UPDATE)[^`]*(?:WHERE|AND|OR|SET)\s+[\w.]+\s*=\s*['"]?\$\{)/i;
export const SQL_SAFETY_PATTERN = /\/\/\s*SAFETY:/;
export const SQL_SAFETY_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);

const ALLOW_D1_OVERLOAD_PATTERN = /\/\/\s*pharos-allow-d1-overload:\s*(\S[\s\S]*)/;
const ALLOW_D1_SCAN_PATTERN = /\/\/\s*pharos-allow-d1-scan:\s*(\S[\s\S]*)/;
const ALLOW_D1_LOOP_WRITE_PATTERN = /\/\/\s*pharos-allow-d1-loop-write:\s*(\S[\s\S]*)/;
const MIN_ESCAPE_REASON_LEN = 8;

const INSERT_PATTERN =
  /INSERT\s+(?:OR\s+(?:IGNORE|REPLACE|ABORT|FAIL|ROLLBACK)\s+|)INTO\s+[\w.]+\s*\(([^()]*)\)\s*VALUES\s*\(/gi;

// R5 single authority: derive heavy tables from shared/lib/retention-policy.ts,
// supplemented only by high-row non-append tables tracked in RETENTION_NON_APPEND_TABLES.
const HEAVY_NON_APPEND_SUPPLEMENT = [
  "stress_signals",
  "stress_signal_history",
  "telegram_deliveries",
] as const;

export const HEAVY_D1_TABLES: ReadonlySet<string> = (() => {
  const tables = new Set<string>(
    retentionPolicyRegistry(
      { batchLimit: 1, runLimit: 1, smallBatchLimit: 1, smallRunLimit: 1 },
      { safetyScoreJournalSec: 1 },
    ).map((policy) => policy.table.toLowerCase()),
  );
  for (const table of HEAVY_NON_APPEND_SUPPLEMENT) {
    if (!Object.hasOwn(RETENTION_NON_APPEND_TABLES, table)) {
      throw new Error(`Heavy-table supplement "${table}" missing from RETENTION_NON_APPEND_TABLES`);
    }
    tables.add(table);
  }
  return tables;
})();

const INDEXED_CLOCK_COLUMNS = new Set([
  "started_at",
  "slot_started_at",
  "timestamp",
  "snapshot_date",
  "recorded_at",
  "attempted_at",
  "fetched_at",
  "updated_at",
  "hour_ts",
  "observed_at",
  "created_at",
  "bucket_start",
]);

const OVERLOAD_WRAPPER_NAMES = new Set([
  "runWithOverloadRetry",
  "batchExecute",
  "executeAtomicBatch",
  "runBoundedPrune",
  "runBoundedPruneGroup",
  "deleteCapped",
  "runRetentionPolicies",
  "readOutlastingResourceWindow",
]);

const OR_CONSTANT_NAME_PATTERN = /SQL|FILTER|WHERE|PREDICATE|CLAUSE/i;
const DB_RECEIVER_NAME_PATTERN = /(?:^db$|^d1$|^database$|Db$|DB$)/;

export type SqlSafetyRule =
  | "interpolation"
  | "insert-arity"
  | "d1-overload-unguarded"
  | "sql-unparenthesized-or"
  | "sql-compound-select-limit"
  | "d1-heavy-table-scan"
  | "d1-unbatched-loop-write"
  | "stale-baseline"
  | "baseline-ratchet";

export interface SqlSafetyViolation {
  file: string;
  line: number;
  text: string;
  root: string;
  rule: SqlSafetyRule;
}

interface SqlInsertArityMismatch {
  line: number;
  columns: number;
  values: number;
}

interface SqlSafetyReport {
  scannedFiles: string[];
  violations: SqlSafetyViolation[];
}

function isTestHelperFile(relPath: string): boolean {
  const normalized = normalizeBaselineFilePath(relPath);
  return /(?:^|\/)(?:test-helpers|test-utils|__mocks__)\//.test(normalized)
    || /(?:^|\/)[^/]*\.test-support\.[cm]?[jt]sx?$/.test(normalized);
}

function isFocusedD1OverloadFile(relPath: string): boolean {
  const normalized = normalizeBaselineFilePath(relPath);
  if (isTestHelperFile(normalized)) return false;
  return (
    normalized.startsWith("worker/src/cron/mint-burn/")
    || normalized.startsWith("worker/src/cron/blacklist/")
    || normalized === "worker/src/cron/sync-blacklist.ts"
    || normalized.startsWith("worker/src/cron/yield-sync/")
    || normalized === "worker/src/lib/alchemy-logs.ts"
    || normalized === "worker/src/lib/mint-burn-pipeline/sync-state.ts"
    || normalized === "worker/src/lib/mint-burn-pipeline/persistence.ts"
  );
}

function isLoopWriteScopedFile(relPath: string): boolean {
  const normalized = normalizeBaselineFilePath(relPath);
  if (isTestHelperFile(normalized)) return false;
  return normalized.startsWith("worker/src/cron/") || normalized.startsWith("worker/src/lib/");
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

/** Count named columns versus bound values for every static INSERT tuple. */
export function sqlArityMismatches(sql: string): Array<{ columns: number; values: number }> {
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

/** Only standalone TS string/no-substitution template literals are supported.
 * Dynamic templates, concatenated SQL and INSERT ... SELECT require runtime
 * SQLite coverage. */
export function findInsertArityMismatches(source: string, file = "source.ts"): SqlInsertArityMismatch[] {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false);
  const mismatches: SqlInsertArityMismatch[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
      for (const mismatch of sqlArityMismatches(node.text)) mismatches.push({ line, ...mismatch });
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return mismatches;
}

function hasGuardedInterpolation(template: ts.TemplateExpression): boolean {
  let statement: ts.Node = template;
  while (statement.parent && !ts.isBlock(statement.parent) && !ts.isSourceFile(statement.parent)) {
    if (ts.isFunctionLike(statement)) return false;
    statement = statement.parent;
  }
  const parent = statement.parent;
  if (!parent || (!ts.isBlock(parent) && !ts.isSourceFile(parent))) return false;
  const index = parent.statements.findIndex((entry) => entry === statement);
  const guard = parent.statements[index - 1];
  if (!guard || !ts.isIfStatement(guard) || guard.elseStatement) return false;
  const condition = guard.expression;
  if (!ts.isPrefixUnaryExpression(condition) || condition.operator !== ts.SyntaxKind.ExclamationToken) return false;
  const check = condition.operand;
  if (!ts.isCallExpression(check) || !ts.isPropertyAccessExpression(check.expression)
    || check.expression.name.text !== "has" || check.arguments.length !== 1) return false;
  const rejection = guard.thenStatement;
  const throws = ts.isThrowStatement(rejection)
    || (ts.isBlock(rejection) && rejection.statements.length === 1 && ts.isThrowStatement(rejection.statements[0]));
  if (!throws) return false;
  const checked = check.arguments[0];
  if (!ts.isIdentifier(checked)) return false;
  return template.templateSpans.every((span) => ts.isIdentifier(span.expression) && span.expression.text === checked.text);
}

function hasReviewedComment(
  target: ts.Node,
  sourceFile: ts.SourceFile,
  pattern: RegExp,
  minReasonLen = 0,
): boolean {
  const matchesAt = (position: number): boolean => (
    ts.getLeadingCommentRanges(sourceFile.text, position) ?? []
  ).some((comment) => {
    if (comment.kind !== ts.SyntaxKind.SingleLineCommentTrivia) return false;
    const match = pattern.exec(sourceFile.text.slice(comment.pos, comment.end));
    if (!match) return false;
    return minReasonLen === 0 || (match[1]?.trim().length ?? 0) >= minReasonLen;
  });
  let node: ts.Node = target;
  while (!ts.isBlock(node) && !ts.isSourceFile(node)) {
    if (matchesAt(node.getFullStart())) return true;
    // A review before `.prepare(...)` / `.run()` belongs to this call, not the receiver's statement.
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && matchesAt(node.expression.expression.end)) return true;
    if (ts.isStatement(node) || !node.parent) break;
    node = node.parent;
  }
  return false;
}

function hasSafetyReview(template: ts.TemplateExpression, sourceFile: ts.SourceFile): boolean {
  return hasReviewedComment(template, sourceFile, SQL_SAFETY_PATTERN);
}

function extractSqlFromExpression(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isTemplateExpression(node)) {
    let text = node.head.text;
    for (const span of node.templateSpans) {
      text += ` __expr__ ${span.literal.text}`;
    }
    return text;
  }
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return extractSqlFromExpression(node.expression);
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = extractSqlFromExpression(node.left);
    const right = extractSqlFromExpression(node.right);
    if (left !== null && right !== null) return `${left}${right}`;
  }
  return null;
}

function hasTopLevelSqlOr(sql: string): boolean {
  const cleaned = structuralSql(sql).replace(
    /\bINSERT\s+OR\s+(?:IGNORE|REPLACE|ABORT|FAIL|ROLLBACK)\b/gi,
    "INSERT   ",
  );
  let depth = 0;
  let tokenStart = -1;
  for (let i = 0; i <= cleaned.length; i++) {
    const ch = cleaned[i] ?? " ";
    if (ch === "(") {
      depth++;
      tokenStart = -1;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      tokenStart = -1;
      continue;
    }
    const isWord = /[A-Za-z0-9_]/.test(ch);
    if (isWord) {
      if (tokenStart < 0) tokenStart = i;
    } else if (tokenStart >= 0) {
      if (depth === 0 && cleaned.slice(tokenStart, i).toUpperCase() === "OR") {
        return true;
      }
      tokenStart = -1;
    }
  }
  return false;
}

function collectOrPredicateConstantsFromAst(sourceFile: ts.SourceFile, out: Set<string>): void {
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && OR_CONSTANT_NAME_PATTERN.test(node.name.text)) {
      const sql = extractSqlFromExpression(node.initializer);
      if (sql && hasTopLevelSqlOr(sql)) {
        out.add(node.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

const defaultOrPredicateCache = new Map<string, ReadonlySet<string>>();

function getDefaultOrPredicateConstants(cwd: string): ReadonlySet<string> {
  const cached = defaultOrPredicateCache.get(cwd);
  if (cached) return cached;
  const names = new Set<string>();
  const files = collectSourceFilesUnderRoots(DEFAULT_SQL_SAFETY_ROOTS, cwd, {
    extensions: SQL_SAFETY_EXTENSIONS,
  });
  for (const relPath of files) {
    const absPath = resolve(cwd, relPath);
    if (!existsSync(absPath)) continue;
    const content = ts.sys.readFile(absPath);
    if (!content || !/\bOR\b/i.test(content) || !OR_CONSTANT_NAME_PATTERN.test(content)) continue;
    const ast = ts.createSourceFile(relPath, content, ts.ScriptTarget.Latest, false);
    collectOrPredicateConstantsFromAst(ast, names);
  }
  defaultOrPredicateCache.set(cwd, names);
  return names;
}

function findPrepareCallInChain(expr: ts.Expression): ts.CallExpression | null {
  let current: ts.Expression = expr;
  while (true) {
    if (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)
      || ts.isNonNullExpression(current) || ts.isSatisfiesExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
      if (current.expression.name.text === "prepare") {
        return current;
      }
      current = current.expression.expression;
      continue;
    }
    return null;
  }
}

function isDbBatchReceiver(expr: ts.Expression): boolean {
  let current: ts.Expression = expr;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)
    || ts.isNonNullExpression(current)) {
    current = current.expression;
  }
  if (ts.isIdentifier(current)) {
    return DB_RECEIVER_NAME_PATTERN.test(current.text);
  }
  if (ts.isPropertyAccessExpression(current)) {
    return DB_RECEIVER_NAME_PATTERN.test(current.name.text);
  }
  return false;
}

function isInsideOverloadWrapper(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isCallExpression(current)) {
      const callee = current.expression;
      if (ts.isIdentifier(callee) && OVERLOAD_WRAPPER_NAMES.has(callee.text)) {
        return true;
      }
      if (ts.isPropertyAccessExpression(callee) && OVERLOAD_WRAPPER_NAMES.has(callee.name.text)) {
        return true;
      }
    }
    current = current.parent;
  }
  return false;
}

function isInsideSameFunctionLoop(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionLike(current)) return false;
    if (
      ts.isForStatement(current)
      || ts.isForOfStatement(current)
      || ts.isForInStatement(current)
      || ts.isWhileStatement(current)
      || ts.isDoStatement(current)
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

const SINGLE_KEY_PK_COLUMNS = new Set(["id", "event_id", "update_id", "key"]);
const SELECT_STAR_PK_COLUMNS = new Set(["id", "event_id", "update_id", "snapshot_token", "key"]);

function extractWhereClause(sql: string): string | null {
  const whereMatch = /\bWHERE\b/i.exec(sql);
  if (!whereMatch) return null;
  const rest = sql.slice(whereMatch.index + whereMatch[0].length);
  const tailMatch = /\b(?:GROUP\s+BY|ORDER\s+BY|LIMIT|HAVING)\b/i.exec(rest);
  return tailMatch ? rest.slice(0, tailMatch.index) : rest;
}

function isSimpleParamToken(token: string): boolean {
  return token === "?" || /^\?\d+$/.test(token) || token === "__expr__" || /^x+$/i.test(token);
}

function parseEqualityTargetColumn(clause: string): string | null {
  const trimmed = clause.trim().replace(/;$/, "").trim();
  const eqIdx = trimmed.indexOf("=");
  if (eqIdx <= 0 || trimmed.indexOf("=", eqIdx + 1) !== -1) return null;
  const lhs = trimmed.slice(0, eqIdx).trim();
  const rhs = trimmed.slice(eqIdx + 1).trim();
  if (!/^[a-z0-9_.]+$/i.test(lhs) || !isSimpleParamToken(rhs)) return null;
  return lhs.split(".").pop()!.toLowerCase();
}

function checkSqlQueryRules(
  node: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateExpression,
  sql: string,
  sourceFile: ts.SourceFile,
  relativePath: string,
  root: string,
  lines: readonly string[],
  violations: SqlSafetyViolation[],
): void {
  const s = structuralSql(sql);
  if (!/\b(?:SELECT|DELETE|UPDATE|INSERT)\b/i.test(s)) return;
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const lineText = lines[line - 1]?.trim() ?? "";

  // G3-c: D1 5-term compound SELECT limit (SQLITE_MAX_COMPOUND_SELECT = 5 => >= 5 operators = >= 6 terms)
  if (/\bSELECT\b/i.test(s)) {
    const compoundOps = s.match(/\b(?:UNION|INTERSECT|EXCEPT)\b/gi);
    if (compoundOps && compoundOps.length >= 5) {
      violations.push({
        file: relativePath,
        line,
        text: `${lineText} (compound SELECT has ${compoundOps.length + 1} terms; Cloudflare D1 limit is 5)`,
        root,
        rule: "sql-compound-select-limit",
      });
    }
  }

  // G3-d: Heavy-table scans, unbounded deletes, unindexed clock COALESCE, and cache prefix LIKE
  if (isTestHelperFile(relativePath)
    || hasReviewedComment(node, sourceFile, ALLOW_D1_SCAN_PATTERN, MIN_ESCAPE_REASON_LEN)) {
    return;
  }

  const emittedScanReasons = new Set<string>();
  const pushScan = (reason: string): void => {
    if (emittedScanReasons.has(reason)) return;
    emittedScanReasons.add(reason);
    violations.push({
      file: relativePath,
      line,
      text: `${lineText} (${reason})`,
      root,
      rule: "d1-heavy-table-scan",
    });
  };

  // G3-d(1): Unbounded DELETE on heavy table
  for (const match of s.matchAll(/\bDELETE\s+FROM\s+([a-z_][a-z0-9_]*)\b/gi)) {
    const table = match[1]!.toLowerCase();
    if (!HEAVY_D1_TABLES.has(table)) continue;
    if (/\bLIMIT\b/i.test(s)) continue;
    const afterTable = s.slice(match.index + match[0].length);
    const deleteWhere = extractWhereClause(afterTable);
    const hasSingleKeyPkEq = deleteWhere !== null
      && !/\bOR\b/i.test(deleteWhere)
      && deleteWhere.split(/\bAND\b/i).some((part) => SINGLE_KEY_PK_COLUMNS.has(parseEqualityTargetColumn(part) ?? ""));
    const isEqualityOnlyWhere = /^\s*WHERE\b/i.test(afterTable)
      && deleteWhere !== null
      && parseEqualityTargetColumn(deleteWhere) !== null;
    if (!isEqualityOnlyWhere && !hasSingleKeyPkEq) {
      pushScan(`unbounded DELETE on heavy table ${table}`);
    }
  }

  // G3-d(2): Unbounded SELECT * on heavy table
  for (const match of s.matchAll(/\bSELECT\s+([a-z0-9_.*]+)\s+FROM\s+([a-z_][a-z0-9_]*)\b/gi)) {
    const projection = match[1]!;
    if (projection !== "*" && !projection.endsWith(".*")) continue;
    const table = match[2]!.toLowerCase();
    if (!HEAVY_D1_TABLES.has(table)) continue;
    if (/\bLIMIT\b/i.test(s)) continue;
    const selectWhere = extractWhereClause(s);
    if (selectWhere !== null) {
      const leadPred = /^\s*([a-z0-9_.]+)\s*(?:=|IN\s*\()/i.exec(selectWhere);
      if (leadPred && SELECT_STAR_PK_COLUMNS.has(leadPred[1]!.split(".").pop()!.toLowerCase())) continue;
    }
    pushScan(`unbounded SELECT * on heavy table ${table}`);
  }

  // G3-d(3): Unindexed WHERE COALESCE(clockCol, ...) range/equality on heavy table
  const heavyTablesInQuery: string[] = [];
  for (const match of s.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)\b/gi)) {
    const table = match[1]!.toLowerCase();
    if (HEAVY_D1_TABLES.has(table)) heavyTablesInQuery.push(table);
  }
  if (heavyTablesInQuery.length > 0 && /\bWHERE\b/i.test(s) && /\bCOALESCE\s*\(/i.test(s)) {
    const whereClause = extractWhereClause(s) ?? "";
    const strippedCoalesceWhere = whereClause.replace(/\bCOALESCE\s*\([^()]*\)/gi, " ");
    const rawBoundCols = new Set(
      [...strippedCoalesceWhere.matchAll(/([a-z_][a-z0-9_.]*)\s*(?:>=|>|<=|<|BETWEEN\b)/gi)]
        .map((bound) => bound[1]!.split(".").pop()!.toLowerCase()),
    );
    for (const coalesceMatch of whereClause.matchAll(/\bCOALESCE\s*\(([^()]+)\)\s*(?:>=|>|<=|<|=|BETWEEN\b)/gi)) {
      const argIdentifiers = [...coalesceMatch[1]!.matchAll(/[a-z_][a-z0-9_.]*/gi)]
        .map((arg) => arg[0].split(".").pop()!.toLowerCase())
        .filter((col) => INDEXED_CLOCK_COLUMNS.has(col));
      if (argIdentifiers.length === 0) continue;
      if (!argIdentifiers.some((col) => rawBoundCols.has(col))) {
        pushScan(`unindexed WHERE COALESCE(${argIdentifiers.join(", ")}) on heavy table ${heavyTablesInQuery[0]}`);
      }
    }
  }

  // G3-d(4): cache prefix LIKE defeats PK index seek
  if (/\bFROM\s+cache\b/i.test(s)) {
    const cacheWhere = extractWhereClause(s);
    if (cacheWhere && [...cacheWhere.matchAll(/([a-z_][a-z0-9_.]*)\s+LIKE\b/gi)]
      .some((m) => m[1]!.split(".").pop()!.toLowerCase() === "key")) {
      pushScan("cache WHERE key LIKE defeats PK index seek; use key >= ? AND key < ? or GLOB");
    }
  }
}

export function scanSqlSafetySource(
  file: string,
  source: string,
  options: { root?: string; orPredicateNames?: ReadonlySet<string>; cwd?: string } = {},
): SqlSafetyViolation[] {
  const relativePath = normalizeBaselineFilePath(file);
  const root = options.root ?? relativePath.split("/")[0] ?? "";
  const lines = source.split("\n");
  const violations: SqlSafetyViolation[] = [];

  const sourceFile = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true);
  const templates = new Map<number, ts.TemplateExpression>();

  const localOrConstants = new Set<string>(
    options.orPredicateNames ?? getDefaultOrPredicateConstants(options.cwd ?? process.cwd()),
  );
  collectOrPredicateConstantsFromAst(sourceFile, localOrConstants);

  const checkOverload = isFocusedD1OverloadFile(relativePath);
  const checkLoopWrite = isLoopWriteScopedFile(relativePath);
  const preparedVarsByScope = new WeakMap<ts.Node, Map<string, string | null>>();

  function enclosingFunctionScope(node: ts.Node): ts.Node {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (ts.isFunctionLike(current) || ts.isSourceFile(current)) return current;
      current = current.parent;
    }
    return sourceFile;
  }

  function recordPreparedVar(scope: ts.Node, name: string, sql: string | null): void {
    let map = preparedVarsByScope.get(scope);
    if (!map) {
      map = new Map();
      preparedVarsByScope.set(scope, map);
    }
    map.set(name, sql);
  }

  function lookupPreparedVar(node: ts.Node, name: string): { found: boolean; sql: string | null } {
    let current: ts.Node | undefined = node;
    while (current) {
      if (ts.isFunctionLike(current) || ts.isSourceFile(current)) {
        const map = preparedVarsByScope.get(current);
        if (map?.has(name)) {
          return { found: true, sql: map.get(name) ?? null };
        }
      }
      current = current.parent;
    }
    return { found: false, sql: null };
  }

  const visit = (node: ts.Node): void => {
    if (ts.isTemplateExpression(node)) {
      templates.set(node.getStart(sourceFile), node);
      const sql = extractSqlFromExpression(node);
      if (sql) {
        // G3-b: unparenthesized interpolated OR predicate adjacent to AND
        if (localOrConstants.size > 0 && /\b(?:SELECT|DELETE|UPDATE|INSERT|WHERE|AND)\b/i.test(sql)) {
          for (let i = 0; i < node.templateSpans.length; i++) {
            const span = node.templateSpans[i]!;
            if (!ts.isIdentifier(span.expression) || !localOrConstants.has(span.expression.text)) continue;
            const prevText = i === 0 ? node.head.text : node.templateSpans[i - 1]!.literal.text;
            const nextText = span.literal.text;
            const isParenthesized = /\(\s*$/.test(prevText) && /^\s*\)/.test(nextText);
            const adjacentToAnd = /\bAND\s*$/i.test(prevText) || /^\s*AND\b/i.test(nextText);
            if (!isParenthesized && adjacentToAnd) {
              const line = sourceFile.getLineAndCharacterOfPosition(span.expression.getStart(sourceFile)).line + 1;
              violations.push({
                file: relativePath,
                line,
                text: `${lines[line - 1]?.trim() ?? ""} (unparenthesized OR predicate \${${span.expression.text}} beside AND)`,
                root,
                rule: "sql-unparenthesized-or",
              });
            }
          }
        }
        checkSqlQueryRules(node, sql, sourceFile, relativePath, root, lines, violations);
      }
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      for (const mismatch of sqlArityMismatches(node.text)) {
        violations.push({
          file: relativePath,
          line,
          text: `${lines[line - 1]!.trim()} (${mismatch.columns} columns, ${mismatch.values} values)`,
          root,
          rule: "insert-arity",
        });
      }
      checkSqlQueryRules(node, node.text, sourceFile, relativePath, root, lines, violations);
    }

    if ((checkOverload || checkLoopWrite) && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const prepareCall = findPrepareCallInChain(node.initializer);
      if (prepareCall) {
        const sqlArg = prepareCall.arguments[0];
        const sql = sqlArg ? extractSqlFromExpression(sqlArg) : null;
        recordPreparedVar(enclosingFunctionScope(node), node.name.text, sql);
      }
    }

    if ((checkOverload || checkLoopWrite) && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const receiver = node.expression.expression;
      const isStmtMethod = method === "first" || method === "all" || method === "run";
      const isBatchCall = method === "batch" && isDbBatchReceiver(receiver);

      let prepareCall: ts.CallExpression | null = null;
      let preparedVarSql: string | null = null;
      let isPreparedVar = false;

      if (isStmtMethod) {
        prepareCall = findPrepareCallInChain(receiver);
        if (!prepareCall) {
          let baseExpr: ts.Expression = receiver;
          if (ts.isCallExpression(baseExpr) && ts.isPropertyAccessExpression(baseExpr.expression)
            && baseExpr.expression.name.text === "bind") {
            baseExpr = baseExpr.expression.expression;
          }
          if (ts.isIdentifier(baseExpr)) {
            const lookup = lookupPreparedVar(node, baseExpr.text);
            if (lookup.found) {
              isPreparedVar = true;
              preparedVarSql = lookup.sql;
            }
          }
        }
      }

      const isD1Exec = (isStmtMethod && (prepareCall !== null || isPreparedVar)) || isBatchCall;
      if (checkOverload && isD1Exec) {
        if (!isInsideOverloadWrapper(node)
          && !hasReviewedComment(node, sourceFile, ALLOW_D1_OVERLOAD_PATTERN, MIN_ESCAPE_REASON_LEN)) {
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
          violations.push({
            file: relativePath,
            line,
            text: `${lines[line - 1]?.trim() ?? ""} (unguarded D1 .${method}() in high-overload lane)`,
            root,
            rule: "d1-overload-unguarded",
          });
        }
      }

      if (checkLoopWrite && method === "run" && (prepareCall !== null || isPreparedVar)) {
        const sql = prepareCall
          ? (prepareCall.arguments[0] ? extractSqlFromExpression(prepareCall.arguments[0]) : null)
          : preparedVarSql;
        if (sql && /\b(?:INSERT|UPDATE|DELETE)\b/i.test(structuralSql(sql))
          && !/\bLIMIT\b/i.test(structuralSql(sql))
          && isInsideSameFunctionLoop(node)
          && !hasReviewedComment(node, sourceFile, ALLOW_D1_LOOP_WRITE_PATTERN, MIN_ESCAPE_REASON_LEN)) {
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
          violations.push({
            file: relativePath,
            line,
            text: `${lines[line - 1]?.trim() ?? ""} (unbatched D1 write .run() inside loop)`,
            root,
            rule: "d1-unbatched-loop-write",
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  // Existing SQL interpolation check
  if (source.search(SQL_INTERPOLATION_PATTERN) >= 0) {
    // Source is the module-constant SQL_INTERPOLATION_PATTERN; only the global flag is added.
    // eslint-disable-next-line security/detect-non-literal-regexp
    const pattern = new RegExp(
      SQL_INTERPOLATION_PATTERN.source,
      SQL_INTERPOLATION_PATTERN.flags.includes("g")
        ? SQL_INTERPOLATION_PATTERN.flags
        : `${SQL_INTERPOLATION_PATTERN.flags}g`,
    );
    for (const match of source.matchAll(pattern)) {
      const index = match.index;
      const lineIndex = source.slice(0, index).split("\n").length - 1;
      const template = templates.get(index);
      if (template && (hasSafetyReview(template, sourceFile) || hasGuardedInterpolation(template))) continue;

      violations.push({
        file: relativePath,
        line: lineIndex + 1,
        text: lines[lineIndex]!.trim(),
        root,
        rule: "interpolation",
      });
    }
  }

  return violations;
}

export function scanSqlInterpolationSafety(
  roots: readonly string[] = DEFAULT_SQL_SAFETY_ROOTS,
  cwd = process.cwd(),
  options: { applyBaseline?: boolean; checkRatchet?: boolean; baseRef?: string } = {},
): SqlSafetyReport {
  // Pass 1: collect depth-0 OR SQL constants across all scanned files
  const orPredicateNames = new Set<string>();
  const rawContents: Array<{ relativePath: string; content: string; root: string }> = [];
  const pass1 = scanSourceGate<never>({
    roots,
    cwd,
    extensions: SQL_SAFETY_EXTENSIONS,
    scanFile: ({ relativePath, content, root }) => {
      rawContents.push({ relativePath, content, root });
      if (/\bOR\b/i.test(content) && OR_CONSTANT_NAME_PATTERN.test(content)) {
        const ast = ts.createSourceFile(relativePath, content, ts.ScriptTarget.Latest, false);
        collectOrPredicateConstantsFromAst(ast, orPredicateNames);
      }
      return [];
    },
  });

  // Pass 2: scan every file with the collected OR constant table
  const rawViolations: SqlSafetyViolation[] = [];
  for (const { relativePath, content, root } of rawContents) {
    rawViolations.push(...scanSqlSafetySource(relativePath, content, { root, orPredicateNames, cwd }));
  }

  const useBaseline = options.applyBaseline ?? true;
  if (!useBaseline) {
    return { scannedFiles: pass1.scannedFiles, violations: rawViolations };
  }

  const isDefaultScan = roots.length === DEFAULT_SQL_SAFETY_ROOTS.length
    && DEFAULT_SQL_SAFETY_ROOTS.every((root, index) => roots[index] === root);
  const coveredRoots = roots.map((root) => {
    const normalized = normalizeBaselineFilePath(root);
    return normalized.startsWith("/") ? normalized : normalized;
  });
  const hasBaselineFile = existsSync(resolve(cwd, STATIC_GUARD_BASELINE_PATH));

  const { violations, stale } = applyGuardBaselineToViolations("g3-sql-d1-safety", rawViolations, {
    cwd,
    coveredRoots,
    checkStale: hasBaselineFile,
    required: isDefaultScan && hasBaselineFile,
  });

  const combined: SqlSafetyViolation[] = [
    ...violations,
    ...stale.map((item) => ({ ...item, root: item.file.split("/")[0] ?? "", rule: "stale-baseline" as const })),
  ];

  const shouldCheckRatchet = options.checkRatchet ?? (isDefaultScan && hasBaselineFile);
  if (shouldCheckRatchet) {
    const ratchetErrors = verifyStaticGuardBaselineRatchet({
      cwd,
      baseRef: options.baseRef,
      required: true,
    });
    for (const error of ratchetErrors) {
      combined.push({
        file: STATIC_GUARD_BASELINE_PATH,
        line: 1,
        text: error,
        root: ".ci",
        rule: "baseline-ratchet",
      });
    }
  }

  return { scannedFiles: pass1.scannedFiles, violations: combined };
}

export function printSqlInterpolationSafetyReport(report: SqlSafetyReport): number {
  return reportViolations({
    label: "SQL & D1 safety",
    heading: "SQL interpolation, INSERT arity, or D1 query/write-cost safety violations",
    violations: report.violations.map((violation) =>
      `${violation.file}:${violation.line}: ${violation.rule === "interpolation" ? "" : `[${violation.rule}] `}${violation.text}`),
    hint: "Fix: guard SQL interpolations with an allowlist or // SAFETY:, wrap D1 calls in high-overload lanes with runWithOverloadRetry/batchExecute, parenthesize OR predicates beside AND, keep compound SELECT <= 5 terms, bound heavy-table scans/deletes, batch loop writes, or annotate with // pharos-allow-d1-*: <reason> (>= 8 chars). Shrink .ci/static-guard-baselines.json when fixing baselined sites.",
    scannedCount: report.scannedFiles.length,
  });
}

export function parseSqlSafetyRoots(argv: readonly string[] = process.argv.slice(2)): string[] {
  const positionalRoots = argv.filter((arg) => !arg.startsWith("-"));
  return positionalRoots.length > 0 ? positionalRoots : DEFAULT_SQL_SAFETY_ROOTS;
}

export function main(argv: readonly string[] = process.argv.slice(2), cwd = process.cwd()): number {
  const report = scanSqlInterpolationSafety(parseSqlSafetyRoots(argv), cwd);
  return printSqlInterpolationSafetyReport(report);
}

runDirectCli(import.meta.url, () => {
  process.exitCode = main();
});
