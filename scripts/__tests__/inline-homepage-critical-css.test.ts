import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
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
    '<html><head><style>.yield{color:green}</style><link data-pharos-critical-css="async" rel="stylesheet" media="print" href="/_next/static/css/app.css"><script src="/critical-css-loader.js?v=2" defer></script></head><body class="yield">Processed</body></html>');
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

  it("inlines non-profile pages with CSP-safe async CSS and leaves a rerun unchanged", async () => {
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
    expect(after).toMatch(/data-pharos-critical-css="async"><script src="\/critical-css-loader.js\?v=2" async><\/script>/);
    const withoutNoscript = after.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "");
    expect(withoutNoscript).not.toMatch(/\son[a-z]+\s*=/i);
    expect(withoutNoscript).not.toMatch(/<link\b(?=[^>]*rel="stylesheet")(?![^>]*media="print")[^>]*>/);
    const rerun = await optimizeCriticalCssPages(outDir, pages, 3);
    expect(rerun.every((result) => result.skipped)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(after);
    expect(readFileSync(path.join(outDir, "admin/index.html"), "utf8")).not.toContain("<style>");
    expect(readFileSync(path.join(outDir, "_next/static/css/app.css"), "utf8")).toBe(stylesheet);
  }, 20_000);

  it("preserves functional-selector spacing, responsive rules, properties and cascade order", async () => {
    const outDir = fixture();
    const css = [
      "@layer theme,base,utilities;",
      "@layer theme{:root{--spacing:.25rem}}",
      "@layer base{:where(p){margin:0}}",
      "@layer utilities{",
      ":where(.space-y-2>:not(:last-child)){--tw-space-y-reverse:0;margin-block-end:calc(var(--spacing) * 2)}",
      "@media(min-width:40rem){:where(.sm\\:space-y-4>:not(:last-child)){margin-block-end:calc(var(--spacing) * 4)}}",
      ":is(.coin,.home)>p{line-height:1.5}",
      ".unused{padding:2rem}}",
      '@property --tw-space-y-reverse{syntax:"*";inherits:false;initial-value:0}',
    ].join("");
    writeFileSync(path.join(outDir, "_next/static/css/app.css"), css);
    const file = path.join(outDir, "depeg/index.html");
    writeFileSync(file, '<html><head><link rel="stylesheet" href="/_next/static/css/app.css"></head><body><main class="coin space-y-2 sm:space-y-4"><p>First</p><p>Second</p></main></body></html>');

    await optimizeCriticalCssPages(outDir, [file], 1);

    const after = readFileSync(file, "utf8");
    expect(after).toContain(`<style>${css.replace(".unused{padding:2rem}", "")}</style>`);
    expect(readFileSync(path.join(outDir, "_next/static/css/app.css"), "utf8")).toBe(css);
  });

  it.each(['<html lang="en">', '<html lang="en" class="font-sans">'])('retains only page-matched dark variants and restores %s', async (htmlTag) => {
    const outDir = fixture();
    const file = path.join(outDir, "depeg/index.html");
    writeFileSync(file, `${htmlTag}<head><link rel="stylesheet" href="/_next/static/css/app.css"></head><body class="coin dark:bg-muted"><main>Page</main></body></html>`);
    writeFileSync(path.join(outDir, "_next/static/css/app.css"), `${stylesheet}.dark\\:bg-muted:is(.dark *){background:black}.dark\\:bg-unused:is(.dark *){background:purple}`);

    await optimizeCriticalCssPages(outDir, [file], 1);

    const after = readFileSync(file, "utf8");
    expect(after).toContain(htmlTag);
    expect(after).toContain(".dark\\:bg-muted:is(.dark *){background:black}");
    expect(after).not.toContain("bg-unused");
  });

  it("rejects an existing deferred loader without writing the invalid output", async () => {
    const outDir = fixture();
    const file = path.join(outDir, "depeg/index.html");
    const before = readFileSync(file, "utf8").replace("</head>", '<script src="/critical-css-loader.js?v=2" defer></script></head>');
    writeFileSync(file, before);
    await expect(optimizeCriticalCssPages(outDir, [file], 1))
      .rejects.toThrow("without the CSP-safe async loader script");
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("keeps the client-mounted navigation sheet usable before the full stylesheet loads", async () => {
    const outDir = fixture();
    const file = path.join(outDir, "depeg/index.html");
    const chrome = ".inset-y-0{inset-block:0}.z-modal{z-index:50}.overflow-y-auto{overflow-y:auto}.grid-cols-2{grid-template-columns:repeat(2,minmax(0,1fr))}.data-\\[state\\=open\\]\\:slide-in-from-left[data-state=open]{--tw-enter-translate-x:-100%}.motion-reduce\\:data-\\[state\\=open\\]\\:animate-none[data-state=open]{animation:none}";
    writeFileSync(path.join(outDir, "_next/static/css/app.css"), stylesheet + chrome);

    await optimizeCriticalCssPages(outDir, [file], 1);

    const after = readFileSync(file, "utf8");
    expect(after).toContain(chrome);
    expect(after).not.toContain(".unused");
  });
});

describe("critical CSS browser loader", () => {
  it.each(["loading", "complete"])("activates loaded sheets immediately and retains the DOMContentLoaded fallback (%s)", (readyState) => {
    const cached = Object.assign(new EventTarget(), { sheet: {}, media: "print", dataset: { pharosCriticalCss: "async" } });
    const pending = Object.assign(new EventTarget(), { sheet: null, media: "print", dataset: { pharosCriticalCss: "async" } });
    const fallback = Object.assign(new EventTarget(), { sheet: null, media: "print", dataset: { pharosCriticalCss: "async" } });
    const document = Object.assign(new EventTarget(), {
      readyState,
      querySelectorAll: () => [cached, pending, fallback].filter((link) => link.dataset.pharosCriticalCss === "async"),
    });
    runInNewContext(readFileSync(new URL("../../public/critical-css-loader.js", import.meta.url), "utf8"), { document });

    expect(cached.media).toBe("all");
    expect(pending.media).toBe(readyState === "loading" ? "print" : "all");
    pending.dispatchEvent(new Event("load"));
    expect(pending.media).toBe("all");
    expect(pending.dataset.pharosCriticalCss).toBe("loaded");
    expect(fallback.media).toBe(readyState === "loading" ? "print" : "all");
    document.dispatchEvent(new Event("DOMContentLoaded"));
    expect(fallback.media).toBe("all");
    expect(fallback.dataset.pharosCriticalCss).toBe("loaded");
  });
});
