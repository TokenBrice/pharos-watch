import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectCriticalCssPages,
  criticalCssWorkerCount,
  optimizeCriticalCssPages,
} from "../maintenance/inline-homepage-critical-css";

const temporaryRoots: string[] = [];
const stylesheet = ".home{color:red}.coin{color:blue}.yield{color:green}.dark{color-scheme:dark;--background:black}.unused{padding:2rem}";
const pageNames = [
  "index.html",
  "stablecoin/alpha/index.html",
  "stablecoin/alpha/yield/index.html",
  "stablecoin/beta/index.html",
  "stablecoin/beta/yield/index.html",
  "stablecoin/gamma/index.html",
  "stablecoin/delta/index.html",
  "depeg/index.html",
  "about/index.html",
  "stablecoin/alpha/history/index.html",
  "methodology/scoring/example/index.html",
  "digest/index.html",
  "digest/2026-10-25/index.html",
  "404.html",
  "archive/legacy.html",
  "admin-guide/index.html",
];

function fixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), "pharos-critical-css-"));
  temporaryRoots.push(root);
  const outDir = path.join(root, "out");
  const cssPath = path.join(outDir, "_next/static/css/app.css");
  mkdirSync(path.dirname(cssPath), { recursive: true });
  writeFileSync(cssPath, stylesheet);
  for (const name of [...pageNames, "admin/index.html", "admin/nested/index.html", "index.txt", "digest/feed.xml"]) {
    const file = path.join(outDir, name);
    mkdirSync(path.dirname(file), { recursive: true });
    const className = name === "index.html" ? "home" : name.includes("yield/") ? "yield" : "coin";
    writeFileSync(file, `<!DOCTYPE html><html><head><link rel="stylesheet" href="/_next/static/css/app.css"></head><body><main class="${className}">Page</main></body></html>`);
  }
  // A previously processed page must be skipped without adding another loader.
  writeFileSync(path.join(outDir, "stablecoin/beta/yield/index.html"),
    '<html><head><style>.yield{color:green}</style><link data-pharos-critical-css="async" rel="stylesheet" media="print" href="/_next/static/css/app.css"><script src="/critical-css-loader.js" defer></script></head><body class="yield">Processed</body></html>');
  return outDir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("critical CSS worker pool", () => {
  it("selects every public HTML page, including nested routes and digests, but excludes admin and non-HTML files", () => {
    const outDir = fixture();
    expect(collectCriticalCssPages(outDir)).toEqual(pageNames.map((name) => path.join(outDir, name)).sort());
  });

  it("bounds the default pool by available CPUs and pages, with a local override", () => {
    vi.stubEnv("PHAROS_CRITICAL_CSS_WORKERS", undefined);
    expect(criticalCssWorkerCount(7)).toBe(Math.max(1, Math.min(availableParallelism() - 1, 7)));
    vi.stubEnv("PHAROS_CRITICAL_CSS_WORKERS", "3");
    expect(criticalCssWorkerCount(7)).toBe(3);
    expect(criticalCssWorkerCount(2)).toBe(2);
    vi.stubEnv("PHAROS_CRITICAL_CSS_WORKERS", "1");
    expect(criticalCssWorkerCount(7)).toBe(1);
    vi.stubEnv("PHAROS_CRITICAL_CSS_WORKERS", "0");
    expect(() => criticalCssWorkerCount(7)).toThrow("PHAROS_CRITICAL_CSS_WORKERS must be a positive integer.");
  });

  it.each([1, 3])("propagates a page assertion failure without writing its invalid output (%i workers)", async (workers) => {
    const outDir = fixture();
    const brokenPath = path.join(outDir, "depeg/index.html");
    const broken = "<!DOCTYPE html><html><head></head><body>No stylesheet</body></html>";
    writeFileSync(brokenPath, broken);
    await expect(optimizeCriticalCssPages(outDir, collectCriticalCssPages(outDir), workers))
      .rejects.toThrow("out/depeg/index.html: Beasties did not inline a critical style block.");
    expect(readFileSync(brokenPath, "utf8")).toBe(broken);
  }, 20_000);

  it("keeps CSP inline-handler validation inside each worker", async () => {
    const outDir = fixture();
    const file = path.join(outDir, "depeg/index.html");
    const before = readFileSync(file, "utf8").replace('<main class="coin">', '<main class="coin" onclick="alert(1)">');
    writeFileSync(file, before);
    await expect(optimizeCriticalCssPages(outDir, collectCriticalCssPages(outDir), 3))
      .rejects.toThrow("out/depeg/index.html: contains an inline event handler outside <noscript>.");
    expect(readFileSync(file, "utf8")).toBe(before);
  }, 20_000);

  it("inlines non-profile pages with CSP-safe deferred CSS and leaves a rerun unchanged", async () => {
    const outDir = fixture();
    const pages = collectCriticalCssPages(outDir);
    await optimizeCriticalCssPages(outDir, pages, 3);
    const file = path.join(outDir, "depeg/index.html");
    const after = readFileSync(file, "utf8");
    expect(after).toContain("<style>");
    expect(after).toContain(".coin{color:blue}");
    expect(after).toContain(".dark{color-scheme:dark;--background:black}");
    expect(after).not.toContain(".unused");
    expect(after).toMatch(/<link\b[^>]*media="print"[^>]*data-pharos-critical-css="async"/);
    expect(after).toContain('<script src="/critical-css-loader.js" defer></script>');
    const withoutNoscript = after.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "");
    expect(withoutNoscript).not.toMatch(/\son[a-z]+\s*=/i);
    expect(withoutNoscript).not.toMatch(/<link\b(?=[^>]*rel="stylesheet")(?![^>]*media="print")[^>]*>/);
    const rerun = await optimizeCriticalCssPages(outDir, pages, 3);
    expect(rerun.every((result) => result.skipped)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(after);
    expect(readFileSync(path.join(outDir, "admin/index.html"), "utf8")).not.toContain("<style>");
    expect(readFileSync(path.join(outDir, "_next/static/css/app.css"), "utf8")).toBe(stylesheet);
  }, 20_000);
});
