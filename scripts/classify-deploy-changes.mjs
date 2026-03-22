#!/usr/bin/env node

import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  hasPagesDeployImpact,
  hasWorkerDeployImpact,
  normalizeRepoPath,
} from "./lib/deploy-impact.mjs";

const ZERO_SHA = /^0+$/;

export { hasPagesDeployImpact, hasWorkerDeployImpact };

export function normalizeChangedFiles(rawOutput) {
  return rawOutput
    .split(/\r?\n/g)
    .map((line) => normalizeRepoPath(line.trim()))
    .filter(Boolean);
}

export function classifyDeployChanges({
  baseSha,
  eventName,
  exec = execSync,
  headSha,
} = {}) {
  if (eventName !== "push") {
    return {
      changedFiles: [],
      pagesChanged: true,
      reason: `Non-push event (${eventName ?? "unknown"}) runs the full deploy workflow`,
      workerChanged: true,
    };
  }

  if (!baseSha || ZERO_SHA.test(baseSha) || !headSha) {
    return {
      changedFiles: [],
      pagesChanged: true,
      reason: "Missing push diff base/head; falling back to full deploy path",
      workerChanged: true,
    };
  }

  let changedFiles = [];
  try {
    const raw = exec(`git diff --name-only ${baseSha}..${headSha}`, { encoding: "utf8" });
    changedFiles = normalizeChangedFiles(raw);
  } catch {
    return {
      changedFiles: [],
      pagesChanged: true,
      reason: `Failed to diff ${baseSha}..${headSha}; falling back to full deploy path`,
      workerChanged: true,
    };
  }

  return {
    changedFiles,
    pagesChanged: hasPagesDeployImpact(changedFiles),
    reason: changedFiles.length > 0
      ? `Detected ${changedFiles.length} changed file(s) in push range`
      : "No changed files detected in push range",
    workerChanged: hasWorkerDeployImpact(changedFiles),
  };
}

function writeGithubOutputLine(key, value) {
  process.stdout.write(`${key}=${value}\n`);
}

export function emitGithubOutputs(classification) {
  writeGithubOutputLine("pages_changed", classification.pagesChanged ? "true" : "false");
  writeGithubOutputLine("worker_changed", classification.workerChanged ? "true" : "false");
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

  emitGithubOutputs(classification);
}

const isCliEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCliEntrypoint) {
  runCli();
}
