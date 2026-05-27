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
});
