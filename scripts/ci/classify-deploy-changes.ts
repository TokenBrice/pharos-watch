#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  hasDeployImpact,
  hasOnlyInternalDocsImpact,
  hasPagesDeployImpact,
  hasPagesPublishImpact,
  hasPagesUiImpact,
  hasWorkerDeployImpact,
  hasWorkerReleaseImpact,
  normalizeRepoPath,
} from "../lib/deploy-impact.mts";
import { collectGitPaths, splitNullDelimited } from "../lib/changed-files.mts";
import { CRITICAL_FILES } from "../lib/critical-coverage.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";
import { selectChangedGeneratedArtifactIds } from "./select-generated-artifacts.mts";

const ZERO_SHA: RegExp = /^0+$/;
const CRITICAL_COVERAGE_INFRA_PATHS = new Set([
  ".github/workflows/pull-request-checks.yml",
  "scripts/ci/check-critical-coverage.ts",
  "scripts/lib/critical-coverage.mjs",
  "scripts/lib/critical-test-files.mts",
  "scripts/maintenance/merge-critical-coverage.ts",
  "scripts/maintenance/run-critical-coverage-shard.ts",
  "scripts/maintenance/run-critical-coverage.ts",
  "vitest.config.ts",
]);

type GitExec = (
  file: string,
  args: readonly string[],
  options: { encoding: "utf8" },
) => string;

interface DeployClassification {
  changedFiles: string[];
  criticalCoverageChanged: boolean;
  deployRequired: boolean;
  docsChanged: boolean;
  docsOnly: boolean;
  pagesChanged: boolean;
  pagesDeployRequired: boolean;
  playwrightFirefoxRequired: boolean;
  reason: string;
  workerChanged: boolean;
  workerDeployRequired: boolean;
}

interface ClassifyDeployChangesOptions {
  baseSha?: string;
  eventName?: string;
  execFile?: GitExec;
  headSha?: string;
}

export {
  hasDeployImpact,
  hasOnlyInternalDocsImpact,
  hasPagesDeployImpact,
  hasPagesPublishImpact,
  hasPagesUiImpact,
  hasWorkerDeployImpact,
  hasWorkerReleaseImpact,
};

// Parses NUL-delimited `git diff -z` output; see splitNullDelimited for why the
// separator matters.
export function normalizeChangedFiles(rawOutput: string): string[] {
  return splitNullDelimited(rawOutput)
    .map((path) => normalizeRepoPath(path))
    .filter(Boolean);
}

export function classifyChangedFiles(
  changedFiles: readonly string[],
  { reason }: { reason?: string } = {},
): DeployClassification {
  const normalizedFiles = [...new Set(changedFiles.map((file) => normalizeRepoPath(file)))].sort();
  const pagesChanged = hasPagesDeployImpact(normalizedFiles);
  const pagesDeployRequired = hasPagesPublishImpact(normalizedFiles);
  const workerChanged = hasWorkerDeployImpact(normalizedFiles);
  const workerDeployRequired = hasWorkerReleaseImpact(normalizedFiles);
  const generatedArtifactIds = selectChangedGeneratedArtifactIds(normalizedFiles);
  return {
    changedFiles: normalizedFiles,
    criticalCoverageChanged: normalizedFiles.some(
      (file) => CRITICAL_FILES.includes(file) || CRITICAL_COVERAGE_INFRA_PATHS.has(file),
    ),
    deployRequired: hasDeployImpact(normalizedFiles),
    docsChanged: normalizedFiles.some((file) => hasOnlyInternalDocsImpact([file])),
    docsOnly: hasOnlyInternalDocsImpact(normalizedFiles),
    pagesChanged,
    pagesDeployRequired,
    playwrightFirefoxRequired: generatedArtifactIds.some(
      (id) => id === "og-editorial" || id === "og-case-studies",
    ),
    reason:
      reason ??
      (normalizedFiles.length > 0
        ? `Detected ${normalizedFiles.length} changed file(s)`
        : "No changed files detected"),
    workerChanged,
    workerDeployRequired,
  };
}

