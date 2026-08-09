#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { reportViolations } from "../lib/report-violations.mjs";
import { collectSourceFiles, resolveSourceRoot, runAsCli } from "../lib/source-files.mjs";

export const DEFAULT_SQL_SAFETY_ROOTS = ["worker/src", "worker/scripts", "scripts"];
export const SQL_INTERPOLATION_PATTERN = /`\s*(?:(?:SELECT|DELETE|UPDATE|INSERT)[^`]*(?:FROM|INTO|UPDATE|JOIN)\s+\$\{|(?:SELECT|DELETE|UPDATE)[^`]*(?:WHERE|AND|OR|SET)\s+[\w.]+\s*=\s*['"]?\$\{)/i;
export const SQL_SAFETY_PATTERN = /(?:\/\/\s*SAFETY:|\.has\(|throw\s+new\s+Error)/;
export const SQL_SAFETY_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);

function hasSqlSafetySignal(context) {
  return SQL_SAFETY_PATTERN.test(context);
}

export function scanSqlInterpolationSafety(roots = DEFAULT_SQL_SAFETY_ROOTS, cwd = process.cwd()) {
  const scannedFiles = [];
  const violations = [];

  for (const root of roots) {
    const resolvedRoot = resolveSourceRoot(root, cwd);
    const files = collectSourceFiles(resolvedRoot, { extensions: SQL_SAFETY_EXTENSIONS });
    scannedFiles.push(...files);

    for (const file of files) {
      const content = readFileSync(file, "utf8");
      const lines = content.split("\n");
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (!SQL_INTERPOLATION_PATTERN.test(line)) continue;

        const context = lines.slice(Math.max(0, index - 5), index + 1).join("\n");
        if (hasSqlSafetySignal(context)) continue;

        violations.push({
          file: relative(cwd, file),
          line: index + 1,
          text: line.trim(),
          root,
        });
      }
    }
  }

  return { scannedFiles, violations };
}

export function printSqlInterpolationSafetyReport(report) {
  return reportViolations({
    label: "SQL interpolation safety",
    heading: "SQL interpolation sites missing allowlist validation or SAFETY comment",
    violations: report.violations.map((violation) => `${violation.file}:${violation.line}: ${violation.text}`),
    hint: "Fix: add allowlist Set + .has() validation, or a // SAFETY: comment.",
    scannedCount: report.scannedFiles.length,
  });
}

export function parseSqlSafetyRoots(argv = process.argv.slice(2)) {
  const positionalRoots = argv.filter((arg) => !arg.startsWith("-"));
  return positionalRoots.length > 0 ? positionalRoots : DEFAULT_SQL_SAFETY_ROOTS;
}

export function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  const report = scanSqlInterpolationSafety(parseSqlSafetyRoots(argv), cwd);
  return printSqlInterpolationSafetyReport(report);
}

runAsCli(import.meta.url, main);
