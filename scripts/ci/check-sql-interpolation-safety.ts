#!/usr/bin/env node
import { reportViolations } from "../lib/report-violations.mts";
import { scanSourceGate } from "../lib/source-gate.mts";
import { runDirectCli } from "../lib/cli-args.mjs";
import ts from "typescript";

export const DEFAULT_SQL_SAFETY_ROOTS = ["worker/src", "worker/scripts", "scripts"];
export const SQL_INTERPOLATION_PATTERN = /`\s*(?:(?:SELECT|DELETE|UPDATE|INSERT)[^`]*(?:FROM|INTO|UPDATE|JOIN)\s+\$\{|(?:SELECT|DELETE|UPDATE)[^`]*(?:WHERE|AND|OR|SET)\s+[\w.]+\s*=\s*['"]?\$\{)/i;
export const SQL_SAFETY_PATTERN = /\/\/\s*SAFETY:/;
export const SQL_SAFETY_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
// Necessary condition of INSERT_PATTERN on the cooked literal text. `\u`/`\x`
// escapes can spell any INSERT letter, so those files are parsed as well.
const INSERT_PREFILTER = /insert|\\[ux]/i;
const INSERT_PATTERN =
  /INSERT\s+(?:OR\s+(?:IGNORE|REPLACE|ABORT|FAIL|ROLLBACK)\s+|)INTO\s+[\w.]+\s*\(([^()]*)\)\s*VALUES\s*\(/gi;

interface SqlSafetyViolation {
  file: string;
  line: number;
  text: string;
  root: string;
  rule: "interpolation" | "insert-arity";
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

function hasSafetyReview(template: ts.TemplateExpression, sourceFile: ts.SourceFile): boolean {
  const hasReviewAt = (position: number): boolean => (
    ts.getLeadingCommentRanges(sourceFile.text, position) ?? []
  ).some((comment) => comment.kind === ts.SyntaxKind.SingleLineCommentTrivia
    && SQL_SAFETY_PATTERN.test(sourceFile.text.slice(comment.pos, comment.end)));
  let node: ts.Node = template;
  while (!ts.isBlock(node) && !ts.isSourceFile(node)) {
    if (hasReviewAt(node.getFullStart())) return true;
    // A review before `.prepare(...)` belongs to this call, not the receiver's statement.
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && hasReviewAt(node.expression.expression.end)) return true;
    if (ts.isStatement(node) || !node.parent) break;
    node = node.parent;
  }
  return false;
}

export function scanSqlInterpolationSafety(
  roots: readonly string[] = DEFAULT_SQL_SAFETY_ROOTS,
  cwd = process.cwd(),
): SqlSafetyReport {
  return scanSourceGate<SqlSafetyViolation>({
    roots,
    cwd,
    extensions: SQL_SAFETY_EXTENSIONS,
    scanFile: ({ relativePath, content, root }) => {
      const lines = content.split("\n");
      const violations: SqlSafetyViolation[] = [];
      if (content.search(INSERT_PREFILTER) >= 0) {
        for (const mismatch of findInsertArityMismatches(content, relativePath)) {
          violations.push({
            file: relativePath,
            line: mismatch.line,
            text: `${lines[mismatch.line - 1]!.trim()} (${mismatch.columns} columns, ${mismatch.values} values)`,
            root,
            rule: "insert-arity",
          });
        }
      }
      // The interpolation pattern is a necessary condition for a violation;
      // search() keeps a future global flag from carrying lastIndex state.
      if (content.search(SQL_INTERPOLATION_PATTERN) < 0) return violations;
      const sourceFile = ts.createSourceFile(relativePath, content, ts.ScriptTarget.Latest, true);
      const templates = new Map<number, ts.TemplateExpression>();
      const visit = (node: ts.Node): void => {
        if (ts.isTemplateExpression(node)) templates.set(node.getStart(sourceFile), node);
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
      // Source is the module-constant SQL_INTERPOLATION_PATTERN; only the global flag is added.
      // eslint-disable-next-line security/detect-non-literal-regexp
      const pattern = new RegExp(
        SQL_INTERPOLATION_PATTERN.source,
        SQL_INTERPOLATION_PATTERN.flags.includes("g")
          ? SQL_INTERPOLATION_PATTERN.flags
          : `${SQL_INTERPOLATION_PATTERN.flags}g`,
      );
      for (const match of content.matchAll(pattern)) {
        const index = match.index;
        const lineIndex = content.slice(0, index).split("\n").length - 1;
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
      return violations;
    },
  });
}

export function printSqlInterpolationSafetyReport(report: SqlSafetyReport): number {
  return reportViolations({
    label: "SQL interpolation safety",
    heading: "SQL interpolation sites missing allowlist validation or SAFETY comment, or INSERT arity mismatches",
    violations: report.violations.map((violation) =>
      `${violation.file}:${violation.line}: ${violation.rule === "insert-arity" ? "[insert-arity] " : ""}${violation.text}`),
    hint: "Fix: guard the interpolated expression with an immediately preceding allowlist rejection, or add a site-local // SAFETY: review. Static INSERT statements must bind exactly one value per named column.",
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
