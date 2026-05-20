/**
 * Generate one PDF per methodology version under
 * `public/methodology/pdf/<key>-v<version>.pdf`, plus a current
 * `public/methodology/pdf/index.pdf` snapshot of the methodology index.
 *
 * Uses Playwright Chromium print-to-PDF (Firefox does not implement page.pdf()).
 * Page renders use `@media print` CSS from globals.css; no URL flag is required —
 * page.pdf() automatically emulates print media.
 *
 * Pipeline (postbuild lane, after `next build` populates `out/`):
 *   1. Boot the existing static-export server on a free port.
 *   2. For each methodology surface, navigate and capture `page.pdf()` with
 *      header/footer templates that carry the Pharos URN.
 *   3. Write to `public/methodology/pdf/<file>`.
 *
 * Modes:
 *   default          - generate PDFs into public/methodology/pdf/
 *   --check          - regenerate into a temp dir, compare rendered-text
 *                      manifest and coarse size vs. committed PDFs; exit
 *                      non-zero on drift
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH, BLACKLIST_TRACKER_METHODOLOGY_VERSION } from "../../shared/lib/blacklist-tracker-version";
import { CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH, CHAIN_HEALTH_METHODOLOGY_VERSION } from "../../shared/lib/chain-health-version";
import { formatPharosUrn } from "../../shared/lib/citation/urn";
import { DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH, DEPEG_DEWS_METHODOLOGY_VERSION } from "../../shared/lib/depeg-dews-version";
import { LIQUIDITY_METHODOLOGY_CHANGELOG_PATH, LIQUIDITY_METHODOLOGY_VERSION } from "../../shared/lib/liquidity-score-version";
import { MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH, MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL } from "../../shared/lib/mint-burn-flow-version";
import { PRICING_PIPELINE_CHANGELOG_PATH, PRICING_PIPELINE_VERSION } from "../../shared/lib/pricing-pipeline-version";
import { SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH, SAFETY_SCORE_VERSION } from "../../shared/lib/safety-score-version";
import { PSI_METHODOLOGY_CHANGELOG_PATH, PSI_METHODOLOGY_VERSION } from "../../shared/lib/stability-index-version";
import { YIELD_METHODOLOGY_CHANGELOG_PATH, YIELD_METHODOLOGY_VERSION } from "../../shared/lib/yield-methodology-version";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..", "..");
const PDF_OUTPUT_DIR = path.join(REPO_ROOT, "public", "methodology", "pdf");
const MANIFEST_FILENAME = "manifest.json";
const SITE_BASE_URL = "https://pharos.watch";
const DEFAULT_PDF_BUDGETS = {
  totalPdfBytes: 25 * 1024 * 1024,
  largestPdfBytes: 5 * 1024 * 1024,
} as const;
const PDF_SIZE_DRIFT_TOLERANCE_RATIO = 0.2;
const PDF_SIZE_DRIFT_TOLERANCE_FLOOR_BYTES = 8192;
const PDF_BUDGET_ENV = {
  totalPdfBytes: "PHAROS_SIZE_BUDGET_METHODOLOGY_PDF_TOTAL_BYTES",
  largestPdfBytes: "PHAROS_SIZE_BUDGET_METHODOLOGY_PDF_LARGEST_BYTES",
} as const;

interface MethodologySurface {
  /** Stable key used in the PDF filename. */
  key: string;
  /** Methodology version string (no leading "v"). Optional for the index. */
  version: string | null;
  /** Path under `/methodology/` to navigate to. Trailing slash required. */
  path: string;
  /** Human-readable title for the PDF header. */
  title: string;
}

