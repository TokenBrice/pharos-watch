import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = resolve(process.cwd(), "scripts/maintenance/report-build-size.mjs");
const ZOD_CHUNK = "out/_next/static/chunks/framework-zod.js";
const PAGE_CHUNK = "out/_next/static/chunks/page-abc.js";
const CSS_BUNDLE = "out/_next/static/css/app.css";
const DETAIL_ROUTE = "out/stablecoin/usdc-circle";
const SEARCH_WIDTH_UTILITY = ".xl\\:w-\\[15rem\\]{width:15rem}";
const SHELL_HTML = '<!doctype html><html><body><script src="/_next/static/chunks/framework-zod.js"></script></body></html>';
const DETAIL_HTML = '<!doctype html><html><body><script src="/_next/static/chunks/page-abc.js"></script></body></html>';

// Fixed payload sizes so the reported byte totals are derived, not guessed.
const ZOD_CHUNK_BYTES = 500;
const PAGE_CHUNK_BYTES = 200;
const CSS_BYTES = 300;
const MEDIA_BYTES = 64;
const SHELL_TXT_BYTES = 32;
const DETAIL_TXT_BYTES = 48;
const JS_BYTES = ZOD_CHUNK_BYTES + PAGE_CHUNK_BYTES;
const HTML_BYTES = SHELL_HTML.length + DETAIL_HTML.length;
const TXT_BYTES = SHELL_TXT_BYTES + DETAIL_TXT_BYTES;
const DETAIL_ROUTE_BYTES = DETAIL_HTML.length + DETAIL_TXT_BYTES;

const tempDirs: string[] = [];

/**
 * Minimal static export: two HTML documents (only one loads the classic Zod
 * chunk), a CSS bundle, a media asset, RSC helpers, and one representative
 * stablecoin detail route with its `__PAGE__` payload.
 */
