#!/usr/bin/env node

import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const ZERO_SHA = /^0+$/;

const WORKER_CHANGE_PREFIXES = [
  "shared/",
  "worker/",
];

const PAGES_CHANGE_PREFIXES = [
  "data/",
  "functions/",
  "public/",
  "shared/",
  "src/",
];

const FULL_DEPLOY_INFRA_PATHS = new Set([
  ".github/workflows/deploy-cloudflare.yml",
  ".github/workflows/validate-ci.yml",
  "package-lock.json",
  "package.json",
  "scripts/classify-deploy-changes.mjs",
]);

const WORKER_CHANGE_EXACT_PATHS = new Set([
  "scripts/check-cron-schedule-sync.ts",
  "scripts/check-worker-import-boundary.mjs",
  "scripts/check-worker-migrations.mjs",
  "scripts/smoke-api.mjs",
]);

const PAGES_CHANGE_EXACT_PATHS = new Set([
  "next.config.ts",
  "postcss.config.mjs",
  "scripts/check-seo-static.mjs",
  "scripts/generate-redirects.ts",
  "scripts/serve-static-export.mjs",
  "scripts/smoke-ui.mjs",
  "scripts/sync-digests.ts",
  "tsconfig.json",
]);

export function normalizeChangedFiles(rawOutput) {
  return rawOutput
    .split(/\r?\n/g)
    .map((line) => line.trim().replaceAll("\\", "/"))
    .filter(Boolean);
}

export function hasWorkerDeployImpact(files) {
  return files.some((file) =>
    FULL_DEPLOY_INFRA_PATHS.has(file)
    || WORKER_CHANGE_EXACT_PATHS.has(file)
    || WORKER_CHANGE_PREFIXES.some((prefix) => file.startsWith(prefix)),
  );
}

export function hasPagesDeployImpact(files) {
  return files.some((file) =>
    FULL_DEPLOY_INFRA_PATHS.has(file)
    || PAGES_CHANGE_EXACT_PATHS.has(file)
    || PAGES_CHANGE_PREFIXES.some((prefix) => file.startsWith(prefix)),
  );
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
