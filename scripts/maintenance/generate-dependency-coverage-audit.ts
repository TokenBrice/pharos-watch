#!/usr/bin/env tsx

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  loadCoverageAuditSiteDataInputs,
  parseCoverageAuditCliArgs,
  readJsonFile,
  readRequiredJsonFile,
  resolveGeneratedAt,
  runCoverageAuditCli,
} from "../lib/coverage-audit-cli";
import { runDirectCli } from "../lib/cli-args.mjs";
import {
  buildDependencyCoverageAudit,
  readDependencyCheckoutRevision,
  renderDependencyCoverageAuditMarkdown,
  type DependencyCoverageAuditInput,
} from "../lib/dependency-coverage-audit";

interface CliOptions {
  apiBase: string | null;
  prod: boolean;
  inputDir: string | null;
  reportCardsPath: string | null;
  stablecoinsPath: string | null;
  format: "markdown" | "json";
  reportPath: string | null;
  generatedAt: string | null;
}

export function parseArgs(argv: string[]): CliOptions {
  return parseCoverageAuditCliArgs(argv, {
    createOptions: (): CliOptions => ({
      apiBase: null,
      prod: false,
      inputDir: null,
      reportCardsPath: null,
      stablecoinsPath: null,
      format: "markdown",
      reportPath: null,
      generatedAt: null,
    }),
    includeGeneratedAt: true,
    generatedAtMissingMessage: "--generated-at requires an ISO timestamp or 'now'",
    options: [
      { flag: "--prod", kind: "boolean", apply: (options) => { options.prod = true; } },
      { flag: "--api-base", kind: "value", missingMessage: "--api-base requires a URL", apply: (options, value) => { options.apiBase = value!; } },
      { flag: "--input", kind: "value", missingMessage: "--input requires a directory path", apply: (options, value) => { options.inputDir = value!; } },
      { flag: "--report-cards", kind: "value", missingMessage: "--report-cards requires a file path", apply: (options, value) => { options.reportCardsPath = value!; } },
      { flag: "--stablecoins", kind: "value", missingMessage: "--stablecoins requires a file path", apply: (options, value) => { options.stablecoinsPath = value!; } },
    ],
    validate: (options) => {
      if (options.prod && options.apiBase) throw new Error("Choose only one of --prod or --api-base.");
    },
  });
}

async function loadOptionalInputs(
  options: CliOptions,
  cwd: string,
  fetchImpl: typeof fetch,
): Promise<Pick<DependencyCoverageAuditInput, "reportCards" | "stablecoins" | "mode">> {
  const fetchedInputs = await loadCoverageAuditSiteDataInputs(
    { prod: options.prod, apiBase: options.apiBase, apiKeyEnv: "DEPENDENCY_COVERAGE_API_KEY" },
    fetchImpl,
  );
  if (fetchedInputs) return fetchedInputs;

  const inputDir = options.inputDir ? resolve(cwd, options.inputDir) : null;
  if (inputDir && !existsSync(inputDir)) {
    throw new Error(`--input directory not found: ${inputDir}`);
  }
  const reportCardsPath = options.reportCardsPath
    ? resolve(cwd, options.reportCardsPath)
    : inputDir
      ? resolve(inputDir, "report-cards.json")
      : null;
  const stablecoinsPath = options.stablecoinsPath
    ? resolve(cwd, options.stablecoinsPath)
    : inputDir
      ? resolve(inputDir, "stablecoins.json")
      : null;
  const reportCards = options.reportCardsPath
    ? readRequiredJsonFile(reportCardsPath!, "--report-cards")
    : reportCardsPath && existsSync(reportCardsPath)
      ? readJsonFile(reportCardsPath)
      : undefined;
  const stablecoins = options.stablecoinsPath
    ? readRequiredJsonFile(stablecoinsPath!, "--stablecoins")
    : stablecoinsPath && existsSync(stablecoinsPath)
      ? readJsonFile(stablecoinsPath)
      : undefined;

  if (inputDir && reportCards === undefined && stablecoins === undefined) {
    throw new Error(`--input directory contains neither report-cards.json nor stablecoins.json: ${inputDir}`);
  }

  return {
    reportCards,
    stablecoins,
    mode: reportCards !== undefined || stablecoins !== undefined ? "input" : "static",
  };
}

export async function runCli(
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  return runCoverageAuditCli(argv, {
    parse: parseArgs,
    cwd,
    build: async (options) => {
      const loaded = await loadOptionalInputs(options, cwd, fetchImpl);
      return buildDependencyCoverageAudit({
        ...loaded, generatedAt: resolveGeneratedAt(options), checkoutRevision: readDependencyCheckoutRevision(cwd),
      });
    },
    renderMarkdown: renderDependencyCoverageAuditMarkdown,
    writeMessage: (target) => `Wrote dependency coverage audit to ${target}`,
  });
}

runDirectCli(import.meta.url, async () => {
  process.exitCode = await runCli();
});
