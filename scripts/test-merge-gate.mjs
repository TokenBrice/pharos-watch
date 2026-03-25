#!/usr/bin/env node
import { execSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  hasPagesDeployImpact,
  normalizeRepoPath,
} from "./lib/deploy-impact.mjs";

export function normalizePath(path) {
  return normalizeRepoPath(path);
}

export const NON_NEGOTIABLE_VALIDATE_COMMANDS = [
  "npm run audit:deps",
  "npm run lint",
  "npm run check:worker-boundary",
  "npm run check:migrations",
  "npm run check:cron-sync",
  "npm run check:cron-connections",
  "npm run check:doc-counts",
  "npm run check:doc-sync",
  "npm run check:duplicate-exports",
  "npm run check:redemption-backstops",
  "npm run check:unused-code",
  "npm run check:hotspot-ratchet",
  "npm test",
  "npm run coverage:critical",
  "cd worker && npx tsc --noEmit",
];

export const PAGES_VALIDATE_COMMANDS = [
  "npm run build",
  "npm run seo:check",
];

/**
 * Commands that can be skipped when their relevant input files haven't changed.
 * Key: command string (must match an entry in NON_NEGOTIABLE_VALIDATE_COMMANDS).
 * Value: path prefixes — if no changedFiles start with any prefix, the command is skipped.
 */
const SKIPPABLE_CHECKS = new Map([
  ["npm run check:migrations", ["worker/migrations/"]],
  ["npm run check:cron-sync", ["shared/lib/cron-jobs.", "worker/wrangler.toml"]],
  ["npm run check:cron-connections", ["shared/lib/cron-jobs.", "worker/wrangler.toml"]],
  ["npm run check:doc-counts", ["shared/lib/stablecoins/", "docs/"]],
  ["npm run check:redemption-backstops", ["shared/lib/redemption-backstop-configs/"]],
]);

function addCommand(plan, cmd, reason) {
  const existing = plan.find((item) => item.cmd === cmd);
  if (existing) {
    existing.reasons.push(reason);
    return;
  }
  plan.push({ cmd, reasons: [reason] });
}

export function buildCommandPlan(changedFiles) {
  const plan = [];

  const skippedCommands = new Set();
  if (changedFiles.length > 0) {
    for (const [cmd, prefixes] of SKIPPABLE_CHECKS) {
      const relevant = changedFiles.some((f) =>
        prefixes.some((p) => f.startsWith(p) || f === p),
      );
      if (!relevant) skippedCommands.add(cmd);
    }
  }

  const filteredCommands = NON_NEGOTIABLE_VALIDATE_COMMANDS.filter(
    (cmd) => !skippedCommands.has(cmd),
  );

  if (skippedCommands.size > 0) {
    console.log(`\nSkipping ${skippedCommands.size} check(s) (no relevant file changes):`);
    for (const cmd of skippedCommands) console.log(`  - ${cmd}`);
  }

  for (const cmd of filteredCommands) {
    addCommand(plan, cmd, "Local merge gate mirrors the shared CI validate core");
  }

  if (hasPagesDeployImpact(changedFiles)) {
    for (const cmd of PAGES_VALIDATE_COMMANDS) {
      addCommand(plan, cmd, "Pages-impacting files changed");
    }
  }

  return plan;
}

export function buildCiValidateCommands() {
  const testIndex = NON_NEGOTIABLE_VALIDATE_COMMANDS.indexOf("npm test");
  return [
    ...NON_NEGOTIABLE_VALIDATE_COMMANDS.slice(0, testIndex),
    ...PAGES_VALIDATE_COMMANDS,
    ...NON_NEGOTIABLE_VALIDATE_COMMANDS.slice(testIndex),
  ];
}

export function getChangedFiles({ stagedMode = false, baseRef = "origin/main", exec = execSync } = {}) {
  if (stagedMode) {
    const raw = exec("git diff --name-only --cached", { encoding: "utf8" });
    return raw
      .split(/\r?\n/g)
      .map((line) => normalizePath(line.trim()))
      .filter(Boolean);
  }

  let mergeBase;
  try {
    mergeBase = exec(`git merge-base ${baseRef} HEAD`, { encoding: "utf8" }).trim();
  } catch {
    throw new Error(`[merge-gate] Could not resolve merge-base with ${baseRef}. Set MERGE_GATE_BASE_REF explicitly.`);
  }

  const raw = exec(`git diff --name-only ${mergeBase}...HEAD`, { encoding: "utf8" });
  return raw
    .split(/\r?\n/g)
    .map((line) => normalizePath(line.trim()))
      .filter(Boolean);
}

export function getCommandEnv(cmd, changedFiles) {
  if (cmd !== "npm run coverage:critical") {
    return {};
  }

  return {
    CRITICAL_COVERAGE_CHANGED_FILES: changedFiles.join(","),
  };
}

function runCommand(cmd, extraEnv = {}) {
  const result = spawnSync("bash", ["-lc", cmd], {
    stdio: "inherit",
    env: {
      ...process.env,
      ...extraEnv,
    },
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

export function runMergeGate({ argv = process.argv.slice(2), env = process.env } = {}) {
  const args = new Set(argv);
  const stagedMode = args.has("--staged");
  const baseRef = env.MERGE_GATE_BASE_REF ?? "origin/main";
  const dryRun = env.MERGE_GATE_DRY_RUN === "1";
  const changedFiles = getChangedFiles({ stagedMode, baseRef });

  console.log(`[merge-gate] Base ref: ${baseRef}`);
  console.log(`[merge-gate] Mode: ${stagedMode ? "staged" : "merged-diff"}`);
  console.log(`[merge-gate] Changed files: ${changedFiles.length}`);
  for (const file of changedFiles) {
    console.log(`  - ${file}`);
  }

  if (changedFiles.length === 0) {
    console.log("[merge-gate] No changes detected; gate skipped.");
    return;
  }

  const plan = buildCommandPlan(changedFiles);

  console.log("[merge-gate] Command plan:");
  for (let i = 0; i < plan.length; i++) {
    const item = plan[i];
    console.log(`${i + 1}. ${item.cmd}`);
    console.log(`   reasons: ${item.reasons.join("; ")}`);
  }

  if (dryRun) {
    console.log("[merge-gate] Dry run enabled; commands not executed.");
    return;
  }

  for (const item of plan) {
    console.log(`[merge-gate] Running: ${item.cmd}`);
    runCommand(item.cmd, getCommandEnv(item.cmd, changedFiles));
  }

  console.log("[merge-gate] All checks passed.");
}

const isCliEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCliEntrypoint) {
  runMergeGate();
}
