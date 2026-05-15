#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  hasDeployImpact,
  hasPagesDeployImpact,
  hasWorkerPackagePromotionImpact,
  hasWorkerDeployImpact,
  hasWorkerPromotionImpact,
  normalizeRepoPath,
} from "../lib/deploy-impact.mjs";

const ZERO_SHA = /^0+$/;

export {
  hasDeployImpact,
  hasPagesDeployImpact,
  hasWorkerDeployImpact,
  hasWorkerPackagePromotionImpact,
  hasWorkerPromotionImpact,
};

export function normalizeChangedFiles(rawOutput) {
  return rawOutput
    .split(/\r?\n/g)
    .map((line) => normalizeRepoPath(line.trim()))
    .filter(Boolean);
}

function hasRootPackageDiff(files) {
  return files.includes("package.json") || files.includes("package-lock.json");
}

function hasWorkerPackagePromotionDiff({ baseSha, changedFiles, execFile, headSha }) {
  if (!hasRootPackageDiff(changedFiles)) {
    return false;
  }
  try {
    const raw = execFile(
      "git",
      ["diff", "--unified=0", `${baseSha}...${headSha}`, "--", "package.json", "package-lock.json"],
      { encoding: "utf8" },
    );
    return hasWorkerPackagePromotionImpact(raw);
  } catch {
    return true;
  }
}

export function classifyDeployChanges({
  baseSha,
  eventName,
  execFile = execFileSync,
  headSha,
} = {}) {
  if (eventName !== "push") {
    return {
      changedFiles: [],
      deployRequired: true,
      pagesChanged: true,
      reason: `Non-push event (${eventName ?? "unknown"}) runs the full deploy workflow`,
      workerChanged: true,
      workerPromotionRequired: true,
    };
  }

  if (!baseSha || ZERO_SHA.test(baseSha) || !headSha) {
    return {
      changedFiles: [],
      deployRequired: true,
      pagesChanged: true,
      reason: "Missing push diff base/head; falling back to full deploy path",
      workerChanged: true,
      workerPromotionRequired: true,
    };
  }

  let changedFiles = [];
  try {
    const raw = execFile("git", ["diff", "--name-only", `${baseSha}...${headSha}`], { encoding: "utf8" });
    changedFiles = normalizeChangedFiles(raw);
  } catch {
    return {
      changedFiles: [],
      deployRequired: true,
      pagesChanged: true,
      reason: `Failed to diff ${baseSha}...${headSha}; falling back to full deploy path`,
      workerChanged: true,
      workerPromotionRequired: true,
    };
  }

  const pagesChanged = hasPagesDeployImpact(changedFiles);
  const workerChanged = hasWorkerDeployImpact(changedFiles);
  const workerPromotionRequired = hasWorkerPromotionImpact(changedFiles)
    || hasWorkerPackagePromotionDiff({ baseSha, changedFiles, execFile, headSha });
  return {
    changedFiles,
    deployRequired: hasDeployImpact(changedFiles),
    pagesChanged,
    reason: changedFiles.length > 0
      ? `Detected ${changedFiles.length} changed file(s) in push range`
      : "No changed files detected in push range",
    workerChanged,
    workerPromotionRequired,
  };
}

function writeGithubOutputLine(key, value) {
  process.stdout.write(`${key}=${value}\n`);
}

export function emitGithubOutputs(classification) {
  writeGithubOutputLine("deploy_required", classification.deployRequired ? "true" : "false");
  writeGithubOutputLine("pages_changed", classification.pagesChanged ? "true" : "false");
  writeGithubOutputLine("worker_changed", classification.workerChanged ? "true" : "false");
  writeGithubOutputLine("worker_promotion_required", classification.workerPromotionRequired ? "true" : "false");
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
  console.error(`[deploy-changes] worker_changed=${classification.workerChanged}`);
  console.error(`[deploy-changes] worker_promotion_required=${classification.workerPromotionRequired}`);
  console.error(`[deploy-changes] deploy_required=${classification.deployRequired}`);

  emitGithubOutputs(classification);
}

const isCliEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCliEntrypoint) {
  runCli();
}
