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
const stylesheet = ".home{color:red}.coin{color:blue}.yield{color:green}.unused{padding:2rem}";
const pageNames = [
  "index.html",
  "stablecoin/alpha/index.html",
  "stablecoin/alpha/yield/index.html",
  "stablecoin/beta/index.html",
  "stablecoin/beta/yield/index.html",
  "stablecoin/gamma/index.html",
  "stablecoin/delta/index.html",
];

function fixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), "pharos-critical-css-"));
  temporaryRoots.push(root);
  const outDir = path.join(root, "out");
  const cssPath = path.join(outDir, "_next/static/css/app.css");
  mkdirSync(path.dirname(cssPath), { recursive: true });
  writeFileSync(cssPath, stylesheet);
  for (const name of [...pageNames, "about/index.html", "stablecoin/alpha/history/index.html"]) {
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

  it("processes every selected page once across uneven partitions with identical HTML and untouched CSS", async () => {
    vi.stubEnv("BEASTIES_LOG_LEVEL", "error");
    const sequential = fixture();
    const parallel = fixture();
    const paths = collectCriticalCssPages(parallel);
    expect(paths.map((file) => path.relative(parallel, file))).toEqual([...pageNames].sort());
    const ignoredNames = ["about/index.html", "stablecoin/alpha/history/index.html"];
    const ignoredBefore = ignoredNames.map((name) => readFileSync(path.join(parallel, name), "utf8"));
    const skippedPath = path.join(parallel, "stablecoin/beta/yield/index.html");
    const skippedBefore = readFileSync(skippedPath, "utf8");
    const singleResults = await optimizeCriticalCssPages(sequential, collectCriticalCssPages(sequential), 1);
    const poolResults = await optimizeCriticalCssPages(parallel, [...paths].reverse(), 3);

    expect(poolResults).toEqual(singleResults);
    expect(poolResults.map((result) => result.label)).toEqual([...pageNames].sort().map((name) => `out/${name}`));
    expect(new Set(poolResults.map((result) => result.label)).size).toBe(pageNames.length);
    for (const name of pageNames) {
      expect(readFileSync(path.join(parallel, name))).toEqual(readFileSync(path.join(sequential, name)));
    }
    const homepage = readFileSync(path.join(parallel, "index.html"), "utf8");
    expect(homepage).toContain('<style>');
    expect(homepage).toContain('data-pharos-critical-css="async"');
    expect(homepage).toContain('src="/critical-css-loader.js"');
    expect(homepage.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "")).not.toMatch(/\sonload=/i);
    expect(readFileSync(skippedPath, "utf8")).toBe(skippedBefore);
    expect(poolResults.find((result) => result.label === "out/stablecoin/beta/yield/index.html")?.skipped).toBe(true);
    expect(ignoredNames.map((name) => readFileSync(path.join(parallel, name), "utf8"))).toEqual(ignoredBefore);
    for (const outDir of [sequential, parallel]) {
      expect(readFileSync(path.join(outDir, "_next/static/css/app.css"), "utf8")).toBe(stylesheet);
    }
  }, 20_000);

  it.each([1, 3])("propagates a page assertion failure without writing its invalid output (%i workers)", async (workers) => {
    const outDir = fixture();
    const brokenPath = path.join(outDir, "index.html");
    const broken = "<!DOCTYPE html><html><head></head><body>No stylesheet</body></html>";
    writeFileSync(brokenPath, broken);
    await expect(optimizeCriticalCssPages(outDir, collectCriticalCssPages(outDir), workers))
      .rejects.toThrow("out/index.html: Beasties did not inline a critical style block.");
    expect(readFileSync(brokenPath, "utf8")).toBe(broken);
  }, 20_000);

  it("keeps CSP inline-handler validation inside each worker", async () => {
    const outDir = fixture();
    const file = path.join(outDir, "stablecoin/alpha/index.html");
    const before = readFileSync(file, "utf8").replace('<main class="coin">', '<main class="coin" onclick="alert(1)">');
    writeFileSync(file, before);
    await expect(optimizeCriticalCssPages(outDir, collectCriticalCssPages(outDir), 3))
      .rejects.toThrow("out/stablecoin/alpha/index.html: contains an inline event handler outside <noscript>.");
    expect(readFileSync(file, "utf8")).toBe(before);
  }, 20_000);
});
