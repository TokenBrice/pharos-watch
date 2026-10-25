import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { PUBLIC_ROUTE_PATHS } from "../../../src/lib/public-route-inventory";

const SCRIPT = resolve(process.cwd(), "scripts/maintenance/report-build-size.mjs");
const ZOD_CHUNK = "out/_next/static/chunks/framework-zod.js";
const PAGE_CHUNK = "out/_next/static/chunks/page-abc.js";
const CSS_BUNDLE = "out/_next/static/css/app.css";
const DETAIL_ROUTE = "out/stablecoin/usdc-circle";
const SEARCH_WIDTH_UTILITY = ".xl\\:w-\\[15rem\\]{width:15rem}";
const SHELL_HTML = '<!doctype html><html><body><script src="/_next/static/chunks/framework-zod.js"></script></body></html>';
const DETAIL_HTML = '<!doctype html><html><body><script src="/_next/static/chunks/page-abc.js"></script></body></html>';
const PROSE_ROUTES = PUBLIC_ROUTE_PATHS
  .filter((href) => /^\/(?:privacy|about|methodology|stablecoins|status)\/$|^\/api\/(?:reference\/)?$|^\/docs\//.test(href))
  .map((href) => href.slice(1, -1));
const BUDGET_ROUTES = ["depeg", "safety-scores", "stablecoins", "status", "screener", "portfolio"];
const REQUIRED_ROUTES = [...new Set([...PROSE_ROUTES, ...BUDGET_ROUTES])];
const HTML_FILES = 2 + REQUIRED_ROUTES.length;
const OUT_FILES = 8 + REQUIRED_ROUTES.length;

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
// Highly compressible, so its gzip size sits far below its raw size.
const CEMETERY_HTML = `<!doctype html><html><body>${"x".repeat(2_000)}</body></html>`;
const CEMETERY_FLIGHT_BYTES = 400;

const tempDirs: string[] = [];

/**
 * Minimal static export: shell/detail HTML plus required prose documents (only
 * the shell loads classic Zod), a CSS bundle, a media asset, RSC helpers, and one
 * stablecoin detail route with its `__PAGE__` payload.
 */
function syntheticBuild({
  css = SEARCH_WIDTH_UTILITY.padEnd(CSS_BYTES, "\n"),
  extraFiles = {},
}: { css?: string; extraFiles?: Record<string, string> } = {}): string {
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
    ...Object.fromEntries(REQUIRED_ROUTES.map((route) => [`out/${route}/index.html`, ""])),
    ...extraFiles,
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
    expect(result.stdout).toContain(`out total files: ${OUT_FILES}`);
    // Required empty prose documents add file count without changing raw bytes.
    expect(result.stdout).toContain("out total raw size: 1.31 KiB");
    expect(result.stdout).toContain(`JS chunks: ${JS_BYTES} B across 2 files`);
    expect(result.stdout).toContain(`CSS chunks: ${CSS_BYTES} B across 1 files`);
    expect(result.stdout).toContain(`static media: ${MEDIA_BYTES} B across 1 files`);
    expect(result.stdout).toContain(`HTML: ${HTML_BYTES} B across ${HTML_FILES} files`);
    expect(result.stdout).toContain(`TXT/RSC helpers: ${TXT_BYTES} B across 2 files`);
    expect(result.stdout).toContain("Font manifest sample\n  /layout: static/media/inter.woff2");
  });


  it("fails the deploy gate when the build exceeds the direct-upload file limit", () => {
    const result = runReport(syntheticBuild(), { budgets: { PHAROS_SIZE_BUDGET_TOTAL_OUT_FILES: "3" } });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`FAIL total out files: ${OUT_FILES} / 3`);
    expect(result.stderr).toContain(`- total out files is ${OUT_FILES}, budget is 3`);
  });

  it("fails the deploy gate when the compiled CSS lost the desktop search width utility", () => {
    const result = runReport(syntheticBuild({ css: ".sm\\:w-full{width:100%}".padEnd(CSS_BYTES, "\n") }));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("compiled CSS is missing the desktop search width utility");
  });

  it("blocks an exceeded named payload byte ceiling and identifies its asset", () => {
    const result = runReport(syntheticBuild(), { budgets: { PHAROS_SIZE_BUDGET_LARGEST_JS_BYTES: "100" } });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("OVER largest JS chunk: 500 B / 100 B (+400 B (+400.0%); blocking)");
    expect(result.stderr).toContain(
      `largest JS chunk exceeds its byte ceiling (500 B / 100 B); responsible: ${ZOD_CHUNK}`,
    );
    expect(result.stepSummary).toContain(
      "| largest JS chunk | 500 B | 100 B | +400 B (+400.0%) | blocking | ⚠️ |",
    );
    expect(result.stepSummary).toContain(
      `| largest HTML file | ${SHELL_HTML.length} B | 2.64 MiB |`,
    );
    expect(result.stepSummary).toContain(
      "File headroom and classic-Zod reach are advisory diagnostics.",
    );
    expect(result.stepSummary).toContain(
      `| classic Zod HTML references | ${(100 / HTML_FILES).toFixed(1)}% | 75.0% |`,
    );
  });

  it("gates /cemetery/ on its own raw HTML, gzip HTML and RSC flight ceilings", () => {
    const build = syntheticBuild({
      extraFiles: {
        "out/cemetery/index.html": CEMETERY_HTML,
        "out/cemetery/index.txt": "cemetery-flight".padEnd(CEMETERY_FLIGHT_BYTES, "0"),
      },
    });
    const result = runReport(build, {
      budgets: {
        PHAROS_SIZE_BUDGET_CEMETERY_HTML_BYTES: "1000",
        PHAROS_SIZE_BUDGET_CEMETERY_HTML_GZIP_BYTES: "1000",
        PHAROS_SIZE_BUDGET_CEMETERY_FLIGHT_BYTES: "100",
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("- cemetery html exceeds its byte ceiling");
    expect(result.stderr).toContain("responsible: out/cemetery/index.html (html)");
    expect(result.stdout).toContain("  ok cemetery html gzip:");
    expect(result.stderr).not.toContain("cemetery html gzip exceeds");
    expect(result.stderr).toContain(
      `- cemetery RSC flight exceeds its byte ceiling (${CEMETERY_FLIGHT_BYTES} B / 100 B); `
      + "responsible: out/cemetery/index.txt (RSC flight)",
    );
  });

  it.each(PROSE_ROUTES)(
    "blocks homepage and chart scripts leaking into /%s/",
    (route) => {
      const forbiddenScripts = route === "status"
        ? ["/_next/static/chunks/recharts-vendor-abcd.js"]
        : ["/_next/static/chunks/app/page-abcd.js", "/_next/static/chunks/recharts-vendor-abcd.js"];
      for (const src of forbiddenScripts) {
        const build = syntheticBuild({ extraFiles: { [`out/${route}/index.html`]: `<script src="${src}"></script>` } });
        const result = runReport(build);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`/${route}/ must not reference homepage/chart script: ${src}`);
      }
    },
  );

  it("does not confuse an ordinary prose page chunk with the root homepage chunk", () => {
    const build = syntheticBuild({ extraFiles: {
      "out/privacy/index.html": '<script src="/_next/static/chunks/app/privacy/page-abcd.js"></script>',
    } });
    expect(runReport(build).status).toBe(0);
  });
  it.each(["api", "api/reference", ...PROSE_ROUTES.filter((route) => route.startsWith("docs/"))])(
    "fails closed when required /%s/ HTML is missing",
    (route) => {
      const build = syntheticBuild();
      rmSync(join(build, "out", route, "index.html"));
      const result = runReport(build);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`/${route}/ expected prose HTML is missing: out/${route}/index.html`);
    },
  );

  it("does not apply prose chart exclusions to deliberate chart-bearing routes", () => {
    const build = syntheticBuild({ extraFiles: {
      "out/stability-index/index.html": '<script src="/_next/static/chunks/recharts-vendor-abcd.js"></script>',
    } });
    expect(runReport(build).status).toBe(0);
  });

  it("enforces independent homepage HTML and referenced-script gzip ceilings with env overrides", () => {
    const build = syntheticBuild();
    const html = runReport(build, { budgets: { PHAROS_SIZE_BUDGET_HOME_HTML_BYTES: "10" } });
    expect(html.status).toBe(1);
    expect(html.stderr).toContain("home html exceeds its byte ceiling");
    expect(html.stepSummary).toContain("| home html |");
    const js = runReport(build, { budgets: { PHAROS_SIZE_BUDGET_HOME_EAGER_JS_GZIP_BYTES: "1" } });
    expect(js.status).toBe(1);
    expect(js.stderr).toContain("home eager JS gzip exceeds its byte ceiling");
    expect(js.stepSummary).toContain("| home eager JS gzip |");
    expect(runReport(build).status).toBe(0);
  });

  it("counts a duplicate homepage script reference once", () => {
    const build = syntheticBuild({ extraFiles: { "out/index.html": SHELL_HTML + SHELL_HTML } });
    const result = runReport(build);
    expect(result.stdout).toContain("(1 scripts, gzip)");
    expect(result.status).toBe(0);
  });

  it("counts URL-encoded dynamic-route chunk paths", () => {
    const build = syntheticBuild({ extraFiles: {
      [`${DETAIL_ROUTE}/index.html`]: '<script src="/_next/static/chunks/app/stablecoin/%5Bid%5D/page-abc.js"></script>',
      "out/_next/static/chunks/app/stablecoin/[id]/page-abc.js": 'console.log("detail");',
    } });
    const result = runReport(build, { budgets: { PHAROS_SIZE_BUDGET_DETAIL_EAGER_JS_GZIP_BYTES: "1" } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("stablecoin/usdc-circle eager JS gzip exceeds its byte ceiling");
    expect(result.stderr).toContain("stablecoin/usdc-circle (1 scripts, gzip)");
  });

  it.each(BUDGET_ROUTES)("enforces the /%s/ eager-script gzip budget", (route) => {
    const build = syntheticBuild({ extraFiles: { [`out/${route}/index.html`]: SHELL_HTML + SHELL_HTML } });
    const result = runReport(build, {
      budgets: { [`PHAROS_SIZE_BUDGET_${route.toUpperCase().replaceAll("-", "_")}_EAGER_JS_GZIP_BYTES`]: "1" },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${route} eager JS gzip exceeds its byte ceiling`);
    expect(result.stderr).toContain(`${route} (1 scripts, gzip)`);
    expect(result.stepSummary).toContain(`| ${route} eager JS gzip |`);
    expect(runReport(build).status).toBe(0);
  });

  it.each(BUDGET_ROUTES)("fails closed when budgeted /%s/ HTML is missing", (route) => {
    const build = syntheticBuild();
    rmSync(join(build, "out", route, "index.html"));
    const result = runReport(build);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`/${route}/ expected budgeted HTML is missing`);
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
