#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

/** @param {{ run?: (command: string, args: string[], options: Record<string, unknown>) => { status?: number | null, error?: unknown } }} [options] */
export function checkWorkerPackage({ run = spawnSync } = {}) {
  const repoRoot = process.cwd();
  const outputDirectory = resolve(repoRoot, ".cache/merge-gate/discovery/worker-bundle");
  rmSync(outputDirectory, { force: true, recursive: true });
  const result = run(
    "npx",
    ["--no-install", "wrangler", "deploy", "--dry-run", "--outdir", outputDirectory],
    { cwd: resolve(repoRoot, "worker"), stdio: "inherit" },
  );
  return { status: result.status ?? (result.error ? 1 : 0) };
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  const result = checkWorkerPackage();
  process.exitCode = result.status;
}
