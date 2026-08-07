#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { classifyChangedFiles } from "../ci/classify-deploy-changes.mjs";
import { selectChangedGeneratedArtifactIds } from "../ci/select-generated-artifacts.mjs";
import { collectChangedFiles, parseChangedFileArgs } from "../lib/changed-files.mjs";
import { hasTelegramLoadGuardImpact } from "../lib/telegram-load-guard.mjs";

const ROOT_DEPENDENCY_PATHS = new Set(["package.json", "package-lock.json"]);
const STRUCTURAL_CHECK_EXACT_PATHS = new Set(["package.json", "package-lock.json"]);
const STRUCTURAL_CHECK_PREFIXES = [".github/", "functions/", "scripts/", "shared/", "src/", "worker/"];

function hasStructuralCheckImpact(changedFiles) {
  return changedFiles.some(
    (file) =>
      STRUCTURAL_CHECK_EXACT_PATHS.has(file) ||
      STRUCTURAL_CHECK_PREFIXES.some((prefix) => file.startsWith(prefix)),
  );
}

function runNpmScript(name, args = [], { env = process.env, spawn = spawnSync } = {}) {
  console.log(`[check:pr:static] npm run ${name}${args.length > 0 ? ` -- ${args.join(" ")}` : ""}`);
  const result = spawn("npm", ["run", name, ...(args.length > 0 ? ["--", ...args] : [])], {
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

export function buildPrStaticCheckPlan(changedFiles) {
  const classification = classifyChangedFiles(changedFiles);
  const commands = [
    { name: "lint:changed" },
    { name: "check:table-primitives" },
    { name: "typecheck" },
    { name: "check:env-contract" },
    { name: "check:shared-types-imports" },
    { name: "check:critical-coverage-completeness" },
  ];

  if (changedFiles.some((file) => ROOT_DEPENDENCY_PATHS.has(file))) {
    commands.push({ name: "audit:deps" });
  }

  if (hasStructuralCheckImpact(changedFiles)) {
    commands.push({ name: "check:structural" });
  }

  if (classification.pagesChanged) {
    commands.push(
      { name: "check:client-registry-imports" },
      { name: "check:site-csp-sync" },
      { name: "check:stablecoin-data" },
    );
  }

  // A generated artifact must be regenerated in the same commit as the source
  // it is derived from, whatever lane that source lives in. This selection used
  // to sit inside the `pagesChanged` branch, so a commit that only touched
  // `shared/lib/safety-score-v9/**` or `worker/src/lib/safety-score-v9*.ts`
  // could leave the V9 evaluation-build manifest stale and still pass the PR
  // gate — the Wave-1 fix wave did exactly that, and only the release discovery
  // gate caught it.
  const artifactIds = selectChangedGeneratedArtifactIds(changedFiles);
  if (artifactIds.length > 0) {
    commands.push({ name: "check:generated-artifacts", args: [`--only=${artifactIds.join(",")}`] });
  }

  if (classification.workerChanged) {
    commands.push(
      { name: "typecheck:worker" },
      { name: "check:cron-connections" },
      { name: "check:cron-sync" },
      { name: "check:migrations" },
      { name: "check:sql-safety" },
      { name: "check:worker-boundary" },
      { name: "check:worker-config" },
      { name: "check:worker-package" },
    );
  }

  if (hasTelegramLoadGuardImpact(changedFiles)) {
    commands.push({ name: "check:telegram-load" });
  }

  return { classification, commands };
}

export function runPrStaticChecks({
  argv = process.argv.slice(2),
  env = process.env,
  spawn = spawnSync,
} = {}) {
  const { base, head, rest } = parseChangedFileArgs(argv, env);
  if (rest.length > 0) throw new Error(`Unknown option(s): ${rest.join(", ")}`);
  const changedFiles = collectChangedFiles({ base, head });
  const { classification, commands } = buildPrStaticCheckPlan(changedFiles);

  console.log(
    `[check:pr:static] ${changedFiles.length} changed file(s); ` +
      `pages=${classification.pagesChanged}, worker=${classification.workerChanged}.`,
  );
  for (const command of commands) {
    const args =
      command.name === "lint:changed"
        ? [`--base=${base}`, `--head=${head}`]
        : (command.args ?? []);
    runNpmScript(command.name, args, { env, spawn });
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(runPrStaticChecks());
}