function syntheticBuild({ css = SEARCH_WIDTH_UTILITY.padEnd(CSS_BYTES, "\n") } = {}): string {
  const buildRoot = mkdtempSync(join(tmpdir(), "report-build-size-"));
  tempDirs.push(buildRoot);
  const files: Record<string, string> = {
    ".next/server/next-font-manifest.json": JSON.stringify({
      app: { "/layout": [{ path: "static/media/inter.woff2" }] },
    }),
    [CSS_BUNDLE]: css,
    [PAGE_CHUNK]: 'console.log("page");'.padEnd(PAGE_CHUNK_BYTES, "y"),
    "out/_next/static/media/inter.woff2": "font-bytes".padEnd(MEDIA_BYTES, "0"),
    "out/index.html": SHELL_HTML,
    "out/index.txt": "rsc-helper".padEnd(SHELL_TXT_BYTES, "0"),
    [ZOD_CHUNK]: "globalThis._zod={};/* _zod.traits */".padEnd(ZOD_CHUNK_BYTES, "x"),
    [`${DETAIL_ROUTE}/index.html`]: DETAIL_HTML,
    [`${DETAIL_ROUTE}/usdc-circle.__PAGE__.txt`]: "detail-payload".padEnd(DETAIL_TXT_BYTES, "0"),
  };

  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = join(buildRoot, relativePath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  return buildRoot;
}

function runReport(buildRoot: string, { budgets = {}, check = true }: {
  budgets?: Record<string, string>;
  check?: boolean;
} = {}) {
  const summaryPath = join(buildRoot, "step-summary.md");
  writeFileSync(summaryPath, "");
  const result = spawnSync(process.execPath, check ? [SCRIPT, "--check"] : [SCRIPT], {
    cwd: buildRoot,
    encoding: "utf8",
    env: { ...process.env, GITHUB_STEP_SUMMARY: summaryPath, ...budgets },
  });
  return { ...result, stepSummary: readFileSync(summaryPath, "utf8") };
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("report-build-size", () => {
  it("reports the payload inventory measured from the generated build", () => {
    const result = runReport(syntheticBuild());

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("out total files: 8");
    // 1343 raw bytes across the eight emitted files, reported in scaled units.
    expect(result.stdout).toContain("out total raw size: 1.31 KiB");
    expect(result.stdout).toContain(`JS chunks: ${JS_BYTES} B across 2 files`);
    expect(result.stdout).toContain(`CSS chunks: ${CSS_BYTES} B across 1 files`);
    expect(result.stdout).toContain(`static media: ${MEDIA_BYTES} B across 1 files`);
    expect(result.stdout).toContain(`HTML: ${HTML_BYTES} B across 2 files`);
    expect(result.stdout).toContain(`TXT/RSC helpers: ${TXT_BYTES} B across 2 files`);
    expect(result.stdout).toContain("Font manifest sample\n  /layout: static/media/inter.woff2");
  });

  it("attributes only the documents that load the classic Zod chunk", () => {
    const result = runReport(syntheticBuild());

    expect(result.stdout).toContain("classic Zod HTML references: 1/2 (50.0%) across 1 chunk(s)");
    expect(result.stdout).toContain("  ok classic Zod HTML references: 50.0% / 75.0%");
  });

  it("projects detail-route capacity and eager first-load JS for the representative route", () => {
    const result = runReport(syntheticBuild());

    expect(result.stdout).toContain(
      `stablecoin-detail: 1 routes, 2 files, ${DETAIL_ROUTE_BYTES} B;`
      + ` 2.0 files/route, ${DETAIL_ROUTE_BYTES} B/route;`,
    );
    expect(result.stdout).toContain(`${DETAIL_ROUTE}/usdc-circle.__PAGE__.txt`);
    expect(result.stdout).toMatch(/\d+ B {2}stablecoin\/usdc-circle \(1 scripts, gzip\)/);
    expect(result.stdout).toContain("  ok stablecoin/usdc-circle eager JS gzip:");
  });

  it("reports compressed CSS beside its raw size", () => {
    const result = runReport(syntheticBuild());
    const compressed = new RegExp(String.raw`(\d+) B gzip\s+${CSS_BYTES} B raw\s+${CSS_BUNDLE}`).exec(result.stdout);

    expect(compressed).not.toBeNull();
    expect(Number(compressed?.[1])).toBeLessThan(CSS_BYTES);
  });

  it("fails the deploy gate when the build exceeds the direct-upload file limit", () => {
    const result = runReport(syntheticBuild(), { budgets: { PHAROS_SIZE_BUDGET_TOTAL_OUT_FILES: "3" } });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("FAIL total out files: 8 / 3");
    expect(result.stderr).toContain("- total out files is 8, budget is 3");
  });

  it("fails the deploy gate when the compiled CSS lost the desktop search width utility", () => {
    const result = runReport(syntheticBuild({ css: ".sm\\:w-full{width:100%}".padEnd(CSS_BYTES, "\n") }));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("compiled CSS is missing the desktop search width utility");
  });

  it("marks an exceeded reference budget in the job summary without failing the release", () => {
    const result = runReport(syntheticBuild(), { budgets: { PHAROS_SIZE_BUDGET_LARGEST_JS_BYTES: "100" } });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OVER largest JS chunk: 500 B / 100 B (+400 B (+400.0%))");
    expect(result.stepSummary).toContain("| largest JS chunk | 500 B | 100 B | +400 B (+400.0%) | ⚠️ |");
    expect(result.stepSummary).toContain(`| largest HTML file | ${SHELL_HTML.length} B | 2.64 MiB |`);
    expect(result.stepSummary).not.toContain("| largest HTML file | 102 B | 2.64 MiB | -2.64 MiB (-100.0%) | ⚠️ |");
  });

  it("blocks a --check run with no build and stays advisory without it", () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), "report-build-size-empty-"));
    tempDirs.push(emptyRoot);

    const gated = runReport(emptyRoot, { check: true });
    const advisory = runReport(emptyRoot, { check: false });

    expect(existsSync(join(emptyRoot, "out"))).toBe(false);
    expect(gated.status).toBe(1);
    expect(gated.stderr).toContain("[build-size] Missing out/. Run npm run build first.");
    expect(advisory.status).toBe(0);
  });
});
