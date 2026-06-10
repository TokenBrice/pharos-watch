#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { formatBytes } from "../lib/format-bytes.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = new Set(process.argv.slice(2));
const check = args.has("--check");

const DEFAULT_BUDGETS = {
  // Cloudflare Pages direct uploads cap Wrangler deployments at 20,000 files.
  // Next App Router static exports emit multiple RSC helper files per route,
  // so track file count explicitly instead of discovering this at deploy time.
  totalOutFiles: 20_000,
  // Bumped from 12 MB after Council-13 W2-C split. The client registry now
  // includes reserve and portfolio exposure fields, while several static
  // pages still legitimately consume the full registry at build time.
  totalJsBytes: 14_500_000,
  // Mint-authority coverage metadata expanded the generated client registry.
  // Keep this tight so future registry growth still has to justify itself.
  largestJsBytes: 1_560_000,
  totalCssBytes: 650_000,
  // Lighthouse mobile reports the global CSS transfer as render-blocking, so
  // track compressed CSS too instead of relying only on raw chunk size.
  // Homepage render path now includes an expanded above-the-fold critical style block.
  // Keep this slightly above 62.5 KiB to avoid false positives while still enforcing
  // a practical compressed CSS ceiling on critical assets.
  largestCssGzipBytes: 65_000,
  totalStaticMediaBytes: 2_000_000,
  // Allow documented App Router + RSC payload growth on docs-heavy release pages.
  largestHtmlBytes: 2_700_000,
  // Keep the homepage bootstrap/RSC payload from silently growing into the
  // mobile critical path again without constraining long-form docs pages.
  // The current optimized homepage payload is near 288 KiB after inline critical CSS.
  // Raise the ceiling slightly to preserve signal without blocking legitimate UI updates.
  homepageHtmlBytes: 320_000,
  // Docs/API reference RSC helpers are the largest legitimate TXT payloads.
  largestTxtBytes: 1_300_000,
  // Production Pages builds hydrate mirrors from live API data. USDC's detail
  // page now carries richer SEO JSON-LD plus the inline critical-CSS block
  // (~68 KB raw) that replaced the render-blocking global stylesheet, so the
  // ceiling sits above the ~253 KB optimized payload.
  representativeDetailHtmlBytes: 270_000,
  representativeDetailPageTxtBytes: 90_000,
  // Sum of gzip sizes of every script chunk referenced by a representative
  // detail page's HTML — the eager first-load JS budget per route (Mythos
  // #50). Current payload is ~771 KB gz per detail page; ratchet down after
  // the registry split (#4) and chart-kit consolidation (#5) land.
  representativeDetailEagerJsGzipBytes: 810_000,
};

const BUDGET_ENV = {
  totalOutFiles: "PHAROS_SIZE_BUDGET_TOTAL_OUT_FILES",
  totalJsBytes: "PHAROS_SIZE_BUDGET_TOTAL_JS_BYTES",
  largestJsBytes: "PHAROS_SIZE_BUDGET_LARGEST_JS_BYTES",
  totalCssBytes: "PHAROS_SIZE_BUDGET_TOTAL_CSS_BYTES",
  largestCssGzipBytes: "PHAROS_SIZE_BUDGET_LARGEST_CSS_GZIP_BYTES",
  totalStaticMediaBytes: "PHAROS_SIZE_BUDGET_TOTAL_STATIC_MEDIA_BYTES",
  largestHtmlBytes: "PHAROS_SIZE_BUDGET_LARGEST_HTML_BYTES",
  homepageHtmlBytes: "PHAROS_SIZE_BUDGET_HOMEPAGE_HTML_BYTES",
  largestTxtBytes: "PHAROS_SIZE_BUDGET_LARGEST_TXT_BYTES",
  representativeDetailHtmlBytes: "PHAROS_SIZE_BUDGET_DETAIL_HTML_BYTES",
  representativeDetailPageTxtBytes: "PHAROS_SIZE_BUDGET_DETAIL_PAGE_TXT_BYTES",
  representativeDetailEagerJsGzipBytes: "PHAROS_SIZE_BUDGET_DETAIL_EAGER_JS_GZIP_BYTES",
};

const REPRESENTATIVE_DETAIL_ROUTES = [
  "stablecoin/usdc-circle",
  "stablecoin/usdt-tether",
  "stablecoin/dai-makerdao",
  "stablecoin/usde-ethena",
  "stablecoin/eurc-circle",
];

function resolveBudget(key) {
  const raw = process.env[BUDGET_ENV[key]];
  if (!raw) return DEFAULT_BUDGETS[key];
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_BUDGETS[key];
}

