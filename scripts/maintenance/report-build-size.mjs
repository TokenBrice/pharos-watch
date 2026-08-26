#!/usr/bin/env node

import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { formatBytes } from "../lib/format-bytes.mts";
import {
  countDocumentsReferencingChunks,
  projectStaticRouteCapacity,
  summarizeStaticRouteFamilies,
} from "../lib/static-export-capacity.mts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = new Set(process.argv.slice(2));
const check = args.has("--check");
const MINIMUM_FILE_HEADROOM_RATIO = 0.25;
const MAX_CLASSIC_ZOD_HTML_REFERENCE_RATIO = 0.75;
const CLASSIC_ZOD_CHUNK_MARKER = "_zod.traits";

// `totalOutFiles` is the only blocking gate: exceeding it means the Pages
// direct upload physically cannot ship. Every other entry below is a
// *reference* size — `--check` reports its delta to `$GITHUB_STEP_SUMMARY`
// and exits 0, so payload growth stays visible without turning a release
// into a budget-ratchet hotfix PR.
const DEFAULT_BUDGETS = {
  // Keep a conservative 20,000-file repo budget. Cloudflare's current paid
  // Pages limit can be higher, but Free and legacy Wrangler paths use 20,000.
  // App Router emits multiple RSC helper files per route, so check before deploy.
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
  // Keep this around 65 KiB to avoid false positives from production-only data
  // and feature-flag inlining while still enforcing a practical compressed CSS
  // ceiling on critical assets. Ratcheted after the June 2026 Telegram/Reserve
  // alert surface measured 67,186 bytes in local static-export validation;
  // production Pages live-data builds measured 67,222 bytes. The Figma chrome
  // and overview-table pass measured 68,415 bytes in local discovery; keep a
  // narrow post-ratchet ceiling with about 1 KiB of headroom for gzip variance.
  largestCssGzipBytes: 69_632,
  totalStaticMediaBytes: 2_000_000,
  // API-reference schema and route-contract growth measured 2,754,850 bytes
  // after adding listing-governance and identity-bound V9 contracts. Retain
  // about 15 KB of headroom while keeping future docs-heavy App Router payload
  // growth reviewable.
  largestHtmlBytes: 2_770_000,
  // Docs/API reference RSC helpers are the largest legitimate TXT payloads.
  // Safety Score v8.12 exposed bridge-route and oracle-risk report-card fields;
  // Yield source-role / alternate-summary contracts then pushed the generated
  // API reference helper to ~1.33 MB. Night Watch publication and recovery
  // contracts measured 1,350,636 bytes; the July 2026 API-reference expansion
  // dependency provenance contracts measured 1,380,021 bytes. The FORGE III
  // dark V9 consumer contracts (the versioned report-cards/v9 endpoint plus its
  // ReportCardsV9 schema and dependency-graph shape) then measured 1,391,012
  // bytes. Retain about 10 KB of headroom so the next public schema expansion
  // still has to re-ratchet deliberately.
  largestTxtBytes: 1_401_000,
  // Production Pages builds hydrate mirrors from live API data. USDC's detail
  // page now carries richer SEO JSON-LD plus the inline critical-CSS block
  // (~68 KB raw) that replaced the render-blocking global stylesheet, so the
  // ceiling sits above the ~253 KB optimized payload.
  representativeDetailHtmlBytes: 270_000,
  // Safety Score V9 fact/provenance surfaces raised the production USDT route
  // to 93,408 bytes, and the wave-1 curation release (block-pinned control
  // reviews, mechanism overlay evidence) lifts it to ~95,030. Keep the ceiling
  // intentionally narrow while leaving enough headroom for the representative
  // detail payloads to remain useful.
  representativeDetailPageTxtBytes: 97_500,
  // Sum of gzip sizes of every script chunk referenced by a representative
  // detail page's HTML — the eager first-load JS budget per route (Mythos
  // #50). Ratcheted from 810 KB after the chart-section deferral (P1-6/P1-5)
  // and the registry field-drop (P1-4 partial) landed: measured ~681 KB gz
  // per detail page. The code-health table/chart refactor stack shifted the
  // representative detail route to ~802 KiB gz. Keep this narrow so future
  // shared chunk growth still has to be ratcheted deliberately. The June 2026
  // client-registry/methodology-version expansion measured ~866 KiB per detail
  // route; keep a narrow post-ratchet ceiling.
  representativeDetailEagerJsGzipBytes: 905_000,
};

