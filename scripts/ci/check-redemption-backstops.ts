#!/usr/bin/env tsx

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  REDEMPTION_BACKSTOP_CONFIG_MANIFEST,
  REDEMPTION_BACKSTOP_CONFIGS,
} from "../../shared/lib/redemption-backstop-configs";
import {
  validateRedemptionBackstopRegistry,
  type RedemptionRegistryValidationResult,
} from "../../shared/lib/redemption-backstop-configs/validation";

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
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- CLI reads fixed repo paths and explicit report paths.
  return readFileSync(resolve(ROOT, path), "utf8");
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
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- user-supplied CLI report path.
  mkdirSync(dirname(resolved), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- user-supplied CLI report path.
  writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`);
}

const options = parseArgs(process.argv.slice(2));
const sourceTextByPath = new Map(
  REDEMPTION_BACKSTOP_CONFIG_MANIFEST.flatMap((entry) => {
    const sourceFilePaths = "sourceFilePaths" in entry ? entry.sourceFilePaths : [];
    return [entry.filePath, ...sourceFilePaths].map((filePath) => [filePath, readRepoFile(filePath)] as const);
  }),
);

const result = validateRedemptionBackstopRegistry({
  manifest: REDEMPTION_BACKSTOP_CONFIG_MANIFEST,
  mergedConfigs: REDEMPTION_BACKSTOP_CONFIGS,
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
