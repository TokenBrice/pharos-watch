#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { collectSourceFiles, formatScannedOk, resolveSourceRoot, runAsCli } from "../lib/source-files.mjs";

export const DEFAULT_SUPPLY_HELPER_ROOTS = ["src/app", "src/components", "worker/src/api"];

export const SUPPLY_HELPER_WAIVERS = [
  {
    file: "worker/src/api/backfill-depegs-extraction.ts",
    reason: "Parses raw DefiLlama token-history bucket rows, not cached StablecoinData objects.",
  },
  {
    file: "worker/src/api/stablecoin-detail/cache-fallback.ts",
    reason: "Sums a raw caller-provided fallback bucket map before StablecoinData exists.",
  },
  {
    file: "worker/src/api/backfill-supply-history.ts",
    reason: "Normalizes raw DefiLlama detail/history bucket maps into supply-history rows.",
  },
];

const SUPPLY_IMPORT_RE = /import\s+\{[^}]*\bsumPegBuckets\b[^}]*\}\s+from\s+["']@shared\/lib\/supply["']/s;
const SUPPLY_EXTENSIONS = new Set([".ts", ".tsx"]);

export function scanSupplyHelperUsage({
  roots = DEFAULT_SUPPLY_HELPER_ROOTS,
  waivers = SUPPLY_HELPER_WAIVERS,
  cwd = process.cwd(),
} = {}) {
  const waiverFiles = new Set(waivers.map((waiver) => waiver.file));
  const scannedFiles = [];
  const violations = [];

  for (const root of roots) {
    const resolvedRoot = resolveSourceRoot(root, cwd);
    const files = collectSourceFiles(resolvedRoot, { extensions: SUPPLY_EXTENSIONS });
    scannedFiles.push(...files);

    for (const file of files) {
      const relativeFile = relative(cwd, file);
      if (waiverFiles.has(relativeFile)) continue;

      const content = readFileSync(file, "utf8");
      if (!SUPPLY_IMPORT_RE.test(content)) continue;

      violations.push({
        file: relativeFile,
        reason: "Route/component StablecoinData current supply should use getCirculatingRaw().",
      });
    }
  }

  return { scannedFiles, violations };
}

export function printSupplyHelperUsageReport(report) {
  if (report.violations.length > 0) {
    process.stderr.write("Canonical supply helper violations:\n\n");
    for (const violation of report.violations) {
      process.stderr.write(`  ${violation.file}: ${violation.reason}\n`);
    }
    process.stderr.write("\nUse getCirculatingRaw() for cached StablecoinData supply reads.\n");
    return 1;
  }

  process.stdout.write(formatScannedOk("Supply helper usage", report.scannedFiles.length));
  return 0;
}

export function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  const roots = argv.filter((arg) => !arg.startsWith("-"));
  const report = scanSupplyHelperUsage({ roots: roots.length > 0 ? roots : DEFAULT_SUPPLY_HELPER_ROOTS, cwd });
  return printSupplyHelperUsageReport(report);
}

runAsCli(import.meta.url, main);
