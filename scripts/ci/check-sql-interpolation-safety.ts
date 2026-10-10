#!/usr/bin/env node
import { reportViolations } from "../lib/report-violations.mts";
import { scanSourceGate } from "../lib/source-gate.mts";
import { runDirectCli } from "../lib/cli-args.mjs";
import ts from "typescript";

export const DEFAULT_SQL_SAFETY_ROOTS = ["worker/src", "worker/scripts", "scripts"];
export const SQL_INTERPOLATION_PATTERN = /`\s*(?:(?:SELECT|DELETE|UPDATE|INSERT)[^`]*(?:FROM|INTO|UPDATE|JOIN)\s+\$\{|(?:SELECT|DELETE|UPDATE)[^`]*(?:WHERE|AND|OR|SET)\s+[\w.]+\s*=\s*['"]?\$\{)/i;
export const SQL_SAFETY_PATTERN = /\/\/\s*SAFETY:/;
export const SQL_SAFETY_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);

interface SqlSafetyViolation {
  file: string;
  line: number;
  text: string;
  root: string;
}

interface SqlSafetyReport {
  scannedFiles: string[];
  violations: SqlSafetyViolation[];
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

export function scanSqlInterpolationSafety(
  roots: readonly string[] = DEFAULT_SQL_SAFETY_ROOTS,
  cwd = process.cwd(),
): SqlSafetyReport {
  return scanSourceGate<SqlSafetyViolation>({
    roots,
    cwd,
    extensions: SQL_SAFETY_EXTENSIONS,
    scanFile: ({ relativePath, content, root }) => {
      const violations: SqlSafetyViolation[] = [];
      const lines = content.split("\n");
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
        const context = lines.slice(Math.max(0, lineIndex - 5), lineIndex + 6).join("\n");
        const template = templates.get(index);
        if (SQL_SAFETY_PATTERN.test(context) || (template && hasGuardedInterpolation(template))) continue;

        violations.push({
          file: relativePath,
          line: lineIndex + 1,
          text: lines[lineIndex]!.trim(),
          root,
        });
      }
      return violations;
    },
  });
}

export function printSqlInterpolationSafetyReport(report: SqlSafetyReport): number {
  return reportViolations({
    label: "SQL interpolation safety",
    heading: "SQL interpolation sites missing allowlist validation or SAFETY comment",
    violations: report.violations.map((violation) => `${violation.file}:${violation.line}: ${violation.text}`),
    hint: "Fix: guard the interpolated expression with an immediately preceding allowlist rejection, or add a site-local // SAFETY: review.",
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