export function classifyDeployChanges({
  baseSha,
  eventName,
  execFile = execFileSync as GitExec,
  headSha,
}: ClassifyDeployChangesOptions = {}): DeployClassification {
  const fullDeploy = (reason: string): DeployClassification => ({
    changedFiles: [],
    criticalCoverageChanged: true,
    deployRequired: true,
    docsChanged: false,
    docsOnly: false,
    pagesChanged: true,
    pagesDeployRequired: true,
    playwrightFirefoxRequired: true,
    reason,
    workerChanged: true,
    workerDeployRequired: true,
  });
  if (eventName !== "push") {
    return fullDeploy(`Non-push event (${eventName ?? "unknown"}) runs the full deploy workflow`);
  }

  if (!baseSha || ZERO_SHA.test(baseSha) || !headSha) {
    return fullDeploy("Missing push diff base/head; falling back to full deploy path");
  }

  let changedFiles = [];
  try {
    changedFiles = collectGitPaths(
      { kind: "range", base: baseSha, head: headSha, noRenames: true },
      { execFile },
    );
  } catch {
    return fullDeploy(`Failed to diff ${baseSha}...${headSha}; falling back to full deploy path`);
  }

  return classifyChangedFiles(changedFiles, {
    reason:
      changedFiles.length > 0
        ? `Detected ${changedFiles.length} changed file(s) in push range`
        : "No changed files detected in push range",
  });
}

function writeGithubOutputLine(key: string, value: string): void {
  process.stdout.write(`${key}=${value}\n`);
}

export function emitGithubOutputs(classification: DeployClassification): void {
  writeGithubOutputLine("critical_coverage_changed", classification.criticalCoverageChanged ? "true" : "false");
  writeGithubOutputLine("deploy_required", classification.deployRequired ? "true" : "false");
  writeGithubOutputLine("docs_changed", classification.docsChanged ? "true" : "false");
  writeGithubOutputLine("docs_only", classification.docsOnly ? "true" : "false");
  writeGithubOutputLine("pages_changed", classification.pagesChanged ? "true" : "false");
  writeGithubOutputLine("pages_deploy_required", classification.pagesDeployRequired ? "true" : "false");
  writeGithubOutputLine(
    "playwright_firefox_required",
    classification.playwrightFirefoxRequired ? "true" : "false",
  );
  writeGithubOutputLine("worker_changed", classification.workerChanged ? "true" : "false");
  writeGithubOutputLine("worker_deploy_required", classification.workerDeployRequired ? "true" : "false");
}

export function runCli(env: NodeJS.ProcessEnv = process.env): void {
  const classification = classifyDeployChanges({
    baseSha: env.DEPLOY_BASE_SHA,
    eventName: env.DEPLOY_EVENT_NAME,
    headSha: env.DEPLOY_HEAD_SHA,
  });

  console.error(`[deploy-changes] ${classification.reason}`);
  if (classification.changedFiles.length > 0) {
    for (const file of classification.changedFiles) {
      console.error(`  - ${file}`);
    }
  }
  console.error(`[deploy-changes] critical_coverage_changed=${classification.criticalCoverageChanged}`);
  console.error(`[deploy-changes] pages_changed=${classification.pagesChanged}`);
  console.error(`[deploy-changes] pages_deploy_required=${classification.pagesDeployRequired}`);
  console.error(`[deploy-changes] playwright_firefox_required=${classification.playwrightFirefoxRequired}`);
  console.error(`[deploy-changes] worker_changed=${classification.workerChanged}`);
  console.error(`[deploy-changes] worker_deploy_required=${classification.workerDeployRequired}`);
  console.error(`[deploy-changes] deploy_required=${classification.deployRequired}`);
  console.error(`[deploy-changes] docs_changed=${classification.docsChanged}`);
  console.error(`[deploy-changes] docs_only=${classification.docsOnly}`);

  emitGithubOutputs(classification);
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  runCli();
}
