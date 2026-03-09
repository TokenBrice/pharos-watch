#!/usr/bin/env node
import { execSync, spawnSync } from "node:child_process";

const args = new Set(process.argv.slice(2));
const stagedMode = args.has("--staged");
const baseRef = process.env.MERGE_GATE_BASE_REF ?? "origin/main";
const dryRun = process.env.MERGE_GATE_DRY_RUN === "1";

function normalizePath(p) {
  return p.replaceAll("\\", "/");
}

function getChangedFiles() {
  if (stagedMode) {
    const raw = execSync("git diff --name-only --cached", { encoding: "utf8" });
    return raw.split(/\r?\n/g).map((line) => normalizePath(line.trim())).filter(Boolean);
  }

  let mergeBase;
  try {
    mergeBase = execSync(`git merge-base ${baseRef} HEAD`, { encoding: "utf8" }).trim();
  } catch {
    throw new Error(`[merge-gate] Could not resolve merge-base with ${baseRef}. Set MERGE_GATE_BASE_REF explicitly.`);
  }

  const raw = execSync(`git diff --name-only ${mergeBase}...HEAD`, { encoding: "utf8" });
  return raw.split(/\r?\n/g).map((line) => normalizePath(line.trim())).filter(Boolean);
}

function isMarkdown(path) {
  return path === "README.md" || path.startsWith("docs/") || path.endsWith(".md");
}

function hasTypeScriptOrJsChange(files) {
  return files.some((f) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f));
}

function hasCriticalApiContractChange(files) {
  return files.some((f) =>
    f.startsWith("worker/src/api/")
    || f === "src/lib/api.ts"
    || f === "shared/lib/api-endpoints.ts"
    || f === "shared/lib/strict-contract-paths.ts"
    || f === "shared/types/index.ts"
  );
}

function hasCronOrWorkerLibChange(files) {
  return files.some((f) =>
    f.startsWith("worker/src/cron/")
    || f.startsWith("worker/src/lib/")
    || f.startsWith("shared/lib/")
  );
}

function hasGateInfraChange(files) {
  return files.some((f) =>
    f.startsWith(".github/workflows/")
    || f === "scripts/check-critical-coverage.mjs"
    || f === "scripts/test-merge-gate.mjs"
    || f === "package.json"
    || f === "package-lock.json"
    || f.startsWith(".ci/")
  );
}

function addCommand(plan, cmd, reason) {
  const existing = plan.find((item) => item.cmd === cmd);
  if (existing) {
    existing.reasons.push(reason);
    return;
  }
  plan.push({ cmd, reasons: [reason] });
}

function runCommand(cmd) {
  const result = spawnSync("bash", ["-lc", cmd], { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const changedFiles = getChangedFiles();
console.log(`[merge-gate] Base ref: ${baseRef}`);
console.log(`[merge-gate] Mode: ${stagedMode ? "staged" : "merged-diff"}`);
console.log(`[merge-gate] Changed files: ${changedFiles.length}`);
for (const file of changedFiles) {
  console.log(`  - ${file}`);
}

if (changedFiles.length === 0) {
  console.log("[merge-gate] No changes detected; gate skipped.");
  process.exit(0);
}

const plan = [];

if (hasTypeScriptOrJsChange(changedFiles)) {
  addCommand(plan, "npm run lint", "TypeScript/JavaScript files changed");
  addCommand(plan, "cd worker && npx tsc --noEmit", "Worker/shared TypeScript compatibility check");
}

if (hasCriticalApiContractChange(changedFiles)) {
  addCommand(plan, "npm run test:critical-contracts", "Critical API/shared contract files changed");
  addCommand(plan, "npm run coverage:critical", "Critical API/shared contract files changed");
}

if (hasCronOrWorkerLibChange(changedFiles)) {
  addCommand(plan, "npm run test:invariants", "Cron or worker library files changed");
  addCommand(plan, "npm run coverage:critical", "Cron or worker library files changed");
}

if (hasGateInfraChange(changedFiles)) {
  addCommand(plan, "npm test", "Workflow/gating infrastructure changed");
  addCommand(plan, "npm run coverage:critical", "Workflow/gating infrastructure changed");
}

if (plan.length === 0) {
  if (changedFiles.every(isMarkdown)) {
    console.log("[merge-gate] Docs-only change detected; no test commands required.");
    process.exit(0);
  }
  addCommand(plan, "npm test", "Fallback for non-doc changes");
}

console.log("[merge-gate] Command plan:");
for (let i = 0; i < plan.length; i++) {
  const item = plan[i];
  console.log(`${i + 1}. ${item.cmd}`);
  console.log(`   reasons: ${item.reasons.join("; ")}`);
}

if (dryRun) {
  console.log("[merge-gate] Dry run enabled; commands not executed.");
  process.exit(0);
}

for (const item of plan) {
  console.log(`[merge-gate] Running: ${item.cmd}`);
  runCommand(item.cmd);
}

console.log("[merge-gate] All checks passed.");