/** 1 index + 9 versioned changelog surfaces. */
const METHODOLOGY_SURFACES: readonly MethodologySurface[] = [
  {
    key: "index",
    version: null,
    path: "/methodology/",
    title: "Pharos Methodology Index",
  },
  {
    key: "scoring",
    version: SAFETY_SCORE_VERSION,
    path: SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH,
    title: "Safety Scores Changelog",
  },
  {
    key: "depeg-dews",
    version: DEPEG_DEWS_METHODOLOGY_VERSION,
    path: DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
    title: "Depeg Tracker and DEWS Changelog",
  },
  {
    key: "blacklist-tracker",
    version: BLACKLIST_TRACKER_METHODOLOGY_VERSION,
    path: BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH,
    title: "Blacklist Tracker Changelog",
  },
  {
    key: "liquidity-score",
    version: LIQUIDITY_METHODOLOGY_VERSION,
    path: LIQUIDITY_METHODOLOGY_CHANGELOG_PATH,
    title: "Liquidity Score Changelog",
  },
  {
    key: "stability-index",
    version: PSI_METHODOLOGY_VERSION,
    path: PSI_METHODOLOGY_CHANGELOG_PATH,
    title: "Stability Index (PSI) Changelog",
  },
  {
    key: "mint-burn-flow",
    // The mint-burn-flow module exports only *_LABEL ("v6.11"); strip the prefix.
    version: MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL.replace(/^v/, ""),
    path: MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH,
    title: "Mint/Burn Flow Changelog",
  },
  {
    key: "yield",
    version: YIELD_METHODOLOGY_VERSION,
    path: YIELD_METHODOLOGY_CHANGELOG_PATH,
    title: "Yield Intelligence Changelog",
  },
  {
    key: "pricing-pipeline",
    version: PRICING_PIPELINE_VERSION,
    path: PRICING_PIPELINE_CHANGELOG_PATH,
    title: "Pricing Pipeline Changelog",
  },
  {
    key: "chain-health",
    version: CHAIN_HEALTH_METHODOLOGY_VERSION,
    path: CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH,
    title: "Chain Health Changelog",
  },
];

function pdfFilenameFor(surface: MethodologySurface): string {
  if (surface.version === null) return `${surface.key}.pdf`;
  return `${surface.key}-v${surface.version}.pdf`;
}

function urnFor(surface: MethodologySurface): string {
  if (surface.version === null) return formatPharosUrn("methodology", surface.key);
  return formatPharosUrn("methodology", surface.key, `v${surface.version}`);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildHeaderTemplate(surface: MethodologySurface): string {
  const versionLine = surface.version ? ` &middot; v${escapeHtml(surface.version)}` : "";
  return [
    `<div style="width:100%;padding:0 0.5in;font-size:8px;color:#6b7280;`,
    `font-family:'Helvetica Neue',Arial,sans-serif;display:flex;justify-content:space-between;">`,
    `<span>Pharos &middot; Methodology &middot; ${escapeHtml(surface.title)}${versionLine}</span>`,
    `<span class="date"></span>`,
    `</div>`,
  ].join("");
}

function buildFooterTemplate(surface: MethodologySurface): string {
  const urn = urnFor(surface);
  const canonicalUrl = `${SITE_BASE_URL}${surface.path}`;
  return [
    `<div style="width:100%;padding:0 0.5in;font-size:7px;color:#6b7280;`,
    `font-family:'Helvetica Neue',Arial,sans-serif;display:flex;justify-content:space-between;gap:1em;">`,
    `<span>${escapeHtml(urn)}</span>`,
    `<span>${escapeHtml(canonicalUrl)}</span>`,
    `<span><span class="pageNumber"></span> / <span class="totalPages"></span></span>`,
    `</div>`,
  ].join("");
}

interface GenerationResult {
  surface: MethodologySurface;
  filename: string;
  bytes: number;
  textHash: string;
  textLength: number;
}

interface PdfFileSize {
  filename: string;
  bytes: number;
}

interface MethodologyPdfManifestEntry {
  filename: string;
  key: string;
  path: string;
  title: string;
  version: string | null;
  urn: string;
  textHash: string;
  textLength: number;
}

interface MethodologyPdfManifest {
  schemaVersion: 1;
  generatedBy: string;
  entries: MethodologyPdfManifestEntry[];
}

function resolveBudget(key: keyof typeof DEFAULT_PDF_BUDGETS): number {
  const raw = process.env[PDF_BUDGET_ENV[key]];
  if (!raw) return DEFAULT_PDF_BUDGETS[key];
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_PDF_BUDGETS[key];
}

function formatBytes(bytes: number): string {
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

function collectCommittedPdfSizes(): PdfFileSize[] {
  return readdirSync(PDF_OUTPUT_DIR)
    .filter((name) => name.endsWith(".pdf"))
    .map((filename) => ({
      filename,
      bytes: statSync(path.join(PDF_OUTPUT_DIR, filename)).size,
    }))
    .sort((a, b) => b.bytes - a.bytes || a.filename.localeCompare(b.filename));
}

function assertPdfBudgets(label: string, files: readonly PdfFileSize[]): string[] {
  const budgets = {
    totalPdfBytes: resolveBudget("totalPdfBytes"),
    largestPdfBytes: resolveBudget("largestPdfBytes"),
  };
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  const largest = files[0]?.bytes ?? 0;
  const failures: string[] = [];

  if (total > budgets.totalPdfBytes) {
    failures.push(
      `${label}: total methodology PDFs are ${formatBytes(total)}, budget is ${formatBytes(budgets.totalPdfBytes)}`,
    );
  }
  if (largest > budgets.largestPdfBytes) {
    failures.push(
      `${label}: largest methodology PDF is ${formatBytes(largest)}, budget is ${formatBytes(budgets.largestPdfBytes)}`,
    );
  }

  return failures;
}

async function loadChromium() {
  const { chromium } = await import("playwright");
  const executablePath = chromium.executablePath();

  if (existsSync(executablePath)) {
    return chromium;
  }

  throw new Error(
    `Playwright Chromium is not installed at ${executablePath}. Run \`npx playwright install chromium\` before ` +
      "`npm run check:methodology-pdfs`; CI should provision it through setup-workspace.",
  );
}

function normalizeRenderedText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function buildManifest(results: readonly GenerationResult[]): MethodologyPdfManifest {
  return {
    schemaVersion: 1,
    generatedBy: "scripts/maintenance/generate-methodology-pdfs.ts",
    entries: results
      .map((result) => ({
        filename: result.filename,
        key: result.surface.key,
        path: result.surface.path,
        title: result.surface.title,
        version: result.surface.version,
        urn: urnFor(result.surface),
        textHash: result.textHash,
        textLength: result.textLength,
      }))
      .sort((a, b) => a.filename.localeCompare(b.filename)),
  };
}

function manifestPath(outputDir: string): string {
  return path.join(outputDir, MANIFEST_FILENAME);
}

function writeManifest(outputDir: string, results: readonly GenerationResult[]): void {
  writeFileSync(manifestPath(outputDir), `${JSON.stringify(buildManifest(results), null, 2)}\n`);
}

function readManifest(outputDir: string): MethodologyPdfManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath(outputDir), "utf8")) as MethodologyPdfManifest;
    return parsed.schemaVersion === 1 && Array.isArray(parsed.entries) ? parsed : null;
  } catch {
    return null;
  }
}