const BUDGET_ENV = {
  totalOutFiles: "PHAROS_SIZE_BUDGET_TOTAL_OUT_FILES",
  totalJsBytes: "PHAROS_SIZE_BUDGET_TOTAL_JS_BYTES",
  largestJsBytes: "PHAROS_SIZE_BUDGET_LARGEST_JS_BYTES",
  totalCssBytes: "PHAROS_SIZE_BUDGET_TOTAL_CSS_BYTES",
  largestCssGzipBytes: "PHAROS_SIZE_BUDGET_LARGEST_CSS_GZIP_BYTES",
  totalStaticMediaBytes: "PHAROS_SIZE_BUDGET_TOTAL_STATIC_MEDIA_BYTES",
  largestHtmlBytes: "PHAROS_SIZE_BUDGET_LARGEST_HTML_BYTES",
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

function checkCountBudget(label, actual, budget, failures) {
  const ok = actual <= budget;
  console.log(`${ok ? "ok" : "FAIL"} ${label}: ${actual} / ${budget}`);
  if (!ok) {
    failures.push(`${label} is ${actual}, budget is ${budget}`);
  }
}

function formatPercent(value) {
  return `${value.toFixed(1)}%`;
}

/**
 * Non-blocking delta against a reference size. `direction: "floor"` marks
 * metrics where higher is better (headroom); everything else is a ceiling.
 */
function referenceDelta(label, actual, reference, { format = formatBytes, direction = "ceiling" } = {}) {
  const delta = actual - reference;
  const within = direction === "floor" ? actual >= reference : actual <= reference;
  const ratio = reference !== 0 ? (delta / reference) * 100 : 0;
  const sign = delta > 0 ? "+" : delta < 0 ? "-" : "";
  return {
    label,
    actual: format(actual),
    reference: format(reference),
    delta: `${sign}${format(Math.abs(delta))} (${sign}${Math.abs(ratio).toFixed(1)}%)`,
    status: within ? "within" : "OVER",
  };
}

function writeStepSummary(rows) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  const lines = [
    "## Build size reference deltas",
    "",
    "Non-blocking. Only the Cloudflare 20,000-file direct-upload limit blocks a release.",
    "",
    "| Metric | Actual | Reference | Delta | |",
    "|---|---:|---:|---:|---|",
    ...rows.map(
      (row) => `| ${row.label} | ${row.actual} | ${row.reference} | ${row.delta} | ${row.status === "OVER" ? "⚠️" : ""} |`,
    ),
    "",
  ];
  appendFileSync(summaryPath, `${lines.join("\n")}\n`);
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
const routeFamilySummaries = summarizeStaticRouteFamilies(allOutFiles);
const classicZodChunkNames = jsFiles
  .filter((file) => readFileSync(file.path, "utf8").includes(CLASSIC_ZOD_CHUNK_MARKER))
  .map((file) => path.basename(file.path));
const classicZodHtmlReferenceCount = countDocumentsReferencingChunks(
  htmlFiles.map((file) => readFileSync(file.path, "utf8")),
  classicZodChunkNames,
);
const classicZodHtmlReferenceRatio = htmlFiles.length > 0 ? classicZodHtmlReferenceCount / htmlFiles.length : 0;

console.log("# Pharos Build Size Report");
console.log(`out total files: ${allOutFiles.length}`);
console.log(`out total raw size: ${formatBytes(sum(allOutFiles))}`);
console.log(`JS chunks: ${formatBytes(sum(jsFiles))} across ${jsFiles.length} files`);
console.log(`CSS chunks: ${formatBytes(sum(cssFiles))} across ${cssFiles.length} files`);
console.log(`static media: ${formatBytes(sum(mediaFiles))} across ${mediaFiles.length} files`);
console.log(`HTML: ${formatBytes(sum(htmlFiles))} across ${htmlFiles.length} files`);
console.log(`TXT/RSC helpers: ${formatBytes(sum(txtFiles))} across ${txtFiles.length} files`);
const overallCapacity = projectStaticRouteCapacity({
  totalFiles: allOutFiles.length,
  fileLimit: budgets.totalOutFiles,
  minimumHeadroomRatio: MINIMUM_FILE_HEADROOM_RATIO,
  averageFilesPerRoute: 1,
});
console.log(
  `direct-upload file headroom: ${overallCapacity.fileHeadroom} (${(overallCapacity.headroomRatio * 100).toFixed(1)}%)`,
);
console.log(
  `classic Zod HTML references: ${classicZodHtmlReferenceCount}/${htmlFiles.length} ` +
    `(${(classicZodHtmlReferenceRatio * 100).toFixed(1)}%) across ${classicZodChunkNames.length} chunk(s)`,
);

console.log("\nStatic route family capacity");
for (const family of routeFamilySummaries) {
  const projection = projectStaticRouteCapacity({
    totalFiles: allOutFiles.length,
    fileLimit: budgets.totalOutFiles,
    minimumHeadroomRatio: MINIMUM_FILE_HEADROOM_RATIO,
    averageFilesPerRoute: family.averageFilesPerRoute,
  });
  console.log(
    `  ${family.family}: ${family.routeCount} routes, ${family.fileCount} files, ${formatBytes(family.totalBytes)}; ` +
      `${family.averageFilesPerRoute.toFixed(1)} files/route, ${formatBytes(Math.round(family.averageBytesPerRoute))}/route; ` +
      `${projection.routesUntilHeadroomFloor} routes to 25% floor, ${projection.routesUntilHardLimit} to hard limit`,
  );
}

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
  const pageTxtFiles = collectFiles(
    path.join(outDir, route),
    (file) => file.includes("__PAGE__") && file.endsWith(".txt"),
  );
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
  const scriptSrcs = new Set([...html.matchAll(/<script[^>]+src="(\/_next\/[^"]+\.js)"/g)].map((match) => match[1]));
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
  console.log("\nDeploy gate (blocking)");
  checkCountBudget("total out files", allOutFiles.length, budgets.totalOutFiles, failures);

  const referenceRows = [
    referenceDelta(
      "direct-upload file headroom",
      overallCapacity.headroomRatio * 100,
      MINIMUM_FILE_HEADROOM_RATIO * 100,
      { format: formatPercent, direction: "floor" },
    ),
    referenceDelta(
      "classic Zod HTML references",
      classicZodHtmlReferenceRatio * 100,
      MAX_CLASSIC_ZOD_HTML_REFERENCE_RATIO * 100,
      { format: formatPercent },
    ),
    referenceDelta("total JS chunks", sum(jsFiles), budgets.totalJsBytes),
    referenceDelta("largest JS chunk", jsFiles[0]?.size ?? 0, budgets.largestJsBytes),
    referenceDelta("total CSS chunks", sum(cssFiles), budgets.totalCssBytes),
    referenceDelta("largest CSS chunk gzip", cssFilesWithGzip[0]?.gzipSize ?? 0, budgets.largestCssGzipBytes),
    referenceDelta("total static media", sum(mediaFiles), budgets.totalStaticMediaBytes),
    referenceDelta("largest HTML file", htmlFiles[0]?.size ?? 0, budgets.largestHtmlBytes),
    referenceDelta("largest TXT/RSC helper", txtFiles[0]?.size ?? 0, budgets.largestTxtBytes),
    ...representativeDetails.map((detail) =>
      referenceDelta(
        `${detail.route} ${detail.kind}`,
        detail.size,
        detail.kind === "html" ? budgets.representativeDetailHtmlBytes : budgets.representativeDetailPageTxtBytes,
      ),
    ),
    ...representativeDetailEagerJs.map((detail) =>
      referenceDelta(`${detail.route} eager JS gzip`, detail.size, budgets.representativeDetailEagerJsGzipBytes),
    ),
  ];

  console.log("\nSize reference deltas (report only)");
  for (const row of referenceRows) {
    console.log(`${row.status === "OVER" ? "OVER" : "  ok"} ${row.label}: ${row.actual} / ${row.reference} (${row.delta})`);
  }
  writeStepSummary(referenceRows);

  if (failures.length > 0) {
    console.error("\n[build-size] Deploy gate failures:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }
}
