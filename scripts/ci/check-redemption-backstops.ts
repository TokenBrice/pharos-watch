#!/usr/bin/env tsx

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import type { RedemptionBackstopConfigManifestEntry } from "@shared/lib/redemption-backstop-configs/manifest";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

interface CliOptions {
  json: boolean;
  reportPath: string | null;
}

export function parseArgs(argv: readonly string[]): CliOptions {
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

function resolveManifestSourceFilePaths(
  entry: RedemptionBackstopConfigManifestEntry,
  cwd: string,
): readonly string[] {
  if (posix.basename(entry.filePath) !== "index.ts") {
    return [entry.filePath];
  }

  const dir = posix.dirname(entry.filePath);
  const siblingSourceFilePaths = readdirSync(resolve(cwd, dir), { withFileTypes: true })
    .filter((dirent) => dirent.isFile() && dirent.name.endsWith(".ts") && dirent.name !== "index.ts")
    .map((dirent) => `${dir}/${dirent.name}`)
    .sort();

  return [entry.filePath, ...siblingSourceFilePaths];
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  // Parse before importing the manifest and validator. Invalid CLI arguments should
  // fail without loading the production registry.
  const options = parseArgs(argv);
  const manifest =
    (await import("@shared/lib/redemption-backstop-configs/manifest")).REDEMPTION_BACKSTOP_CONFIG_MANIFEST;
  const { validateRedemptionBackstopRegistry } = await import("../lib/redemption-backstop-validation");
  const cwd = process.cwd();
  const readRepoFile = (path: string) => readFileSync(resolve(cwd, path), "utf8");
  const validation = validateRedemptionBackstopRegistry({
    manifest,
    docsText: readRepoFile("docs/redemption-backstops.md"),
    apiDocsText: readRepoFile("docs/api-reference.md"),
    sourceTextByPath: new Map(
      manifest.flatMap((entry) =>
        resolveManifestSourceFilePaths(entry, cwd).map(
          (filePath) => [filePath, readRepoFile(filePath)] as const,
        ),
      ),
    ),
  });
  const report = {
    summary: validation.summary,
    findings: validation.findings,
    auditRows: validation.auditRows,
    policyRows: validation.policyRows,
  };
  let stdout = "";
  let stderr = "";

  if (options.json) {
    stdout += `${JSON.stringify(report, null, 2)}\n`;
  }

  const errors = validation.findings.filter((finding) => finding.severity === "error");
  if (errors.length > 0) {
    if (!options.json) {
      stderr += "Redemption backstop registry checks failed:\n";
      for (const error of errors) {
        stderr += `  ${error.message}\n`;
      }
    }
  } else if (!options.json) {
    const routeFamilyCounts = Object.entries(validation.summary.routeFamilyCounts)
      .map(([routeFamily, count]) => `${routeFamily}=${count}`)
      .join(", ");
    const warningSuffix = validation.findings.some((finding) => finding.severity === "warning")
      ? `; ${validation.findings.filter((finding) => finding.severity === "warning").length} warnings`
      : "";
    stdout +=
      `Redemption backstop checks passed (${validation.summary.configuredCount} configs; ${routeFamilyCounts}${warningSuffix}).\n`;
  }

  const status: 0 | 1 = errors.length > 0 ? 1 : 0;
  if (options.reportPath) {
    const reportPath = resolve(cwd, options.reportPath);
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  return status;
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  main()
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