const budgets = Object.fromEntries(Object.keys(DEFAULT_BUDGETS).map((key) => [key, resolveBudget(key)]));

function collectFiles(dir, predicate = () => true) {
  const out = [];
  if (!existsSync(dir)) return out;

  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !predicate(fullPath)) continue;
      const size = statSync(fullPath).size;
      out.push({ path: fullPath, rel: path.relative(root, fullPath), size });
    }
  }
  return out.sort((a, b) => b.size - a.size || a.rel.localeCompare(b.rel));
}

function sum(files) {
  return files.reduce((total, file) => total + file.size, 0);
}

function printTop(title, files, limit = 20) {
  console.log(`\n${title}`);
  if (files.length === 0) {
    console.log("  (none)");
    return;
  }
  for (const file of files.slice(0, limit)) {
    console.log(`  ${formatBytes(file.size).padStart(9)}  ${file.rel}`);
  }
}

function withGzipSize(files) {
  return files
    .map((file) => ({
      ...file,
      gzipSize: gzipSync(readFileSync(file.path)).byteLength,
    }))
    .sort((a, b) => b.gzipSize - a.gzipSize || a.rel.localeCompare(b.rel));
}

function printTopCompressed(title, files, limit = 20) {
  console.log(`\n${title}`);
  if (files.length === 0) {
    console.log("  (none)");
    return;
  }
  for (const file of files.slice(0, limit)) {
    console.log(
      `  ${formatBytes(file.gzipSize).padStart(9)} gzip  ${formatBytes(file.size).padStart(9)} raw  ${file.rel}`,
    );
  }
}

