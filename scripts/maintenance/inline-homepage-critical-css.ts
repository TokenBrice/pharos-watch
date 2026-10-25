#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import Beasties, { type Logger, type Options } from "beasties";
import { runDirectCli } from "../lib/cli-args.mjs";

export function collectCriticalCssPages(outDir: string): string[] {
  return readdirSync(outDir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => !path.relative(outDir, file).startsWith(`admin${path.sep}`))
    .sort();
}

export function criticalCssWorkerCount(pageCount: number): number {
  const override = process.env.PHAROS_CRITICAL_CSS_WORKERS;
  const requested = override === undefined ? availableParallelism() - 1 : Number(override);
  if (override !== undefined && (!Number.isSafeInteger(requested) || requested < 1)) {
    throw new Error("PHAROS_CRITICAL_CSS_WORKERS must be a positive integer.");
  }
  return Math.max(1, Math.min(requested, pageCount));
}

// Bust the previous loader's one-week public cache when changing activation timing.
const asyncCssLoaderPath = "/critical-css-loader.js?v=2";
const asyncStylesheetPattern =
  /<link\b(?=[^>]*\brel=["']stylesheet["'])(?=[^>]*\/_next\/static\/(?:chunks|css)\/[^"']+\.css)(?=[^>]*\bmedia=["']print["'])(?=[^>]*\bonload=["']this\.media\s*=\s*["']all["']["'])[^>]*>/gi;

interface OptimizationResult {
  beforeBytes: number;
  afterBytes: number;
  skipped?: boolean;
}

const logLevels = ["trace", "debug", "info", "warn", "error", "silent"] as const;
type LogLevel = Exclude<(typeof logLevels)[number], "silent">;
interface OptimizationLog {
  level: LogLevel;
  message: string;
}

export interface PageOptimizationResult extends OptimizationResult {
  label: string;
  logs: OptimizationLog[];
}

