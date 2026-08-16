#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Beasties from "beasties";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = path.join(root, "out");
const homepagePath = path.join(outDir, "index.html");

if (!existsSync(homepagePath)) {
  console.error("[critical-css] Missing out/index.html. Run next build first.");
  process.exit(1);
}

// Coin detail pages are the SEO landing surface (~400 pages sharing one
// template); without this pass each of them render-blocks on the full global
// stylesheet (~64 KB gz). Each coin's /yield subpage ships the same
// render-blocking link, so it gets the same treatment. Pages are processed
// individually (shared optimizer, ~60ms/page) so per-coin markup variations
// stay correct.
const stablecoinDir = path.join(outDir, "stablecoin");
const detailPagePaths = existsSync(stablecoinDir)
  ? readdirSync(stablecoinDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => [
        path.join(stablecoinDir, entry.name, "index.html"),
        path.join(stablecoinDir, entry.name, "yield", "index.html"),
      ])
      .filter((file) => existsSync(file))
  : [];

const optimizer = new Beasties({
  path: outDir,
  publicPath: "/",
  preload: "media",
  pruneSource: false,
  reduceInlineStyles: false,
  inlineFonts: false,
  fonts: false,
  logLevel: (process.env.BEASTIES_LOG_LEVEL || "error") as "error" | "info" | "warn" | "trace" | "debug" | "silent",
});

const asyncCssLoaderPath = "/critical-css-loader.js";
const asyncStylesheetPattern =
  /<link\b(?=[^>]*\brel=["']stylesheet["'])(?=[^>]*\/_next\/static\/(?:chunks|css)\/[^"']+\.css)(?=[^>]*\bmedia=["']print["'])(?=[^>]*\bonload=["']this\.media\s*=\s*["']all["']["'])[^>]*>/gi;

interface OptimizationResult {
  beforeBytes: number;
  afterBytes: number;
  skipped?: boolean;
}

async function optimizePage(filePath: string, label: string): Promise<OptimizationResult> {
  const before = readFileSync(filePath, "utf8");

  // Re-running Beasties on an already-optimized page re-attaches onload
  // handlers and duplicates the style block; treat processed pages as done.
  if (before.includes('data-pharos-critical-css="async"')) {
    const bytes = Buffer.byteLength(before);
    return { beforeBytes: bytes, afterBytes: bytes, skipped: true };
  }

  let after = await optimizer.process(before);

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
    after = after.replace("</head>", `<script src="${asyncCssLoaderPath}" defer></script></head>`);
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

  if (hasAsyncStylesheet && !after.includes(`src="${asyncCssLoaderPath}"`)) {
    throw new Error(`${label}: has async critical CSS without the CSP-safe loader script.`);
  }

  if (after !== before) {
    writeFileSync(filePath, after);
  }

  return { beforeBytes: Buffer.byteLength(before), afterBytes: Buffer.byteLength(after) };
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  try {
  const homepage = await optimizePage(homepagePath, "out/index.html");
  console.log(
    `[critical-css] Optimized out/index.html (${homepage.beforeBytes} -> ${homepage.afterBytes} bytes).`,
  );

  // Pages have no ordering dependency; process them in bounded-concurrency
  // batches so the ~60ms/page cost overlaps instead of running serially.
  const CONCURRENCY = 8;
  let detailBefore = 0;
  let detailAfter = 0;
  for (let i = 0; i < detailPagePaths.length; i += CONCURRENCY) {
    const batch = detailPagePaths.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((filePath) => optimizePage(filePath, path.relative(root, filePath))),
    );
    for (const result of results) {
      detailBefore += result.beforeBytes;
      detailAfter += result.afterBytes;
    }
  }
  if (detailPagePaths.length > 0) {
    console.log(
      `[critical-css] Optimized ${detailPagePaths.length} coin detail + yield pages ` +
      `(${detailBefore} -> ${detailAfter} bytes, ${Date.now() - startedAt}ms total).`,
    );
  }
  } catch (error) {
    console.error(`[critical-css] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

void main();
