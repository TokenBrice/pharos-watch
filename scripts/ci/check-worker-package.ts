#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

interface WorkerPackageRunResult {
  status?: number | null;
  error?: unknown;
}

interface WorkerPackageOptions {
  run?: (command: string, args: string[], options: { cwd: string; stdio: "inherit" }) => WorkerPackageRunResult;
}

export function checkWorkerPackage({ run = spawnSync }: WorkerPackageOptions = {}): WorkerPackageRunResult {
  const repoRoot = process.cwd();
  for (const [role, config] of [["public", "wrangler.toml"], ["heavy", "wrangler.heavy.toml"]]) {
    const outputDirectory = resolve(repoRoot, `.cache/release-check/worker-bundle-${role}`);
    rmSync(outputDirectory, { force: true, recursive: true });
    const result = run(
      "npx",
      ["--no-install", "wrangler", "deploy", "--strict", "--config", config, "--dry-run", "--outdir", outputDirectory],
      { cwd: resolve(repoRoot, "worker"), stdio: "inherit" },
    );
    if (result.error || result.status !== 0) return { status: result.status ?? 1 };
  }
  return { status: 0 };
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  const result = checkWorkerPackage();
  process.exitCode = result.status;
}
