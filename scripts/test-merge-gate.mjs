#!/usr/bin/env node
import { execSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function normalizePath(path) {
  return path.replaceAll("\\", "/");
}

export function isMarkdown(path) {
  return path === "README.md" || path.startsWith("docs/") || path.endsWith(".md");
}

export function hasDocsChange(files) {
  return files.some((file) => isMarkdown(file));
}

export function hasTypeScriptOrJsChange(files) {
  return files.some((file) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file));
}

export function hasCriticalApiContractChange(files) {
  return files.some(
    (file) =>
      file.startsWith("worker/src/api/") ||
      file === "src/lib/api.ts" ||
      file === "shared/lib/api-endpoints.ts" ||
      file === "shared/lib/strict-contract-paths.ts" ||
      file === "shared/types/index.ts",
  );
}

export function hasCronOrWorkerLibChange(files) {
  return files.some(
    (file) =>
      file.startsWith("worker/src/cron/") || file.startsWith("worker/src/lib/") || file.startsWith("shared/lib/"),
  );
}

export function hasRedemptionBackstopChange(files) {
  return files.some(
    (file) =>
      file === "docs/redemption-backstops.md" ||
      file.startsWith("shared/lib/redemption-backstop") ||
      file === "shared/lib/redemption-backstops.ts" ||
      file.startsWith("shared/types/redemption.ts") ||
      file.startsWith("worker/src/api/redemption-backstops") ||
      file.startsWith("worker/src/cron/sync-redemption-backstops") ||
      file.startsWith("worker/src/lib/redemption-backstop") ||
      file.startsWith("src/components/stablecoin-detail/redemption-backstop") ||
      file === "src/lib/coverage.ts",
  );
}

export function hasGateInfraChange(files) {
  return files.some(
    (file) =>
      file.startsWith(".github/workflows/") ||
      file === "scripts/check-critical-coverage.mjs" ||
      file === "scripts/test-merge-gate.mjs" ||
      file === "package.json" ||
      file === "package-lock.json" ||
      file.startsWith(".ci/"),
  );
}

export function hasBuildOrSeoImpact(files) {
  return files.some(
    (file) =>
      file.startsWith("src/app/") ||
      file.startsWith("src/components/") ||
      file.startsWith("public/") ||
      file === "next.config.ts" ||
      file === "next.config.mjs" ||
      file === "scripts/check-seo-static.mjs" ||
      file === "scripts/generate-redirects.ts",
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

export function buildCommandPlan(changedFiles) {
  const plan = [];

  if (hasDocsChange(changedFiles)) {
    addCommand(plan, "npm run check:doc-counts", "Documentation files changed");
  }

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

  if (hasRedemptionBackstopChange(changedFiles)) {
    addCommand(plan, "npm run check:redemption-backstops", "Redemption backstop registry or docs changed");
  }

  if (hasGateInfraChange(changedFiles)) {
    addCommand(plan, "npm test", "Workflow/gating infrastructure changed");
    addCommand(plan, "npm run coverage:critical", "Workflow/gating infrastructure changed");
  }

  if (hasBuildOrSeoImpact(changedFiles)) {
    addCommand(plan, "npm run build", "Frontend export or SEO-critical files changed");
    addCommand(plan, "npm run seo:check", "Frontend export or SEO-critical files changed");
  }

  if (plan.length === 0) {
    addCommand(plan, "npm test", "Fallback for non-doc changes");
  }

  return plan;
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

function runCommand(cmd) {
  const result = spawnSync("bash", ["-lc", cmd], { stdio: "inherit" });
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
    runCommand(item.cmd);
  }

  console.log("[merge-gate] All checks passed.");
}

const isCliEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCliEntrypoint) {
  runMergeGate();
}
