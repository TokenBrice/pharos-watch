#!/usr/bin/env node
import { reportViolations } from "../lib/report-violations.mts";
import { scanSourceGate } from "../lib/source-gate.mts";
import { runDirectCli } from "../lib/cli-args.mjs";

export const DEFAULT_SQL_SAFETY_ROOTS = ["worker/src", "worker/scripts", "scripts"];
export const SQL_INTERPOLATION_PATTERN = /`\s*(?:(?:SELECT|DELETE|UPDATE|INSERT)[^`]*(?:FROM|INTO|UPDATE|JOIN)\s+\$\{|(?:SELECT|DELETE|UPDATE)[^`]*(?:WHERE|AND|OR|SET)\s+[\w.]+\s*=\s*['"]?\$\{)/i;
export const SQL_SAFETY_PATTERN = /(?:\/\/\s*SAFETY:|\.has\(|throw\s+new\s+Error)/;
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

function hasSqlSafetySignal(context: string): boolean {
  return SQL_SAFETY_PATTERN.test(context);
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
        if (hasSqlSafetySignal(context)) continue;

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
    hint: "Fix: add allowlist Set + .has() validation, or a // SAFETY: comment.",
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