function readFontManifestSummary() {
  const manifestPath = path.join(root, ".next/server/next-font-manifest.json");
  if (!existsSync(manifestPath)) {
    return null;
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const app = manifest.app ?? {};
  return Object.entries(app)
    .map(([route, fonts]) => ({
      route,
      fonts: Array.isArray(fonts) ? fonts.map((font) => font?.path ?? String(font)).filter(Boolean) : [],
    }))
    .sort((a, b) => a.route.localeCompare(b.route));
}

function checkBudget(label, actual, budget, failures) {
  const ok = actual <= budget;
  console.log(`${ok ? "ok" : "FAIL"} ${label}: ${formatBytes(actual)} / ${formatBytes(budget)}`);
  if (!ok) {
    failures.push(`${label} is ${actual} bytes, budget is ${budget} bytes`);
  }
}

function checkCountBudget(label, actual, budget, failures) {
  const ok = actual <= budget;
  console.log(`${ok ? "ok" : "FAIL"} ${label}: ${actual} / ${budget}`);
  if (!ok) {
    failures.push(`${label} is ${actual}, budget is ${budget}`);
  }
}

const outDir = path.join(root, "out");
const nextStaticDir = path.join(outDir, "_next/static");
const chunksDir = path.join(nextStaticDir, "chunks");
const mediaDir = path.join(nextStaticDir, "media");

if (!existsSync(outDir)) {
  console.error("[build-size] Missing out/. Run npm run build first.");
  process.exit(check ? 1 : 0);
}

const allOutFiles = collectFiles(outDir);
const jsFiles = collectFiles(chunksDir, (file) => file.endsWith(".js"));
const cssFiles = collectFiles(chunksDir, (file) => file.endsWith(".css"));
const cssFilesWithGzip = withGzipSize(cssFiles);
const mediaFiles = collectFiles(mediaDir);
const htmlFiles = collectFiles(outDir, (file) => file.endsWith(".html"));
const txtFiles = collectFiles(outDir, (file) => file.endsWith(".txt"));
const homepageHtmlPath = path.join(outDir, "index.html");
const homepageHtmlSize = existsSync(homepageHtmlPath) ? statSync(homepageHtmlPath).size : 0;

console.log("# Pharos Build Size Report");
console.log(`out total files: ${allOutFiles.length}`);
console.log(`out total raw size: ${formatBytes(sum(allOutFiles))}`);
console.log(`JS chunks: ${formatBytes(sum(jsFiles))} across ${jsFiles.length} files`);
console.log(`CSS chunks: ${formatBytes(sum(cssFiles))} across ${cssFiles.length} files`);
console.log(`static media: ${formatBytes(sum(mediaFiles))} across ${mediaFiles.length} files`);
console.log(`HTML: ${formatBytes(sum(htmlFiles))} across ${htmlFiles.length} files`);
console.log(`TXT/RSC helpers: ${formatBytes(sum(txtFiles))} across ${txtFiles.length} files`);

printTop("Top out files", allOutFiles, 50);
printTop("Top JS chunks", jsFiles, 30);
printTopCompressed("Top CSS chunks", cssFilesWithGzip, 30);
printTop("Top HTML files", htmlFiles, 30);
printTop("Top TXT/RSC helper files", txtFiles, 30);

const fontSummary = readFontManifestSummary();
if (fontSummary) {
  console.log("\nFont manifest sample");
  for (const entry of fontSummary.slice(0, 30)) {
    console.log(`  ${entry.route}: ${entry.fonts.join(", ") || "(none)"}`);
  }
}

const representativeDetails = REPRESENTATIVE_DETAIL_ROUTES.flatMap((route) => {
  const htmlPath = path.join(outDir, route, "index.html");
  const pageTxtFiles = collectFiles(path.join(outDir, route), (file) => file.includes("__PAGE__") && file.endsWith(".txt"));
  return [
    ...(existsSync(htmlPath)
      ? [{ kind: "html", route, rel: path.relative(root, htmlPath), size: statSync(htmlPath).size }]
      : []),
    ...pageTxtFiles.map((file) => ({ kind: "pageTxt", route, rel: file.rel, size: file.size })),
  ];
});

printTop("Representative stablecoin detail payloads", representativeDetails, 20);

// Eager first-load JS per representative detail route: every script chunk the
// page HTML references, gzip-summed. Catches per-route payload regressions the
// whole-build totals can't see (one oversized shared chunk costs ×403 pages).
const gzipSizeCache = new Map();
function gzipSizeOf(filePath) {
  if (!gzipSizeCache.has(filePath)) {
    gzipSizeCache.set(filePath, gzipSync(readFileSync(filePath)).byteLength);
  }
  return gzipSizeCache.get(filePath);
}

const representativeDetailEagerJs = REPRESENTATIVE_DETAIL_ROUTES.flatMap((route) => {
  const htmlPath = path.join(outDir, route, "index.html");
  if (!existsSync(htmlPath)) return [];
  const html = readFileSync(htmlPath, "utf8");
  const scriptSrcs = new Set(
    [...html.matchAll(/<script[^>]+src="(\/_next\/[^"]+\.js)"/g)].map((match) => match[1]),
  );
  let eagerGzipBytes = 0;
  let scriptCount = 0;
  for (const src of scriptSrcs) {
    const chunkPath = path.join(outDir, src.replace(/^\//, ""));
    if (!existsSync(chunkPath)) continue;
    eagerGzipBytes += gzipSizeOf(chunkPath);
    scriptCount += 1;
  }
  return [{ route, scriptCount, size: eagerGzipBytes, rel: `${route} (${scriptCount} scripts, gzip)` }];
});

printTop("Representative detail eager JS (gzip sum of referenced scripts)", representativeDetailEagerJs, 10);

if (check) {
  const failures = [];
  console.log("\nBudget checks");
  checkCountBudget("total out files", allOutFiles.length, budgets.totalOutFiles, failures);
  checkBudget("total JS chunks", sum(jsFiles), budgets.totalJsBytes, failures);
  checkBudget("largest JS chunk", jsFiles[0]?.size ?? 0, budgets.largestJsBytes, failures);
  checkBudget("total CSS chunks", sum(cssFiles), budgets.totalCssBytes, failures);
  checkBudget("largest CSS chunk gzip", cssFilesWithGzip[0]?.gzipSize ?? 0, budgets.largestCssGzipBytes, failures);
  checkBudget("total static media", sum(mediaFiles), budgets.totalStaticMediaBytes, failures);
  checkBudget("largest HTML file", htmlFiles[0]?.size ?? 0, budgets.largestHtmlBytes, failures);
  checkBudget("homepage HTML file", homepageHtmlSize, budgets.homepageHtmlBytes, failures);
  checkBudget("largest TXT/RSC helper", txtFiles[0]?.size ?? 0, budgets.largestTxtBytes, failures);

  for (const detail of representativeDetails) {
    const budget =
      detail.kind === "html" ? budgets.representativeDetailHtmlBytes : budgets.representativeDetailPageTxtBytes;
    checkBudget(`${detail.route} ${detail.kind}`, detail.size, budget, failures);
  }

  for (const detail of representativeDetailEagerJs) {
    checkBudget(
      `${detail.route} eager JS gzip`,
      detail.size,
      budgets.representativeDetailEagerJsGzipBytes,
      failures,
    );
  }

  if (failures.length > 0) {
    console.error("\n[build-size] Budget failures:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }
}