function compareManifests(committed: MethodologyPdfManifest | null, fresh: MethodologyPdfManifest): string[] {
  if (!committed) {
    return [`${MANIFEST_FILENAME}: missing or invalid committed methodology PDF manifest`];
  }

  const failures: string[] = [];
  const committedByFilename = new Map(committed.entries.map((entry) => [entry.filename, entry]));
  const freshFilenames = new Set(fresh.entries.map((entry) => entry.filename));

  for (const entry of fresh.entries) {
    const expected = committedByFilename.get(entry.filename);
    if (!expected) {
      failures.push(`${MANIFEST_FILENAME}: missing committed manifest entry for ${entry.filename}`);
      continue;
    }

    for (const key of ["key", "path", "title", "version", "urn", "textHash", "textLength"] as const) {
      if (expected[key] !== entry[key]) {
        failures.push(`${entry.filename}: manifest ${key} drift (committed=${expected[key]}, fresh=${entry[key]})`);
      }
    }
  }

  for (const entry of committed.entries) {
    if (!freshFilenames.has(entry.filename)) {
      failures.push(`${MANIFEST_FILENAME}: stale committed manifest entry for ${entry.filename}`);
    }
  }

  return failures;
}

async function generateAll(outputDir: string): Promise<GenerationResult[]> {
  const { createStaticExportServer } = await import("./serve-static-export.mjs");
  const chromium = await loadChromium();

  const server = createStaticExportServer({ port: 0, host: "127.0.0.1" });
  await server.listen();
  const address = server.server.address();
  const resolvedPort = address && typeof address === "object" ? address.port : server.port;
  const baseUrl = `http://${server.host}:${resolvedPort}`;

  console.log(`[generate-methodology-pdfs] static export served at ${baseUrl}`);

  const browser = await chromium.launch({ headless: true });
  const results: GenerationResult[] = [];

  try {
    mkdirSync(outputDir, { recursive: true });
    const context = await browser.newContext({ viewport: { width: 1024, height: 1366 } });
    // Force light theme for PDF rendering. `next-themes` reads from
    // localStorage.theme on mount; seeding it before navigation avoids the
    // dark-default flash and yields a coherent white-paper look. Combined
    // with emulateMedia({ colorScheme: 'light' }) so `prefers-color-scheme`
    // also reports light if any component branches on it.
    await context.addInitScript(() => {
      try {
        window.localStorage.setItem("theme", "light");
      } catch {}
    });

    for (const surface of METHODOLOGY_SURFACES) {
      const page = await context.newPage();
      const filename = pdfFilenameFor(surface);
      const target = path.join(outputDir, filename);
      const url = `${baseUrl}${surface.path}`;

      console.log(`[generate-methodology-pdfs] ${url} -> ${filename}`);

      await page.emulateMedia({ colorScheme: "light" });
      await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
      // Belt-and-braces: if next-themes already mounted before the init
      // script took effect (it shouldn't), force the dark class off here.
      await page.evaluate(() => {
        document.documentElement.classList.remove("dark");
        document.documentElement.classList.add("light");
        document.documentElement.style.colorScheme = "light";
      });
      const renderedText = normalizeRenderedText(await page.evaluate(() => document.body?.innerText ?? ""));
      // page.pdf() emulates `print` media automatically; no manual switch needed.
      const buffer = await page.pdf({
        format: "Letter",
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: buildHeaderTemplate(surface),
        footerTemplate: buildFooterTemplate(surface),
        margin: { top: "0.6in", bottom: "0.55in", left: "0.5in", right: "0.5in" },
      });

      writeFileSync(target, buffer);
      results.push({
        surface,
        filename,
        bytes: buffer.byteLength,
        textHash: sha256Text(renderedText),
        textLength: renderedText.length,
      });
      await page.close();
    }

    await context.close();
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) => {
      server.server.close((error: Error | undefined) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  writeManifest(outputDir, results);
  return results;
}

async function runCheck(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "pharos-methodology-pdfs-"));
  try {
    const generated = await generateAll(tmpRoot);
    const failures: string[] = [];
    failures.push(...compareManifests(readManifest(PDF_OUTPUT_DIR), buildManifest(generated)));

    for (const result of generated) {
      const committedPath = path.join(PDF_OUTPUT_DIR, result.filename);
      let committedStat;
      try {
        committedStat = statSync(committedPath);
      } catch {
        failures.push(`${result.filename}: missing committed PDF at ${committedPath}`);
        continue;
      }
      const sizeDelta = Math.abs(committedStat.size - result.bytes);
      // PDF pagination/byte output varies across runner font stacks. The text
      // manifest above is the freshness contract; size remains a coarse guard.
      const tolerance = Math.max(PDF_SIZE_DRIFT_TOLERANCE_FLOOR_BYTES, committedStat.size * PDF_SIZE_DRIFT_TOLERANCE_RATIO);
      if (sizeDelta > tolerance) {
        failures.push(
          `${result.filename}: size drift ${sizeDelta} bytes exceeds ${Math.round(tolerance)} byte tolerance (committed=${committedStat.size}, fresh=${result.bytes})`,
        );
      }
    }

    failures.push(...assertPdfBudgets("committed", collectCommittedPdfSizes()));
    failures.push(...assertPdfBudgets("fresh", generated));

    if (failures.length > 0) {
      console.error("[generate-methodology-pdfs --check] drift detected:");
      for (const failure of failures) {
        console.error(`  ${failure}`);
      }
      process.exitCode = 1;
    } else {
      console.log(`[generate-methodology-pdfs --check] ${generated.length} PDFs stable`);
    }
  } finally {
    await rm(tmpRoot, { force: true, recursive: true });
  }
}

async function runGenerate(): Promise<void> {
  const generated = await generateAll(PDF_OUTPUT_DIR);

  console.log(`[generate-methodology-pdfs] wrote ${generated.length} PDF(s) to ${path.relative(REPO_ROOT, PDF_OUTPUT_DIR)}/`);
  // Surface a summary of generated files for CI logs.
  const committed = readdirSync(PDF_OUTPUT_DIR).filter((name) => name.endsWith(".pdf"));
  for (const name of committed.sort()) {
    const size = statSync(path.join(PDF_OUTPUT_DIR, name)).size;

    console.log(`  ${name}\t${size} bytes`);
  }
  const failures = assertPdfBudgets("generated", generated);
  if (failures.length > 0) {
    console.error("[generate-methodology-pdfs] PDF budget failures:");
    for (const failure of failures) {
      console.error(`  ${failure}`);
    }
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  if (args.has("--check")) {
    await runCheck();
  } else {
    await runGenerate();
  }
}

if (path.resolve(process.argv[1] ?? "") === SCRIPT_PATH) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export { generateAll, METHODOLOGY_SURFACES, pdfFilenameFor, urnFor };
