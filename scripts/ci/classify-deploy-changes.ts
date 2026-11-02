#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  hasCriticalCssPipelineImpact,
  hasDeployImpact,
  hasOnlyInternalDocsImpact,
  hasPagesDeployImpact,
  hasPagesPublishImpact,
  hasWorkerDeployImpact,
  hasWorkerReleaseImpact,
  normalizeRepoPath,
} from "../lib/deploy-impact.mts";
import { collectGitPaths } from "../lib/changed-files.mts";
import { hasLaneInputImpact, hasPagesArtifactImpact } from "../lib/lane-input-closure.mts";
import { isDirectRun } from "../lib/smoke-runtime.mjs";
import { hasV9ContagionInput } from "../../worker/scripts/lib/v9-resource-policy.ts";
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
  pagesCriticalCssFullPass: boolean;
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
  hasCriticalCssPipelineImpact,
  hasDeployImpact,
  hasOnlyInternalDocsImpact,
  hasPagesDeployImpact,
  hasPagesPublishImpact,
  hasWorkerDeployImpact,
  hasWorkerReleaseImpact,
};

// The lane's inputs are the modules its setup, live and natural children
// actually bundle (fixture bootstrap, the measured probe and the harness that
// builds and drives them) plus the contagion sub-predicate it can switch on.
// Anything else — a Worker cron, a reserve adapter, an unrelated shared helper —
// cannot change the measured envelope, so the PR-only lane may skip it.
// Nightly remains unconditional, and unknown inputs fail closed below.
const V9_RESOURCE_CLOSURE_ROOTS = [
  "worker/scripts/measure-v9-resource.ts",
  "scripts/maintenance/run-v9-resource-lane.ts",
  "worker/src/lib/__tests__/safety-score-v9-resource-budget.test-support.ts",
  "worker/src/lib/__tests__/safety-score-v9-resource-budget.test.ts",
  "worker/src/lib/__tests__/safety-score-v9-resource-fixture.test-support.ts",
  "worker/src/lib/__tests__/safety-score-v9-resource-probe.test-support.ts",
] as const;
// Selection, transport, policy and calibration inputs that are not import edges
// of the harness. Changing any of them changes what or how the lane measures.
const V9_RESOURCE_PATHS = [
  ".ci/safety-score-v9-resource-budget.json",
  ".github/actions/setup-workspace/action.yml",
  ".github/workflows/pull-request-checks.yml",
  ".github/workflows/nightly-validation.yml",
  "scripts/ci/classify-deploy-changes.ts",
  "scripts/ci/select-generated-artifacts.mts",
  "scripts/lib/automation-registry.mjs",
  "scripts/lib/changed-files.mts",
  "scripts/lib/pr-lanes.mts",
  "scripts/lib/safety-score-v9-evaluation-inputs.mts",
  "scripts/maintenance/generate-pr-workflow-matrix.ts",
  "worker/scripts/calibrate-v9-resource.ts",
] as const;
// Read at runtime rather than imported: the migration set builds the fixture
// schema and the catalog JSON feeds the packed full-registry input.
const V9_RESOURCE_PREFIXES = ["shared/data/stablecoins/", "worker/migrations/"];
const KNOWN_NON_V9_PREFIXES = [
  ".ci/", ".github/", "agents/", "data/", "docs/", "functions/", "public/", "scripts/",
  "shared/", "src/", "tests/", "worker/",
];
const V9_RESOURCE_TOOLCHAIN_PATTERN =
  /(^|\/)(?:package(?:-lock)?\.json|tsconfig[^/]*\.json|vitest[^/]*|wrangler[^/]*|\.nvmrc|\.npmrc|\.node-version|\.tool-versions|mise\.toml|\.mise\.toml)$/;

export function hasV9ResourceImpact(
  files: readonly string[],
  generatedArtifactIds: readonly string[] = selectChangedGeneratedArtifactIds(files),
): boolean {
  // Catalog generators and their transitive inputs share the artifact registry;
  // the packed worker catalog is the probe's `#pharos-full-catalog` input.
  if (generatedArtifactIds.includes("safety-score-v9-evaluation-build")) return true;
  if (generatedArtifactIds.includes("stablecoin-worker-full-catalog")) return true;
  return hasLaneInputImpact(files, {
    id: "v9-resource-lane",
    roots: V9_RESOURCE_CLOSURE_ROOTS,
    exactPaths: V9_RESOURCE_PATHS,
    prefixes: V9_RESOURCE_PREFIXES,
    patterns: [V9_RESOURCE_TOOLCHAIN_PATTERN],
    matches: (file) => hasV9ContagionInput([file]),
    ignoredPrefixes: KNOWN_NON_V9_PREFIXES,
  });
}

export function classifyChangedFiles(
  changedFiles: readonly string[],
  { reason }: { reason?: string } = {},
): DeployClassification {
  const normalizedFiles = [...new Set(changedFiles.map((file) => normalizeRepoPath(file)))].sort();
  const pagesChanged = hasPagesDeployImpact(normalizedFiles);
  // Publishable Pages changes still drive the deploy; the PR artifact lane
  // builds only for the export's import closure or one of its declared inputs.
  const pagesDeployRequired = hasPagesPublishImpact(normalizedFiles);
  const pagesArtifactRequired = hasPagesArtifactImpact(normalizedFiles);
  const workerChanged = hasWorkerDeployImpact(normalizedFiles);
  const workerDeployRequired = hasWorkerReleaseImpact(normalizedFiles);
  const generatedArtifactIds = selectChangedGeneratedArtifactIds(normalizedFiles);
  return {
    changedFiles: normalizedFiles,
    deployRequired: hasDeployImpact(normalizedFiles),
    docsChanged: normalizedFiles.some((file) => hasOnlyInternalDocsImpact([file])),
    docsOnly: hasOnlyInternalDocsImpact(normalizedFiles),
    pagesArtifactRequired,
    pagesChanged,
    pagesCriticalCssFullPass: hasCriticalCssPipelineImpact(normalizedFiles),
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
    pagesCriticalCssFullPass: true,
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
  writeGithubOutputLine("docs_only", classification.docsOnly ? "true" : "false");
  writeGithubOutputLine("pages_artifact_required", classification.pagesArtifactRequired ? "true" : "false");
  writeGithubOutputLine("pages_critical_css_full_pass", classification.pagesCriticalCssFullPass ? "true" : "false");
  writeGithubOutputLine("pages_deploy_required", classification.pagesDeployRequired ? "true" : "false");
  writeGithubOutputLine(
    "playwright_firefox_required",
    classification.playwrightFirefoxRequired ? "true" : "false",
  );
  writeGithubOutputLine("v9_resource_required", classification.v9ResourceRequired ? "true" : "false");
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
  console.error(`[deploy-changes] pages_artifact_required=${classification.pagesArtifactRequired}`);
  console.error(`[deploy-changes] pages_critical_css_full_pass=${classification.pagesCriticalCssFullPass}`);
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
