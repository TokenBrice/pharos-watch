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
} from "../lib/deploy-impact.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const ZERO_SHA = /^0+$/;

export {
  hasDeployImpact,
  hasOnlyInternalDocsImpact,
  hasPagesDeployImpact,
  hasPagesPublishImpact,
  hasPagesUiImpact,
  hasWorkerDeployImpact,
  hasWorkerReleaseImpact,
};

export function normalizeChangedFiles(rawOutput) {
  return rawOutput
    .split(/\r?\n/g)
    .map((line) => normalizeRepoPath(line.trim()))
    .filter(Boolean);
}

/**
 * @param {{
 *   baseSha?: string,
 *   eventName?: string,
 *   execFile?: (file: string, args: readonly string[], options: { encoding: "utf8" }) => string,
 *   headSha?: string,
 * }} [options]
 */
export function classifyDeployChanges({ baseSha, eventName, execFile = execFileSync, headSha } = {}) {
  if (eventName !== "push") {
    return {
      changedFiles: [],
      deployRequired: true,
      docsOnly: false,
      pagesChanged: true,
      pagesDeployRequired: true,
      reason: `Non-push event (${eventName ?? "unknown"}) runs the full deploy workflow`,
      workerChanged: true,
      workerDeployRequired: true,
    };
  }

  if (!baseSha || ZERO_SHA.test(baseSha) || !headSha) {
    return {
      changedFiles: [],
      deployRequired: true,
      docsOnly: false,
      pagesChanged: true,
      pagesDeployRequired: true,
      reason: "Missing push diff base/head; falling back to full deploy path",
      workerChanged: true,
      workerDeployRequired: true,
    };
  }

  let changedFiles = [];
  try {
    const raw = execFile("git", ["diff", "--name-only", "--no-renames", `${baseSha}...${headSha}`], {
      encoding: "utf8",
    });
    changedFiles = normalizeChangedFiles(raw);
  } catch {
    return {
      changedFiles: [],
      deployRequired: true,
      docsOnly: false,
      pagesChanged: true,
      pagesDeployRequired: true,
      reason: `Failed to diff ${baseSha}...${headSha}; falling back to full deploy path`,
      workerChanged: true,
      workerDeployRequired: true,
    };
  }

  const pagesChanged = hasPagesDeployImpact(changedFiles);
  const pagesDeployRequired = hasPagesPublishImpact(changedFiles);
  const workerChanged = hasWorkerDeployImpact(changedFiles);
  const workerDeployRequired = hasWorkerReleaseImpact(changedFiles);
  return {
    changedFiles,
    deployRequired: hasDeployImpact(changedFiles),
    docsOnly: hasOnlyInternalDocsImpact(changedFiles),
    pagesChanged,
    pagesDeployRequired,
    reason:
      changedFiles.length > 0
        ? `Detected ${changedFiles.length} changed file(s) in push range`
        : "No changed files detected in push range",
    workerChanged,
    workerDeployRequired,
  };
}

function writeGithubOutputLine(key, value) {
  process.stdout.write(`${key}=${value}\n`);
}

export function emitGithubOutputs(classification) {
  writeGithubOutputLine("deploy_required", classification.deployRequired ? "true" : "false");
  writeGithubOutputLine("docs_only", classification.docsOnly ? "true" : "false");
  writeGithubOutputLine("pages_changed", classification.pagesChanged ? "true" : "false");
  writeGithubOutputLine("pages_deploy_required", classification.pagesDeployRequired ? "true" : "false");
  writeGithubOutputLine("worker_changed", classification.workerChanged ? "true" : "false");
  writeGithubOutputLine("worker_deploy_required", classification.workerDeployRequired ? "true" : "false");
}

function runCli(env = process.env) {
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
  console.error(`[deploy-changes] worker_changed=${classification.workerChanged}`);
  console.error(`[deploy-changes] worker_deploy_required=${classification.workerDeployRequired}`);
  console.error(`[deploy-changes] deploy_required=${classification.deployRequired}`);
  console.error(`[deploy-changes] docs_only=${classification.docsOnly}`);

  emitGithubOutputs(classification);
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  runCli();
}
