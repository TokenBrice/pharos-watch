#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = new Set(process.argv.slice(2));
const check = args.has("--check");

const DEFAULT_BUDGETS = {
  totalJsBytes: 12_000_000,
  largestJsBytes: 1_200_000,
  totalCssBytes: 650_000,
  totalStaticMediaBytes: 2_000_000,
  largestHtmlBytes: 2_200_000,
  largestTxtBytes: 1_250_000,
  representativeDetailHtmlBytes: 220_000,
  representativeDetailPageTxtBytes: 90_000,
};

const BUDGET_ENV = {
  totalJsBytes: "PHAROS_SIZE_BUDGET_TOTAL_JS_BYTES",
  largestJsBytes: "PHAROS_SIZE_BUDGET_LARGEST_JS_BYTES",
  totalCssBytes: "PHAROS_SIZE_BUDGET_TOTAL_CSS_BYTES",
  totalStaticMediaBytes: "PHAROS_SIZE_BUDGET_TOTAL_STATIC_MEDIA_BYTES",
  largestHtmlBytes: "PHAROS_SIZE_BUDGET_LARGEST_HTML_BYTES",
  largestTxtBytes: "PHAROS_SIZE_BUDGET_LARGEST_TXT_BYTES",
  representativeDetailHtmlBytes: "PHAROS_SIZE_BUDGET_DETAIL_HTML_BYTES",
  representativeDetailPageTxtBytes: "PHAROS_SIZE_BUDGET_DETAIL_PAGE_TXT_BYTES",
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

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && value >= 1024; i += 1) {
    value /= 1024;
    unit = units[i];
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${unit}`;
}

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
const mediaFiles = collectFiles(mediaDir);
const htmlFiles = collectFiles(outDir, (file) => file.endsWith(".html"));
const txtFiles = collectFiles(outDir, (file) => file.endsWith(".txt"));

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

if (check) {
  const failures = [];
  console.log("\nBudget checks");
  checkBudget("total JS chunks", sum(jsFiles), budgets.totalJsBytes, failures);
  checkBudget("largest JS chunk", jsFiles[0]?.size ?? 0, budgets.largestJsBytes, failures);
  checkBudget("total CSS chunks", sum(cssFiles), budgets.totalCssBytes, failures);
  checkBudget("total static media", sum(mediaFiles), budgets.totalStaticMediaBytes, failures);
  checkBudget("largest HTML file", htmlFiles[0]?.size ?? 0, budgets.largestHtmlBytes, failures);
  checkBudget("largest TXT/RSC helper", txtFiles[0]?.size ?? 0, budgets.largestTxtBytes, failures);

  for (const detail of representativeDetails) {
    const budget =
      detail.kind === "html" ? budgets.representativeDetailHtmlBytes : budgets.representativeDetailPageTxtBytes;
    checkBudget(`${detail.route} ${detail.kind}`, detail.size, budget, failures);
  }

  if (failures.length > 0) {
    console.error("\n[build-size] Budget failures:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }
}