// A worker owns one optimizer and processes its partition sequentially. Source
// CSS is never pruned, so separate workers only write their own HTML files.
export async function optimizeCriticalCssBatch(
  outDir: string,
  filePaths: string[],
): Promise<PageOptimizationResult[]> {
  const logLevel = (process.env.BEASTIES_LOG_LEVEL || "error") as Options["logLevel"];
  const threshold = logLevels.indexOf(logLevel!);
  let logs: OptimizationLog[] = [];
  const logger: Logger = {};
  for (const level of logLevels) {
    if (level !== "silent" && logLevels.indexOf(level) >= threshold) {
      logger[level] = (message) => logs.push({ level, message });
    }
  }
  const optimizer = new Beasties({
    path: outDir,
    publicPath: "/",
    preload: "media",
    pruneSource: false,
    reduceInlineStyles: false,
    inlineFonts: false,
    fonts: false,
    // Keep theme tokens even on pages without dark utility classes.
    // Beasties strips leading selector functions, losing Tailwind spacing/dividers.
    allowRules: [
      ".dark", /^:(?:where|is)\(/,
      // Header's portalled Sheet is absent from SSR; keep its viewport, rail and motion rules.
      ".fixed", ".inset-0", ".inset-y-0", ".left-0", ".z-modal", ".h-full", ".w-full", ".sm\\:max-w-full",
      ".overflow-y-auto", ".min-h-16", ".min-w-14", ".grid-cols-2", ".gap-4", ".mt-2",
      ".border-r", ".border-border\\/45", ".border-transparent", ".bg-black\\/50", ".bg-card", ".bg-muted", ".bg-muted\\/60",
      ".p-0", ".py-4", ".pt-3", ".pl-\\[14px\\]", ".pb-\\[calc\\(env\\(safe-area-inset-bottom\\)\\+0\\.5rem\\)\\]",
      ".leading-tight", ".tabular-nums", ".shadow-lg", ".transition", ".transition-\\[background-color\\,border-color\\,color\\,box-shadow\\]",
      ".\\[animation-fill-mode\\:backwards\\]", ".fade-in", ".slide-in-from-left-2", ".slide-in-from-right-2",
      /^\.(?:motion-reduce\\:)?data-\\\[state\\=(?:open|closed)\\\]\\:(?:animate-|duration-|fade-|slide-)/,
      ".motion-reduce\\:animate-none",
    ],
    logLevel,
    logger,
  });
  const results: PageOptimizationResult[] = [];
  for (const filePath of filePaths) {
    logs = [];
    const label = path.relative(path.dirname(outDir), filePath);
    const result = await optimizePage(optimizer, filePath, label);
    results.push({ ...result, label, logs });
  }
  return results;
}

export async function optimizeCriticalCssPages(
  outDir: string,
  filePaths: string[],
  workerCount = criticalCssWorkerCount(filePaths.length),
): Promise<PageOptimizationResult[]> {
  const files = [...filePaths].sort();
  if (files.length === 0) return [];
  const poolSize = Math.min(workerCount, files.length);
  if (poolSize === 1) return optimizeCriticalCssBatch(outDir, files);

  const partitions = Array.from({ length: poolSize }, () => [] as string[]);
  for (let index = 0; index < files.length; index++) {
    partitions[index % poolSize].push(files[index]);
  }
  const workers: Worker[] = [];
  try {
    const pending = partitions.map((partition) => {
      // scripts/maintenance/critical-css-worker.mjs registers tsx in the worker
      // before importing this module, without relying on inherited loader hooks.
      const worker = new Worker(new URL("./critical-css-worker.mjs", import.meta.url), {
        workerData: { outDir, filePaths: partition },
      });
      workers.push(worker);
      return new Promise<PageOptimizationResult[]>((resolve, reject) => {
        let received = false;
        worker.once("message", (results: PageOptimizationResult[]) => {
          received = true;
          resolve(results);
        });
        worker.once("error", reject);
        worker.once("exit", (code) => {
          if (!received) reject(new Error(`Critical CSS worker exited without results (code ${code}).`));
        });
      });
    });
    return (await Promise.all(pending)).flat().sort((a, b) =>
      a.label < b.label ? -1 : a.label > b.label ? 1 : 0,
    );
  } finally {
    // In particular, stop the other partitions before reporting a page failure.
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}

async function optimizePage(optimizer: Beasties, filePath: string, label: string): Promise<OptimizationResult> {
  const before = readFileSync(filePath, "utf8");

  // Re-running Beasties on an already-optimized page re-attaches onload
  // handlers and duplicates the style block; treat processed pages as done.
  if (before.includes('data-pharos-critical-css="async"')) {
    const bytes = Buffer.byteLength(before);
    return { beforeBytes: bytes, afterBytes: bytes, skipped: true };
  }

  const htmlTag = before.match(/<html\b[^>]*>/i)?.[0];
  if (!htmlTag) throw new Error(`${label}: missing HTML root for theme extraction.`);
  // Match runtime dark variants without shipping a forced theme to the browser.
  const darkHtmlTag = /\sclass\s*=/i.test(htmlTag)
    ? htmlTag.replace(/(\sclass\s*=\s*)(["'])(.*?)\2/i, "$1$2$3 dark$2")
    : htmlTag.replace(/>$/, ' class="dark">');
  let after = (await optimizer.process(before.replace(htmlTag, darkHtmlTag)))
    .replace(/<html\b[^>]*>/i, htmlTag);

  let hasAsyncStylesheet = false;
  after = after.replace(asyncStylesheetPattern, (tag) => {
    hasAsyncStylesheet = true;
    const withoutInlineHandler = tag.replace(/\s+onload=["']this\.media\s*=\s*["']all["']["']/i, "");

    if (/\sdata-pharos-critical-css=/.test(withoutInlineHandler)) {
      return withoutInlineHandler;
    }

    return withoutInlineHandler.replace(/\s*\/?>$/, ' data-pharos-critical-css="async">');
  });

  if (hasAsyncStylesheet && !after.includes(`src="${asyncCssLoaderPath}"`)) {
    const lastLink = [...after.matchAll(/<link\b[^>]*data-pharos-critical-css="async"[^>]*>/g)].at(-1)!;
    const insertAt = lastLink.index + lastLink[0].length;
    after = `${after.slice(0, insertAt)}<script src="${asyncCssLoaderPath}" async></script>${after.slice(insertAt)}`;
  }

  const withoutNoscript = after.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "");

  if (!/<style\b[^>]*>/.test(after)) {
    throw new Error(`${label}: Beasties did not inline a critical style block.`);
  }

  if (/<link\b(?=[^>]*\brel=["']stylesheet["'])(?=[^>]*\/_next\/static\/(?:chunks|css)\/[^"']+\.css)(?![^>]*\bmedia=["']print["'])[^>]*>/i.test(withoutNoscript)) {
    throw new Error(`${label}: still has a render-blocking Next CSS link outside <noscript>.`);
  }

  if (/<[a-z][^>]*\son[a-z]+\s*=/i.test(withoutNoscript)) {
    throw new Error(`${label}: contains an inline event handler outside <noscript>.`);
  }

  if (hasAsyncStylesheet && !after.includes(`<script src="${asyncCssLoaderPath}" async></script>`)) {
    throw new Error(`${label}: has async critical CSS without the CSP-safe async loader script.`);
  }

  if (after !== before) {
    writeFileSync(filePath, after);
  }

  return { beforeBytes: Buffer.byteLength(before), afterBytes: Buffer.byteLength(after) };
}

async function main(): Promise<void> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const outDir = path.join(root, "out");
  if (!existsSync(path.join(outDir, "index.html"))) {
    console.error("[critical-css] Missing out/index.html. Run next build first.");
    process.exit(1);
  }

  const startedAt = Date.now();
  try {
    const results = await optimizeCriticalCssPages(outDir, collectCriticalCssPages(outDir));
    // Worker completion order cannot reorder diagnostics.
    for (const result of results) {
      for (const log of result.logs) console[log.level](log.message);
    }
    const beforeBytes = results.reduce((bytes, result) => bytes + result.beforeBytes, 0);
    const afterBytes = results.reduce((bytes, result) => bytes + result.afterBytes, 0);
    const skipped = results.filter((result) => result.skipped).length;
    console.log(
      `[critical-css] Optimized ${results.length - skipped} public HTML pages, skipped ${skipped} already-inlined pages ` +
      `(${beforeBytes} -> ${afterBytes} bytes, ${Date.now() - startedAt}ms total).`,
    );
  } catch (error) {
    console.error(`[critical-css] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

runDirectCli(import.meta.url, main);
