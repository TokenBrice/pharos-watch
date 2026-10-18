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

// Inspect emitted reachability, not source import spelling: Wrangler resolves aliases
// and dynamic imports before writing the map. Missing evidence must fail closed.
export function checkHeavyReachability(directory: string): boolean {
  let sourceCount = 0;
  let valid = true;
  function reject(path: string): void {
    console.error(`Heavy Worker reaches forbidden HTTP/rendering source or asset: ${path}`);
    valid = false;
  }
  function visit(current: string): void {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.isFile()) continue;
      if (/\.(?:wasm|ttf|otf|woff2?)$/i.test(entry.name)) reject(path);
      if (!entry.name.endsWith(".map")) continue;
      try {
        const map: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (
          !map || typeof map !== "object" || !("sources" in map) ||
          !Array.isArray(map.sources) ||
          !map.sources.every((source: unknown) => typeof source === "string" && source.trim().length > 0)
        ) throw new Error("missing sources array");
        for (const source of map.sources as string[]) {
          sourceCount++;
          const normalized = source.replaceAll("\\", "/");
          if (
            /(?:^|\/)(?:worker\/)?src\/(?:api\/|routes\/|handlers\/http\/|router\.[cm]?[jt]sx?$|handlers\/scheduled\/public-runners\.[cm]?[jt]s$)/.test(normalized) ||
            /(?:^|\/)(?:api|og|telegram-webhook|fonts?)(?:\/|[.-])/.test(normalized) ||
            /\.(?:wasm|ttf|otf|woff2?)(?:$|\?)/i.test(normalized) ||
            /(?:^|\/)(?:@resvg|satori|yoga-wasm-web)(?:\/|$)/.test(normalized)
          ) reject(source);
        }
      } catch (error) {
        console.error(`Cannot inspect heavy Worker source map ${path}: ${String(error)}`);
        valid = false;
      }
    }
  }
  visit(directory);
  if (sourceCount === 0) {
    console.error("Heavy Worker reachability evidence is missing: no nonempty source map sources.");
    return false;
  }
  return valid;
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
    if (role === "heavy" && !checkHeavyReachability(outputDirectory)) return { status: 1 };
  }
  return { status: 0 };
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  const result = checkWorkerPackage();
  process.exitCode = result.status;
}
