#!/usr/bin/env tsx

import { mkdirSync, readFileSync, readdirSync, writeFileSync, type Dirent } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import type { RedemptionBackstopConfigManifestEntry } from "@shared/lib/redemption-backstop-configs/manifest";
import type { RedemptionBackstopConfig } from "@shared/lib/redemption-backstop-configs/shared";
import type {
  RedemptionRegistryValidationOptions,
  RedemptionRegistryValidationResult,
} from "../lib/redemption-backstop-validation";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

interface CliOptions {
  json: boolean;
  reportPath: string | null;
}

export interface RedemptionBackstopCliDirectoryEntry {
  name: string;
  isFile: boolean;
}

export interface RedemptionBackstopCliDeps {
  cwd?: string;
  manifest?: readonly RedemptionBackstopConfigManifestEntry[];
  validate?: (options: RedemptionRegistryValidationOptions) => RedemptionRegistryValidationResult;
  mergedConfigs?: Record<string, RedemptionBackstopConfig>;
  docsText?: string;
  apiDocsText?: string;
  sourceTextByPath?: ReadonlyMap<string, string>;
  readRepoFile?: (path: string) => string;
  readRepoDirectory?: (path: string) => readonly RedemptionBackstopCliDirectoryEntry[];
  writeReport?: (path: string, value: unknown) => void;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

interface ResolvedCliDeps extends RedemptionBackstopCliDeps {
  cwd: string;
  manifest: readonly RedemptionBackstopConfigManifestEntry[];
  validate: (options: RedemptionRegistryValidationOptions) => RedemptionRegistryValidationResult;
  readRepoFile?: (path: string) => string;
  readRepoDirectory?: (path: string) => readonly RedemptionBackstopCliDirectoryEntry[];
  writeReport: (path: string, value: unknown) => void;
  out: (text: string) => void;
  err: (text: string) => void;
}

export interface RedemptionBackstopCliResult {
  status: 0 | 1;
  report: object | null;
  validation: RedemptionRegistryValidationResult | null;
  reportPath: string | null;
  stdout: string;
  stderr: string;
  output: string;
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

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveManifestSourceFilePaths(
  entry: RedemptionBackstopConfigManifestEntry,
  readRepoDirectory: (path: string) => readonly RedemptionBackstopCliDirectoryEntry[],
): readonly string[] {
  if (posix.basename(entry.filePath) !== "index.ts") {
    return [entry.filePath];
  }

  const dir = posix.dirname(entry.filePath);
  const siblingSourceFilePaths = readRepoDirectory(dir)
    .filter((dirent) => dirent.isFile && dirent.name.endsWith(".ts") && dirent.name !== "index.ts")
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

function buildSourceTextByPath(deps: ResolvedCliDeps): ReadonlyMap<string, string> | undefined {
  if (deps.sourceTextByPath) return deps.sourceTextByPath;
  if (!deps.readRepoFile || !deps.readRepoDirectory) return undefined;

  const sourceTextByPath = new Map(
    deps.manifest.flatMap((entry) => {
      return resolveManifestSourceFilePaths(entry, deps.readRepoDirectory!).map(
        (filePath) => [filePath, deps.readRepoFile!(filePath)] as const,
      );
    }),
  );
  return sourceTextByPath;
}

function execute(
  options: CliOptions,
  deps: ResolvedCliDeps,
): RedemptionBackstopCliResult {
  const validation = deps.validate({
    manifest: deps.manifest,
    mergedConfigs: deps.mergedConfigs,
    docsText: deps.docsText ?? deps.readRepoFile?.("docs/redemption-backstops.md"),
    apiDocsText: deps.apiDocsText ?? deps.readRepoFile?.("docs/api-reference.md"),
    sourceTextByPath: buildSourceTextByPath(deps),
  });
  const report = buildReport(validation);
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
  return {
    status,
    report,
    validation,
    reportPath: options.reportPath,
    stdout,
    stderr,
    output: `${stdout}${stderr}`,
  };
}

export function run(
  argv: readonly string[] = process.argv.slice(2),
  deps: RedemptionBackstopCliDeps = {},
): RedemptionBackstopCliResult {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error: unknown) {
    const stderr = `${readErrorMessage(error)}\n`;
    return {
      status: 1,
      report: null,
      validation: null,
      reportPath: null,
      stdout: "",
      stderr,
      output: stderr,
    };
  }

  if (!deps.manifest || !deps.validate) {
    throw new Error("Redemption backstop CLI dependencies are required when calling run().");
  }

  const resolved: ResolvedCliDeps = {
    ...deps,
    cwd: deps.cwd ?? process.cwd(),
    manifest: deps.manifest,
    validate: deps.validate,
    writeReport: () => undefined,
    out: () => undefined,
    err: () => undefined,
  };
  return execute(options, resolved);
}

// The registry and validator are intentionally loaded only after parseArgs in main;
// this keeps invalid CLI invocations import-safe and cheap.
async function resolveDeps(overrides: RedemptionBackstopCliDeps): Promise<ResolvedCliDeps> {
  const cwd = overrides.cwd ?? process.cwd();
  const manifest =
    overrides.manifest ??
    (await import("@shared/lib/redemption-backstop-configs/manifest")).REDEMPTION_BACKSTOP_CONFIG_MANIFEST;
  const validate =
    overrides.validate ??
    (await import("../lib/redemption-backstop-validation")).validateRedemptionBackstopRegistry;
  const readRepoFile =
    overrides.readRepoFile ?? ((path: string) => readFileSync(resolve(cwd, path), "utf8"));
  const readRepoDirectory =
    overrides.readRepoDirectory ??
    ((path: string) =>
      readdirSync(resolve(cwd, path), { withFileTypes: true }).map((dirent: Dirent) => ({
        name: dirent.name,
        isFile: dirent.isFile(),
      })));
  const writeReport =
    overrides.writeReport ??
    ((path: string, value: unknown) => {
      const resolvedPath = resolve(cwd, path);
      mkdirSync(dirname(resolvedPath), { recursive: true });
      writeFileSync(resolvedPath, `${JSON.stringify(value, null, 2)}\n`);
    });

  return {
    ...overrides,
    cwd,
    manifest,
    validate,
    readRepoFile,
    readRepoDirectory,
    writeReport,
    out: overrides.out ?? ((text: string) => process.stdout.write(text)),
    err: overrides.err ?? ((text: string) => process.stderr.write(text)),
  };
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  deps: RedemptionBackstopCliDeps = {},
): Promise<number> {
  // Parse before importing the manifest and validator. Invalid CLI arguments should
  // fail without loading the production registry.
  const options = parseArgs(argv);
  const resolved = await resolveDeps(deps);
  const result = execute(options, resolved);
  if (result.reportPath) {
    resolved.writeReport(result.reportPath, result.report);
  }
  if (result.stdout) resolved.out(result.stdout);
  if (result.stderr) resolved.err(result.stderr);
  return result.status;
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
