import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import routes from "../../public/_routes.json";

const headersFile = readFileSync(resolve(process.cwd(), "public/_headers"), "utf8");
const redirectsFile = readFileSync(resolve(process.cwd(), "public/_redirects"), "utf8");

// Pages wildcards span slashes, including when followed by a literal suffix.
// https://developers.cloudflare.com/pages/functions/routing/#functions-invocation-routes
function invokesFunctions(path: string): boolean {
  const matches = (rule: string) => {
    const parts = rule.split("*");
    if (parts.length === 1) return path === rule;
    const first = parts[0];
    const last = parts[parts.length - 1];
    if (!path.startsWith(first) || !path.endsWith(last) || path.length < first.length + last.length) return false;
    let cursor = first.length;
    const end = path.length - last.length;
    for (const middle of parts.slice(1, -1)) {
      const found = path.indexOf(middle, cursor);
      if (found < 0 || found + middle.length > end) return false;
      cursor = found + middle.length;
    }
    return true;
  };
  return routes.include.some(matches) && !routes.exclude.some(matches);
}

function activeRedirectLines(): string[] {
  return redirectsFile
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function effectiveRedirect(path: string) {
  for (const line of activeRedirectLines()) {
    const [source, target, status] = line.split(/\s+/);
    const wildcard = source.indexOf("*");
    if (source === path || (wildcard >= 0 && path.startsWith(source.slice(0, wildcard)))) {
      return { target: target.replace(":splat", wildcard < 0 ? "" : path.slice(wildcard)), status: Number(status) };
    }
  }
  return null;
}

describe("Pages function routes", () => {
  it("routes document responses through middleware so nonce CSP is applied", () => {
    expect(routes.include).toContain("/*");
  });

  it("does not exclude static HTML route families from middleware nonce handling", () => {
    for (const path of ["/chains/*", "/stablecoin/*", "/stablecoins/*", "/compare/*", "/docs/*", "/methodology/*"]) {
      expect(routes.exclude).not.toContain(path);
    }
  });

  it("stays within the Pages invocation-rule limits", () => {
    const rules = [...routes.include, ...routes.exclude];
    expect(rules.length).toBeLessThanOrEqual(100);
    expect(rules.every((rule) => rule.startsWith("/") && rule.length <= 100)).toBe(true);
  });

  it.each([
    "/index.txt",
    "/__next._tree.txt",
    "/__next._head.txt",
    "/stablecoin/usyc-hashnote/index.txt",
    "/stablecoin/usyc-hashnote/__next._tree.txt",
    "/stablecoin/usyc-hashnote/yield/index.txt",
    "/api/index.txt",
    "/api/__next._tree.txt",
    "/api/__next._head.txt",
    "/critical-css-loader.js",
    "/media/defi-dad.jpg",
    "/openapi.json",
  ])("serves public static asset %s without Functions", (path) => {
    expect(invokesFunctions(path)).toBe(false);
  });

  it.each([
    "/",
    "/stablecoin/usyc-hashnote/",
    "/stablecoin/237/",
    "/stablecoin/usyc-hashnote/yield/",
    "/api/",
    "/api/admin/status",
    "/api/admin/index.txt",
    "/api/other.txt",
    "/__nextX_tree.txt",
    "/admin",
    "/admin/",
    "/admin/index.txt",
    "/admin/__next._tree.txt",
    "/admin-api/",
    "/admin-api/index.txt",
    "/admin-api/__next._tree.txt",
    "/safety-scores/map.png",
    "/safety-scores/map.webp",
    "/safety-scores/map.json",
    "/social-posts/2026-10-18.png",
    "/social-posts/2026-10-18.json",
    "/selector-snapshot/example",
  ])("retains middleware, redirects or Function-backed handling for %s", (path) => {
    expect(invokesFunctions(path)).toBe(true);
  });

});

describe("Pages static headers", () => {
  it("keeps private operator HTML out of the static fallback cache", () => {
    expect(headersFile).toContain(
      "/admin/*\n  X-Robots-Tag: noindex, nofollow\n  ! Cache-Control\n  Cache-Control: private, no-store",
    );
    expect(headersFile).toContain(
      "/admin-api/*\n  X-Robots-Tag: noindex, nofollow\n  ! Cache-Control\n  Cache-Control: private, no-store",
    );
  });

  it("keeps chain route HTML out of immutable asset cache rules", () => {
    expect(headersFile).not.toMatch(/^\/chains\/\*\s*$/m);
    expect(headersFile).toContain(
      "/chains/*.png\n  ! Cache-Control\n  Cache-Control: public, max-age=604800, immutable",
    );
    expect(headersFile).toContain(
      "/chains/*.svg\n  ! Cache-Control\n  Cache-Control: public, max-age=604800, immutable",
    );
  });

});

describe("Pages legacy redirects", () => {
  it.each([
    ["/report-cards", "/safety-scores/"],
    ["/report-cards/usdc/", "/safety-scores/usdc/"],
    ["/risk-lab/", "/safety-scores/"],
    ["/stability-index-alt", "/stability-index/"],
    ["/mica", "/compliance/"],
    ["/mica/", "/compliance/"],
    ["/mica/archive/", "/compliance/archive/"],
  ])("resolves the first active redirect for %s", (path, target) => {
    expect(effectiveRedirect(path)).toEqual({ target, status: 301 });
  });

});
