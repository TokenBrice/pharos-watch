#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const PAGES_ARTIFACT_DIRECTORY = "out";
// Local gzip 14.32e6 bytes passed, but 14.87e6 was rejected as 15275KB:
// Cloudflare's effective limit lies between those observations. Leave headroom.
export const WORKER_SOURCE_MAP_GZIP_BUDGET_BYTES = 13.5e6;

interface WorkerPackageRunResult {
  status?: number | null;
  error?: unknown;
}

interface WorkerPackageOptions {
  run?: (command: string, args: string[], options: { cwd: string; stdio: "inherit" }) => WorkerPackageRunResult;
}

function findSourceMaps(directory: string): string[] {
  const maps: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      maps.push(...findSourceMaps(path));
    } else if (entry.isFile() && entry.name.endsWith(".map")) {
      maps.push(path);
    }
  }
  return maps;
}

export function checkSourceMapSizes(directory: string): boolean {
  let valid = true;
  for (const path of findSourceMaps(directory)) {
    const bytes = gzipSync(readFileSync(path)).byteLength;
    console.log(`Worker source map ${path}: ${bytes} gzip bytes (budget ${WORKER_SOURCE_MAP_GZIP_BUDGET_BYTES}).`);
    if (bytes > WORKER_SOURCE_MAP_GZIP_BUDGET_BYTES) {
      console.error(`Worker source map ${path} exceeds the ${WORKER_SOURCE_MAP_GZIP_BUDGET_BYTES}-byte gzip budget.`);
      valid = false;
    }
  }
  return valid;
}

/**
 * `upload_source_maps = true` is a deployment-time private upload: Cloudflare
 * retains the map for Workers Logs and never serves it. The Pages artifact is
 * public, so a map emitted under `out/` would publish Worker source.
 */
function checkPrivateSourceMaps(repoRoot: string): boolean {
  const pagesRoot = resolve(repoRoot, PAGES_ARTIFACT_DIRECTORY);
  if (!existsSync(pagesRoot)) return true;
  const [sourceMap] = findSourceMaps(pagesRoot);
  if (!sourceMap) return true;
  console.error(
    `Pages artifact ${pagesRoot} contains a source map (${sourceMap}). ` +
    "Worker source maps are uploaded privately by Cloudflare; never emit source maps into Pages assets.",
  );
  return false;
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
          const slashed = source.replaceAll("\\", "/");
          let offset = 0;
          while (true) {
            if (slashed.startsWith("./", offset)) offset += 2;
            else if (slashed.startsWith("../", offset)) offset += 3;
            else break;
          }
          const normalized = slashed.slice(offset);
          if (
            /(?:(?:^|\/)worker\/|^)src\/(?:api\/|routes\/|handlers\/http\/|router\.[cm]?[jt]sx?$|handlers\/scheduled\/public-runners\.[cm]?[jt]s$)/.test(normalized) ||
            // Telegram HTTP seams include the HTTP-bearing telegram-pulse.ts.
            /(?:(?:^|\/)worker\/|^)src\/telegram\/(?:webhook|commands|callbacks|mini-app|admin)\//.test(normalized) ||
            /(?:^|\/)fonts?\//.test(normalized) ||
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
  if (!checkPrivateSourceMaps(repoRoot)) return { status: 1 };
  for (const [role, config] of [["public", "wrangler.toml"], ["heavy", "wrangler.heavy.toml"]]) {
    const outputDirectory = resolve(repoRoot, `.cache/release-check/worker-bundle-${role}`);
    rmSync(outputDirectory, { force: true, recursive: true });
    const result = run(
      "npx",
      ["--no-install", "wrangler", "deploy", "--strict", "--config", config, "--dry-run", "--outdir", outputDirectory],
      { cwd: resolve(repoRoot, "worker"), stdio: "inherit" },
    );
    if (result.error || result.status !== 0) return { status: result.status ?? 1 };
    if (!checkSourceMapSizes(outputDirectory)) return { status: 1 };
    if (!checkLatin1Scripts(outputDirectory)) return { status: 1 };
    if (role === "heavy" && !checkHeavyReachability(outputDirectory)) return { status: 1 };
  }
  return { status: 0 };
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  const result = checkWorkerPackage();
  process.exitCode = result.status;
}
