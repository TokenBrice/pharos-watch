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
import { isDirectRun } from "../lib/smoke-runtime.mjs";
import { selectChangedGeneratedArtifactIds } from "./select-generated-artifacts.mts";
import { GENERATED_ARTIFACT_REGISTRY } from "../lib/automation-registry.mjs";

const ZERO_SHA: RegExp = /^0+$/;

type GitExec = (file: string, args: readonly string[], options: { encoding: "utf8" }) => string;

export interface DeployClassification {
  changedFiles: string[];
  deployRequired: boolean;
  docsChanged: boolean;
  docsOnly: boolean;
  pagesArtifactRequired: boolean;
  pagesChanged: boolean;
  pagesDeployRequired: boolean;
  playwrightFirefoxRequired: boolean;
  reason: string;
  v9ResourceRequired: boolean;
  workerChanged: boolean;
  /** One selected Worker release always deploys the public/heavy pair. */
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

// The artifact registry owns evaluator/catalog generation dependencies. The
// resource probe also reaches capture, publication, DB and setup-only helpers
// outside V9-named modules. Conservatively cover shared/Worker library and data
// families rather than duplicate hundreds of transitive import paths here.
// Frontend, API and unrelated cron edits can still skip the PR-only lane;
// nightly remains unconditional, and unknown inputs fail closed below.
const V9_RESOURCE_PATHS: Record<string, true> = {
  ".ci/safety-score-v9-resource-budget.json": true,
  ".github/actions/setup-workspace/action.yml": true,
  ".github/workflows/pull-request-checks.yml": true,
  ".github/workflows/nightly-validation.yml": true,
  "scripts/ci/classify-deploy-changes.ts": true,
  "scripts/lib/automation-registry.mjs": true,
  "scripts/lib/cli-args.mjs": true,
  "scripts/lib/command-runner.mts": true,
  "scripts/lib/smoke-runtime.mjs": true,
  "scripts/lib/wrangler-toml.mjs": true,
  "scripts/lib/pr-lanes.mts": true,
  "scripts/lib/safety-score-v9-evaluation-inputs.mts": true,
  "scripts/maintenance/generate-pr-workflow-matrix.ts": true,
  "scripts/maintenance/run-v9-resource-lane.ts": true,
  "worker/scripts/measure-v9-resource.ts": true,
  "worker/scripts/calibrate-v9-resource.ts": true,
};
const V9_RESOURCE_PREFIXES = [
  "shared/lib/",
  "shared/data/",
  "shared/types/",
  "shared/test-utils/",
  "worker/src/lib/",
  "worker/src/cron/compute-safety-score-v9",
  "worker/src/cron/reserve-adapters/",
  "worker/src/cron/dex-liquidity/",
  "worker/src/cron/dex-discovery/",
  "worker/src/cron/sync-live-reserves-config",
  "worker/src/cron/sync-live-reserves-shared",
  "worker/src/cron/shared/cursor-rotation",
  "worker/src/cron/sync-stablecoins/shared",
  "worker/src/cron/sync-stablecoins/enrich-prices-shared",
  "worker/src/test-helpers/",
  "worker/migrations/",
  "worker/scripts/lib/v9-resource",
];
const KNOWN_NON_V9_PREFIXES = [
  ".github/", ".ci/", "docs/", "src/", "public/", "functions/",
  "tests/", "scripts/", "shared/", "worker/", "data/",
];

export function hasV9ResourceImpact(
  files: readonly string[],
  generatedArtifactIds: readonly string[] = selectChangedGeneratedArtifactIds(files),
): boolean {
  // Catalog generators and their transitive inputs share the artifact registry.
  if (generatedArtifactIds.includes("safety-score-v9-evaluation-build")) return true;
  // An empty or malformed diff cannot establish that resource inputs are absent.
  if (files.length === 0) return true;
  return files.some((rawFile) => {
    const file = normalizeRepoPath(rawFile);
    if (!file || file.startsWith("/") || file.split("/").some((part) => part === "." || part === ".." || part === "")) return true;
    if (V9_RESOURCE_PATHS[file] === true || V9_RESOURCE_PREFIXES.some((prefix) => file.startsWith(prefix))) return true;
    if (/(^|\/)(?:package(?:-lock)?\.json|tsconfig[^/]*\.json|vitest[^/]*|wrangler[^/]*|\.nvmrc|\.npmrc|\.node-version|\.tool-versions|mise\.toml|\.mise\.toml)$/.test(file)) return true;
    if (!file.includes("/") && file.endsWith(".md")) return false;
    // A new/unrecognized top-level input is not evidence of a safe skip.
    return !KNOWN_NON_V9_PREFIXES.some((prefix) => file.startsWith(prefix));
  });
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
    deployRequired: hasDeployImpact(normalizedFiles),
    docsChanged: normalizedFiles.some((file) => hasOnlyInternalDocsImpact([file])),
    docsOnly: hasOnlyInternalDocsImpact(normalizedFiles),
    pagesArtifactRequired: pagesChanged,
    pagesChanged,
    pagesDeployRequired,
    playwrightFirefoxRequired: GENERATED_ARTIFACT_REGISTRY.some(
      (artifact) => generatedArtifactIds.includes(artifact.id) && artifact.requiredBrowsers?.includes("firefox"),
    ),
    v9ResourceRequired: hasV9ResourceImpact(normalizedFiles, generatedArtifactIds),
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
    deployRequired: true,
    docsChanged: false,
    docsOnly: false,
    pagesArtifactRequired: true,
    pagesChanged: true,
    pagesDeployRequired: true,
    playwrightFirefoxRequired: true,
    reason,
    v9ResourceRequired: true,
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
      { execFile: (file, args, options) => execFile(file, args, options).toString() },
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
  writeGithubOutputLine("deploy_required", classification.deployRequired ? "true" : "false");
  writeGithubOutputLine("docs_changed", classification.docsChanged ? "true" : "false");
  writeGithubOutputLine("docs_only", classification.docsOnly ? "true" : "false");
  writeGithubOutputLine("pages_artifact_required", classification.pagesArtifactRequired ? "true" : "false");
  writeGithubOutputLine("pages_changed", classification.pagesChanged ? "true" : "false");
  writeGithubOutputLine("pages_deploy_required", classification.pagesDeployRequired ? "true" : "false");
  writeGithubOutputLine(
    "playwright_firefox_required",
    classification.playwrightFirefoxRequired ? "true" : "false",
  );
  writeGithubOutputLine("v9_resource_required", classification.v9ResourceRequired ? "true" : "false");
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
  console.error(`[deploy-changes] pages_changed=${classification.pagesChanged}`);
  console.error(`[deploy-changes] pages_deploy_required=${classification.pagesDeployRequired}`);
  console.error(`[deploy-changes] playwright_firefox_required=${classification.playwrightFirefoxRequired}`);
  console.error(`[deploy-changes] worker_changed=${classification.workerChanged}`);
  console.error(`[deploy-changes] worker_deploy_required=${classification.workerDeployRequired}`);
  console.error(`[deploy-changes] deploy_required=${classification.deployRequired}`);
  console.error(`[deploy-changes] docs_changed=${classification.docsChanged}`);
  console.error(`[deploy-changes] docs_only=${classification.docsOnly}`);
  console.error(`[deploy-changes] v9_resource_required=${classification.v9ResourceRequired}`);

  emitGithubOutputs(classification);
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  runCli();
}
