import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import routes from "../../public/_routes.json";

const headersFile = readFileSync(resolve(process.cwd(), "public/_headers"), "utf8");
const redirectsFile = readFileSync(resolve(process.cwd(), "public/_redirects"), "utf8");

function headerDirective(name: string): string {
  return (
    headersFile
      .match(/^  Content-Security-Policy: (.+)$/m)?.[1]
      ?.split(";")
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith(`${name} `)) ?? ""
  );
}

function activeRedirectLines(): string[] {
  return redirectsFile
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

describe("Pages function routes", () => {
  it("routes document responses through middleware so nonce CSP is applied", () => {
    expect(routes.include).toContain("/*");
  });

  it("does not exclude static HTML route families from middleware nonce handling", () => {
    expect(routes.exclude).not.toEqual(
      expect.arrayContaining([
        "/chains/*",
        "/stablecoin/*",
        "/stablecoins/*",
        "/compare/*",
        "/docs/*",
        "/methodology/*",
      ]),
    );
  });

  it("keeps static asset prefixes out of function routing", () => {
    expect(routes.exclude).toEqual(
      expect.arrayContaining(["/_next/*", "/logos/*", "/dexes/*", "/featured/*"]),
    );
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

  it("allows analytics image beacons in static Pages CSP", () => {
    const imgSrc = headerDirective("img-src");

    expect(imgSrc).toContain("https://www.googletagmanager.com");
    expect(imgSrc).toContain("https://*.googletagmanager.com");
  });
});

describe("Pages legacy redirects", () => {
  it("normalizes retired report-card and stability routes to slash canonical targets", () => {
    const lines = activeRedirectLines();

    expect(lines).toEqual(
      expect.arrayContaining([
        "/report-cards /safety-scores/ 301",
        "/report-cards/ /safety-scores/ 301",
        "/report-cards/* /safety-scores/:splat 301",
        "/risk-lab /safety-scores/ 301",
        "/risk-lab/ /safety-scores/ 301",
        "/risk-lab/* /safety-scores/:splat 301",
        "/stability-index-alt /stability-index/ 301",
        "/stability-index-alt/ /stability-index/ 301",
        "/stability-index-alt/* /stability-index/:splat 301",
      ]),
    );
    expect(lines).not.toEqual(
      expect.arrayContaining([
        "/report-cards /safety-scores 301",
        "/risk-lab /safety-scores 301",
        "/stability-index-alt /stability-index 301",
      ]),
    );
  });

  it("redirects retired MiCA tracker URLs to the canonical compliance page", () => {
    const lines = activeRedirectLines();

    expect(lines).toEqual(
      expect.arrayContaining([
        "/mica/* /compliance/:splat 301",
        "/mica/ /compliance/ 301",
        "/mica /compliance/ 301",
      ]),
    );
    expect(lines).not.toEqual(
      expect.arrayContaining([
        "/mica /compliance 301",
        "/mica/ /compliance 301",
      ]),
    );
  });

  it("redirects retired Tape URLs to the canonical timeline page", () => {
    const lines = activeRedirectLines();

    expect(lines).toEqual(
      expect.arrayContaining([
        "/tape/* /timeline/:splat 301",
        "/tape/ /timeline/ 301",
        "/tape /timeline/ 301",
      ]),
    );
  });

  it("redirects retired blacklist URLs to the canonical Freezewatch page", () => {
    const lines = activeRedirectLines();

    expect(lines).toEqual(
      expect.arrayContaining([
        "/blacklist/* /freezewatch/:splat 301",
        "/blacklist/ /freezewatch/ 301",
        "/blacklist /freezewatch/ 301",
      ]),
    );
  });

  it("preserves consolidated depeg incidents and canonical comparison ordering", () => {
    const lines = activeRedirectLines();

    expect(lines).toEqual(
      expect.arrayContaining([
        "/compare/pyusd-paypal-vs-usdc-circle/ /compare/usdc-circle-vs-pyusd-paypal/ 301",
        "/depeg/apxusd-2026-06-03/ /depeg/apxusd-2026-06-02/ 301",
        "/depeg/apxusd-2026-06-05/ /depeg/apxusd-2026-06-02/ 301",
        "/depeg/apxusd-2026-06-16/ /depeg/apxusd-2026-06-02/ 301",
      ]),
    );
  });

  it("collapses the retired PUSD numeric alias directly to coverage", () => {
    const lines = activeRedirectLines();

    expect(lines).toEqual(
      expect.arrayContaining([
        "/stablecoin/341/ /coverage/ 301",
        "/stablecoin/341 /coverage/ 301",
      ]),
    );
  });
});
