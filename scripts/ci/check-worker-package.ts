#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

interface WorkerPackageRunResult {
  status?: number | null;
  error?: unknown;
}

interface WorkerPackageOptions {
  run?: (command: string, args: string[], options: { cwd: string; stdio: "inherit" }) => WorkerPackageRunResult;
}

function checkLatin1Scripts(directory: string): boolean {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!checkLatin1Scripts(path)) return false;
    } else if (entry.isFile() && /\.(?:c|m)?js$/.test(entry.name)) {
      const source = readFileSync(path, "utf8");
      const offset = source.search(/[^\u0000-\u00ff]/);
      if (offset !== -1) {
        const code = source.charCodeAt(offset).toString(16).toUpperCase().padStart(4, "0");
        console.error(
          `Worker script ${path} contains non-Latin-1 code unit U+${code} at offset ${offset}. ` +
          "Use equivalent \\uXXXX escapes in Worker source: one raw non-Latin-1 character doubles V8's retained bundle source. " +
          "See docs/worker-infrastructure.md#module-initialization.",
        );
        return false;
      }
      const nonAsciiOffset = source.search(/[^\u0000-\u007f]/);
      if (nonAsciiOffset !== -1) {
        const code = source.charCodeAt(nonAsciiOffset).toString(16).toUpperCase().padStart(4, "0");
        const context = JSON.stringify(source.slice(Math.max(0, nonAsciiOffset - 120), nonAsciiOffset + 80));
        console.warn(
          `Worker script ${path} retains non-ASCII U+${code} at offset ${nonAsciiOffset}; emitted origin/context: ${context}. ` +
          "Escape first-party characters with \\uXXXX. Latin-1 dependency notices are allowed, but UTF-8 loading may still retain two-byte source.",
        );
      }
    }
  }
  return true;
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
    if (!checkLatin1Scripts(outputDirectory)) return { status: 1 };
  }
  return { status: 0 };
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  const result = checkWorkerPackage();
  process.exitCode = result.status;
}
