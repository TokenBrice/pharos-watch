#!/usr/bin/env tsx

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import {
  REDEMPTION_BACKSTOP_CONFIG_MANIFEST,
  type RedemptionBackstopConfigManifestEntry,
} from "../../shared/lib/redemption-backstop-configs/manifest";
import {
  validateRedemptionBackstopRegistry,
  type RedemptionRegistryValidationResult,
} from "../lib/redemption-backstop-validation";

const ROOT = process.cwd();

interface CliOptions {
  json: boolean;
  reportPath: string | null;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { json: false, reportPath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--report") {
      const reportPath = argv[index + 1];
      if (!reportPath) {
        throw new Error("--report requires a path");
      }
      options.reportPath = reportPath;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function readRepoFile(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

function resolveManifestSourceFilePaths(entry: RedemptionBackstopConfigManifestEntry): readonly string[] {
  if (posix.basename(entry.filePath) !== "index.ts") {
    return [entry.filePath];
  }

  const dir = posix.dirname(entry.filePath);
  const siblingSourceFilePaths = readdirSync(resolve(ROOT, dir), { withFileTypes: true })
    .filter((dirent) => dirent.isFile() && dirent.name.endsWith(".ts") && dirent.name !== "index.ts")
    .map((dirent) => `${dir}/${dirent.name}`)
    .sort();

  return [entry.filePath, ...siblingSourceFilePaths];
}

function buildReport(result: RedemptionRegistryValidationResult): object {
  return {
    summary: result.summary,
    findings: result.findings,
    auditRows: result.auditRows,
    policyRows: result.policyRows,
  };
}

function writeJson(path: string, value: unknown): void {
  const resolved = resolve(ROOT, path);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`);
}

const options = parseArgs(process.argv.slice(2));
const sourceTextByPath = new Map(
  REDEMPTION_BACKSTOP_CONFIG_MANIFEST.flatMap((entry) => {
    return resolveManifestSourceFilePaths(entry).map((filePath) => [filePath, readRepoFile(filePath)] as const);
  }),
);

const result = validateRedemptionBackstopRegistry({
  manifest: REDEMPTION_BACKSTOP_CONFIG_MANIFEST,
  docsText: readRepoFile("docs/redemption-backstops.md"),
  apiDocsText: readRepoFile("docs/api-reference.md"),
  sourceTextByPath,
});

const report = buildReport(result);
if (options.reportPath) {
  writeJson(options.reportPath, report);
}

if (options.json) {
  console.log(JSON.stringify(report, null, 2));
}

const errors = result.findings.filter((finding) => finding.severity === "error");
if (errors.length > 0) {
  if (!options.json) {
    console.error("Redemption backstop registry checks failed:");
    for (const error of errors) {
      console.error(`  ${error.message}`);
    }
  }
  process.exit(1);
}

if (!options.json) {
  const routeFamilyCounts = Object.entries(result.summary.routeFamilyCounts)
    .map(([routeFamily, count]) => `${routeFamily}=${count}`)
    .join(", ");
  const warningSuffix = result.findings.some((finding) => finding.severity === "warning")
    ? `; ${result.findings.filter((finding) => finding.severity === "warning").length} warnings`
    : "";
  console.log(
    `Redemption backstop checks passed (${result.summary.configuredCount} configs; ${routeFamilyCounts}${warningSuffix}).`,
  );
}
