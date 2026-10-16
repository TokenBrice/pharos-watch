import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import routes from "../../public/_routes.json";

const headersFile = readFileSync(resolve(process.cwd(), "public/_headers"), "utf8");
const redirectsFile = readFileSync(resolve(process.cwd(), "public/_redirects"), "utf8");

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
