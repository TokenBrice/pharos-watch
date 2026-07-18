import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  collectSeoStaticCheckResult,
  findPublishedArchiveContinuityErrors,
} from "../ci/check-seo-static.mjs";

const roots: string[] = [];
const BASELINE_HEADERS = `/*
  Cache-Control: public, max-age=0, must-revalidate

/*.txt
  X-Robots-Tag: noindex, nofollow

/stablecoin/*/yield/
  X-Robots-Tag: noindex, follow

/stablecoin/*/yield/*
  X-Robots-Tag: noindex, follow

/llms.txt
  ! X-Robots-Tag

/openapi.json
  X-Robots-Tag: noindex, follow

/datasets/*.json
  X-Robots-Tag: noindex, follow

/datasets/*.csv
  X-Robots-Tag: noindex, follow

/datasets/*.ndjson
  X-Robots-Tag: noindex, follow

/sheets/*.csv
  X-Robots-Tag: noindex, follow

/postman/*.json
  X-Robots-Tag: noindex, follow
`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function makeOutDir() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pharos-seo-static-"));
  roots.push(root);
  await writeFile(path.join(root, "_headers"), BASELINE_HEADERS);
  return root;
}

function pageUrl(route: string) {
  return `https://pharos.watch${route === "/" ? "/" : route}`;
}

function pagePath(root: string, route: string) {
  return route === "/" ? path.join(root, "index.html") : path.join(root, route.slice(1), "index.html");
}

async function writePage(
  root: string,
  route: string,
  {
    h1 = "Test page",
    links = [],
    mainText = "Static body text for a crawlable page.",
    robots = [],
    googleBotRobots = [],
    ogType = "website",
    canonical = pageUrl(route),
    title = `${h1} | Pharos`,
    description = `${h1} description`,
    extraHead = "",
    quote = '"',
  }: {
    h1?: string;
    links?: string[];
    mainText?: string;
    robots?: string[];
    googleBotRobots?: string[];
    ogType?: string | null;
    canonical?: string | null;
    title?: string;
    description?: string;
    extraHead?: string;
    quote?: '"' | "'";
  } = {},
) {
  const filePath = pagePath(root, route);
  await mkdir(path.dirname(filePath), { recursive: true });
  const robotsTags = robots.map((content) => `<meta name="robots" content="${content}"/>`).join("");
  const googleBotTags = googleBotRobots.map((content) => `<meta name="googlebot" content="${content}"/>`).join("");
  const linkTags = links.map((href) => `<a href=${quote}${href}${quote}>${href}</a>`).join("");
  const ogTypeTag = ogType ? `<meta property="og:type" content="${ogType}"/>` : "";
  const canonicalTag = canonical ? `<link rel="canonical" href="${canonical}"/>` : "";
  await writeFile(
    filePath,
    `<!doctype html>
<html>
  <head>
    <title>${title}</title>
    <meta name="description" content="${description}"/>
    ${robotsTags}
    ${googleBotTags}
    ${canonicalTag}
    <meta property="og:title" content="${h1}"/>
    <meta property="og:description" content="${h1} description"/>
    ${ogTypeTag}
    <meta name="twitter:card" content="summary_large_image"/>
    ${extraHead}
  </head>
  <body>
    <main>
      <h1>${h1}</h1>
      ${linkTags}
      <p>${mainText}</p>
    </main>
  </body>
</html>`,
  );
}

async function writeSitemap(root: string, routes: string[]) {
  await writeFile(
    path.join(root, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset>${routes.map((route) => `<url><loc>${pageUrl(route)}</loc></url>`).join("")}</urlset>`,
  );
}

function collectFixtureSeoResult(root: string) {
  return collectSeoStaticCheckResult({
    outDir: root,
    enforceGooglePreviewDirectives: false,
    enforceSnippetQuality: false,
    enforceStructuredDataMatrix: false,
  });
}

function jsonLdScript(data: unknown) {
  return `<script type="application/ld+json">${JSON.stringify(data)}</script>`;
}

async function writeBaselinePages(root: string, rootLinks: string[] = []) {
  await writePage(root, "/", { h1: "Home", links: ["/stability-index/", ...rootLinks] });
  await writePage(root, "/stability-index/", { h1: "Stability Index" });
}

describe("check-seo-static", () => {
  it("rejects a previously published archive URL that disappears without a canonical redirect", () => {
    const previous = `
      <urlset>
        <url><loc>https://pharos.watch/digest/2026-07-17/</loc></url>
        <url><loc>https://pharos.watch/depeg/apxusd-2026-06-16/</loc></url>
      </urlset>`;
    const current = `
      <urlset>
        <url><loc>https://pharos.watch/digest/2026-07-17/</loc></url>
        <url><loc>https://pharos.watch/depeg/apxusd-2026-06-02/</loc></url>
      </urlset>`;

    expect(findPublishedArchiveContinuityErrors(previous, current)).toEqual([
      "published archive URLs missing from the current sitemap without a direct 301 to a submitted URL: https://pharos.watch/depeg/apxusd-2026-06-16/",
    ]);
  });

  it("accepts an explicit one-hop consolidation into a submitted archive URL", () => {
    const previous =
      "<urlset><url><loc>https://pharos.watch/depeg/apxusd-2026-06-16/</loc></url></urlset>";
    const current =
      "<urlset><url><loc>https://pharos.watch/depeg/apxusd-2026-06-02/</loc></url></urlset>";

    expect(
      findPublishedArchiveContinuityErrors(previous, current, [
        {
          source: "/depeg/apxusd-2026-06-16/",
          destination: "/depeg/apxusd-2026-06-02/",
          status: "301",
        },
      ]),
    ).toEqual([]);
  });

  it("fails invalid application/ld+json blocks", async () => {
    const root = await makeOutDir();
    await writePage(root, "/", {
      h1: "Home",
      links: ["/stability-index/"],
      extraHead: '<script type="application/ld+json">{"@context":"https://schema.org",}</script>',
    });
    await writePage(root, "/stability-index/", { h1: "Stability Index" });
    await writeSitemap(root, ["/", "/stability-index/"]);

    const result = collectFixtureSeoResult(root);

    expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining("/: invalid JSON-LD block #1")]));
  });

  it("fails site-data URLs inside indexable structured data only", async () => {
    const root = await makeOutDir();
    await writeBaselinePages(root, ["/compare/"]);
    await writePage(root, "/compare/", {
      h1: "Compare",
      robots: ["noindex, follow"],
      extraHead:
        '<script type="application/ld+json">{"@context":"https://schema.org","contentUrl":"https://pharos.watch/_site-data/noindex"}</script>',
    });
    await writePage(root, "/stablecoin/usdt-tether/", {
      h1: "Tether",
      mainText: "Useful stablecoin detail text ".repeat(20),
      extraHead:
        '<script type="application/ld+json">{"@context":"https://schema.org","distribution":[{"contentUrl":"https://pharos.watch/_site-data/stablecoin/usdt-tether"}]}</script>',
    });
    await writeSitemap(root, ["/", "/stability-index/", "/stablecoin/usdt-tether/"]);

    const result = collectFixtureSeoResult(root);

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "/stablecoin/usdt-tether/: structured data URL points under /_site-data/ at $.distribution[0].contentUrl",
        ),
      ]),
    );
    expect(result.errors.some((error) => error.startsWith("/compare/: structured data URL"))).toBe(false);
  });

  it("fails missing og:type on indexable pages", async () => {
    const root = await makeOutDir();
    await writePage(root, "/", { h1: "Home", links: ["/stability-index/"], ogType: null });
    await writePage(root, "/stability-index/", { h1: "Stability Index" });
    await writeSitemap(root, ["/", "/stability-index/"]);

    const result = collectFixtureSeoResult(root);

    expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining("/: missing og:type")]));
  });

  it("fails indexable pages with titles or descriptions outside the search-snippet envelope", async () => {
    const root = await makeOutDir();
    await writePage(root, "/", {
      h1: "Home",
      links: ["/stability-index/"],
      title: "Tiny | Pharos",
      description: "Too short.",
    });
    await writePage(root, "/stability-index/", {
      h1: "Stability Index",
      title: "This Stability Index Title Is Deliberately Too Long For The Static Search Snippet Envelope | Pharos",
      description:
        "This description is deliberately much longer than the envelope used by Pharos because it keeps adding terms until the static SEO check catches it as snippet bloat, prevents vague search results, and asks the author to tighten the value proposition.",
    });
    await writeSitemap(root, ["/", "/stability-index/"]);

    const result = collectSeoStaticCheckResult({
      outDir: root,
      enforceStructuredDataMatrix: false,
    });

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/: <title> is too short for search snippets"),
        expect.stringContaining("/: meta description is too short for search snippets"),
        expect.stringContaining("/stability-index/: <title> is too long for search snippets"),
        expect.stringContaining("/stability-index/: meta description is too long for search snippets"),
      ]),
    );
  });

  it("does not apply search-snippet length checks to noindex pages", async () => {
    const root = await makeOutDir();
    await writePage(root, "/", {
      h1: "Home",
      links: ["/compare/"],
      title: "Stablecoin Analytics Dashboard: Risk, Pegs & Liquidity | Pharos",
      description:
        "Track stablecoin risk, peg health, liquidity, supply, freeze controls, safety scores, and market structure across the Pharos dashboard.",
    });
    await writePage(root, "/compare/", {
      h1: "Compare",
      robots: ["noindex, follow"],
      title: "Tiny",
      description: "Short.",
    });
    await writeSitemap(root, ["/"]);

    const result = collectSeoStaticCheckResult({
      outDir: root,
      enforceStructuredDataMatrix: false,
    });

    expect(result.errors.some((error) => error.includes("/compare/: <title> is too short"))).toBe(false);
    expect(result.errors.some((error) => error.includes("/compare/: meta description is too short"))).toBe(false);
  });

  it("fails indexable pages without Google preview directives", async () => {
    const root = await makeOutDir();
    await writePage(root, "/", {
      h1: "Home",
      links: ["/stability-index/"],
      title: "Stablecoin Analytics Dashboard: Risk, Pegs & Liquidity | Pharos",
      description:
        "Track stablecoin risk, peg health, liquidity, supply, freeze controls, safety scores, and market structure across the Pharos dashboard.",
    });
    await writePage(root, "/stability-index/", {
      h1: "Stability Index",
      title: "Pharos Stability Index: Stablecoin Market Stress | Pharos",
      description:
        "Monitor stablecoin market stress through PSI, depeg breadth, severity, liquidity, safety signals, and historical stability-index context.",
      googleBotRobots: ["index, follow, max-snippet:-1, max-image-preview:large"],
    });
    await writeSitemap(root, ["/", "/stability-index/"]);

    const result = collectSeoStaticCheckResult({
      outDir: root,
      enforceStructuredDataMatrix: false,
    });

    expect(result.errors).toEqual(
      expect.arrayContaining([
        "/: missing Google preview directive max-snippet:-1",
        "/: missing Google preview directive max-image-preview:large",
        "/: missing Google preview directive max-video-preview:-1",
        "/stability-index/: missing Google preview directive max-video-preview:-1",
      ]),
    );
  });

  it("accepts Google preview directives from robots or googlebot tags", async () => {
    const root = await makeOutDir();
    await writePage(root, "/", {
      h1: "Home",
      links: ["/stability-index/"],
      title: "Stablecoin Analytics Dashboard: Risk, Pegs & Liquidity | Pharos",
      description:
        "Track stablecoin risk, peg health, liquidity, supply, freeze controls, safety scores, and market structure across the Pharos dashboard.",
      googleBotRobots: ["index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1"],
    });
    await writePage(root, "/stability-index/", {
      h1: "Stability Index",
      title: "Pharos Stability Index: Stablecoin Market Stress | Pharos",
      description:
        "Monitor stablecoin market stress through PSI, depeg breadth, severity, liquidity, safety signals, and historical stability-index context.",
      robots: ["index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1"],
    });
    await writeSitemap(root, ["/", "/stability-index/"]);

    const result = collectSeoStaticCheckResult({
      outDir: root,
      enforceStructuredDataMatrix: false,
    });

    expect(result.errors.some((error) => error.includes("missing Google preview directive"))).toBe(false);
  });

  it("does not require Google preview directives on noindex pages", async () => {
    const root = await makeOutDir();
    await writePage(root, "/", {
      h1: "Home",
      links: ["/compare/"],
      title: "Stablecoin Analytics Dashboard: Risk, Pegs & Liquidity | Pharos",
      description:
        "Track stablecoin risk, peg health, liquidity, supply, freeze controls, safety scores, and market structure across the Pharos dashboard.",
      googleBotRobots: ["index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1"],
    });
    await writePage(root, "/compare/", {
      h1: "Compare",
      robots: ["noindex, follow"],
      title: "Compare",
      description: "Short.",
    });
    await writeSitemap(root, ["/"]);

    const result = collectSeoStaticCheckResult({
      outDir: root,
      enforceStructuredDataMatrix: false,
    });

    expect(result.errors.some((error) => error.includes("/compare/: missing Google preview directive"))).toBe(false);
  });

  it("fails same-origin og:image / twitter:image references that point at a missing file", async () => {
    const root = await makeOutDir();
    await writePage(root, "/", {
      h1: "Home",
      links: ["/stability-index/"],
      extraHead:
        '<meta property="og:image" content="https://pharos.watch/og-missing.png"/><meta name="twitter:image" content="/og-missing.png"/>',
    });
    await writePage(root, "/stability-index/", { h1: "Stability Index" });
    await writeSitemap(root, ["/", "/stability-index/"]);

    const result = collectFixtureSeoResult(root);

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/: og:image references missing file /og-missing.png"),
        expect.stringContaining("/: twitter:image references missing file /og-missing.png"),
      ]),
    );
  });

  it("passes when same-origin og:image references an existing file in out/", async () => {
    const root = await makeOutDir();
    await writeFile(path.join(root, "og-card.png"), "");
    await writePage(root, "/", {
      h1: "Home",
      links: ["/stability-index/"],
      extraHead:
        '<meta property="og:image" content="https://pharos.watch/og-card.png"/><meta name="twitter:image" content="/og-card.png"/>',
    });
    await writePage(root, "/stability-index/", { h1: "Stability Index" });
    await writeSitemap(root, ["/", "/stability-index/"]);

    const result = collectFixtureSeoResult(root);

    expect(result.errors.some((error) => error.includes("references missing file"))).toBe(false);
  });

  it("skips external og:image hosts (dynamic /api/og/* worker route)", async () => {
    const root = await makeOutDir();
    await writePage(root, "/", {
      h1: "Home",
      links: ["/stability-index/"],
      extraHead:
        '<meta property="og:image" content="https://api.pharos.watch/api/og/stablecoin/usdt-tether"/><meta name="twitter:image" content="https://api.pharos.watch/api/og/stablecoin/usdt-tether"/>',
    });
    await writePage(root, "/stability-index/", { h1: "Stability Index" });
    await writeSitemap(root, ["/", "/stability-index/"]);

    const result = collectFixtureSeoResult(root);

    expect(result.errors.some((error) => error.includes("references missing file"))).toBe(false);
  });

  it("allows noindex pages to omit canonical", async () => {
    const root = await makeOutDir();
    await writePage(root, "/", { h1: "Home", links: ["/stability-index/"] });
    await writePage(root, "/stability-index/", { h1: "Stability Index" });
    await writePage(root, "/404/", {
      h1: "Not Found",
      robots: ["noindex, follow"],
      canonical: null,
    });
    await writeSitemap(root, ["/", "/stability-index/"]);

    const result = collectFixtureSeoResult(root);

    expect(result.errors.some((error) => error.includes("/404/: missing canonical"))).toBe(false);
  });

  it("fails when static X-Robots header rules drift", async () => {
    const root = await makeOutDir();
    await writeFile(path.join(root, "_headers"), `/llms.txt\n  X-Robots-Tag: noindex, nofollow\n`);
    await writeBaselinePages(root);
    await writeSitemap(root, ["/", "/stability-index/"]);

    const result = collectFixtureSeoResult(root);

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("static headers missing raw .txt payloads rule for /*.txt"),
        expect.stringContaining("static headers LLM-facing index rule /llms.txt must reset X-Robots-Tag"),
      ]),
    );
  });

  it("fails when document caching can outlive deployment chunks", async () => {
    const root = await makeOutDir();
    await writeFile(
      path.join(root, "_headers"),
      BASELINE_HEADERS.replace(
        "Cache-Control: public, max-age=0, must-revalidate",
        "Cache-Control: public, max-age=0, s-maxage=300, stale-while-revalidate=86400",
      ),
    );
    await writeBaselinePages(root);
    await writeSitemap(root, ["/", "/stability-index/"]);

    const result = collectFixtureSeoResult(root);

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("missing Cache-Control directive must-revalidate"),
        expect.stringContaining("must not use Cache-Control directive s-maxage"),
        expect.stringContaining("must not use Cache-Control directive stale-while-revalidate"),
      ]),
    );
  });

  it("fails indexable pages whose canonical does not match their local route", async () => {
    const root = await makeOutDir();
    await writePage(root, "/", { h1: "Home", links: ["/stability-index/"] });
    await writePage(root, "/stability-index/", {
      h1: "Stability Index",
      canonical: "https://pharos.watch/",
    });
    await writeSitemap(root, ["/", "/stability-index/"]);

    const result = collectFixtureSeoResult(root);

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "/stability-index/: canonical does not self-match local route: https://pharos.watch/ (expected https://pharos.watch/stability-index/)",
        ),
      ]),
    );
  });

  it("requires the homepage canonical to include the root slash", async () => {
    const root = await makeOutDir();
    await writePage(root, "/", {
      h1: "Home",
      links: ["/stability-index/"],
      canonical: "https://pharos.watch",
    });
    await writePage(root, "/stability-index/", { h1: "Stability Index" });
    await writeSitemap(root, ["/", "/stability-index/"]);

    const result = collectFixtureSeoResult(root);

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "/: canonical does not self-match local route: https://pharos.watch (expected https://pharos.watch/)",
        ),
      ]),
    );
  });

  it("fails conflicting robots directives across robots tags", async () => {
    const root = await makeOutDir();
    await writePage(root, "/", {
      h1: "Home",
      links: ["/stability-index/"],
      robots: ["noindex", "index, follow"],
    });
    await writePage(root, "/stability-index/", { h1: "Stability Index" });
    await writeSitemap(root, ["/", "/stability-index/"]);

    const result = collectFixtureSeoResult(root);

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/: conflicting robots directives (noindex conflicts with index)"),
      ]),
    );
  });

  it("fails sitemap pharos.watch URLs without local HTML artifacts", async () => {
    const root = await makeOutDir();
    await writeBaselinePages(root);
    await writeSitemap(root, ["/", "/stability-index/", "/missing/"]);

    const result = collectFixtureSeoResult(root);

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "sitemap.xml URL has no local static HTML artifact: https://pharos.watch/missing/ (expected /missing/)",
        ),
      ]),
    );
  });

  it("follows single-quoted internal links when calculating reachability", async () => {
    const root = await makeOutDir();
    await writePage(root, "/", { h1: "Home", links: ["/stability-index/"], quote: "'" });
    await writePage(root, "/stability-index/", { h1: "Stability Index" });
    await writeSitemap(root, ["/", "/stability-index/"]);

    const result = collectFixtureSeoResult(root);

    expect(result.errors.some((error) => error.includes("/stability-index/: indexable page is unreachable"))).toBe(
      false,
    );
  });

  it("fails sitemap URLs that conflict with _headers noindex rules", async () => {
    const root = await makeOutDir();
    await writeFile(path.join(root, "_headers"), `${BASELINE_HEADERS}\n/compare/\n  X-Robots-Tag: noindex, follow\n`);
    await writeBaselinePages(root, ["/compare/"]);
    await writePage(root, "/compare/", { h1: "Compare" });
    await writePage(root, "/stablecoin/usdt-tether/yield/", {
      h1: "Tether Yield",
      robots: ["noindex, follow"],
    });
    await writeSitemap(root, ["/", "/stability-index/", "/compare/", "/stablecoin/usdt-tether/yield/"]);

    const result = collectFixtureSeoResult(root);

    expect(result.errors).toEqual(
      expect.arrayContaining([
        "sitemap.xml URL https://pharos.watch/compare/ conflicts with _headers noindex rule /compare/; drop one of the two signals",
        "sitemap.xml URL https://pharos.watch/stablecoin/usdt-tether/yield/ conflicts with _headers noindex rule /stablecoin/*/yield/; drop one of the two signals",
      ]),
    );
    expect(
      result.errors.some(
        (error) =>
          error.startsWith("sitemap.xml URL https://pharos.watch/stability-index/") && error.includes("conflicts"),
      ),
    ).toBe(false);
  });

  it("fails duplicate sitemap locations", async () => {
    const root = await makeOutDir();
    await writeBaselinePages(root);
    await writeSitemap(root, ["/", "/stability-index/", "/stability-index/"]);

    const result = collectFixtureSeoResult(root);

    expect(result.errors).toContain(
      "sitemap.xml contains duplicate <loc> entries: https://pharos.watch/stability-index/",
    );
  });

  it("fails sitemap URLs that conflict with _redirects sources", async () => {
    const root = await makeOutDir();
    await writeFile(path.join(root, "_redirects"), "/redirected /target/ 301\n/wildcard/* /target/:splat 301\n");
    await writeBaselinePages(root, ["/redirected/"]);
    await writePage(root, "/redirected/", { h1: "Redirected" });
    await writeSitemap(root, ["/", "/stability-index/", "/redirected/"]);

    const result = collectFixtureSeoResult(root);

    expect(result.errors).toEqual(
      expect.arrayContaining([
        "sitemap.xml URL https://pharos.watch/redirected/ conflicts with _redirects source /redirected; drop one of the two signals",
      ]),
    );
    expect(result.errors.some((error) => error.includes("/wildcard/") && error.includes("_redirects"))).toBe(false);
  });

  it("fails slashless internal anchor hrefs that map to static routes", async () => {
    const root = await makeOutDir();
    await writePage(root, "/", { h1: "Home", links: ["/stability-index", "https://pharos.watch/about#sources"] });
    await writePage(root, "/stability-index/", { h1: "Stability Index" });
    await writePage(root, "/about/", { h1: "About" });
    await writeSitemap(root, ["/", "/stability-index/", "/about/"]);

    const result = collectFixtureSeoResult(root);

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "/: internal anchor href omits canonical trailing slash: /stability-index (use /stability-index/)",
        ),
        expect.stringContaining(
          "/: internal anchor href omits canonical trailing slash: https://pharos.watch/about#sources (use /about/#sources)",
        ),
      ]),
    );
  });

  it("fails internal anchor hrefs that point at retired route prefixes", async () => {
    const root = await makeOutDir();
    await writePage(root, "/", {
      h1: "Home",
      links: [
        "/stability-index/",
        "/blacklist/usdt-tether?view=issuer#top",
        "https://pharos.watch/tape?event=depeg",
        "/mica/",
        "/telegram/install/",
        "/stablecoins/protocol/liquity-v2/risks/",
        "/about/editorial/history/",
        "/feed/digest/",
      ],
    });
    await writePage(root, "/stability-index/", { h1: "Stability Index" });
    await writeSitemap(root, ["/", "/stability-index/"]);

    const result = collectFixtureSeoResult(root);

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "/: internal anchor href points to retired route prefix /blacklist: /blacklist/usdt-tether?view=issuer#top (use /freezewatch/)",
        ),
        expect.stringContaining(
          "/: internal anchor href points to retired route prefix /tape: https://pharos.watch/tape?event=depeg (use /timeline/)",
        ),
        expect.stringContaining(
          "/: internal anchor href points to retired route prefix /mica: /mica/ (use /compliance/)",
        ),
        expect.stringContaining(
          "/: internal anchor href points to retired route prefix /telegram: /telegram/install/ (use /pharoswatchbot/)",
        ),
        expect.stringContaining(
          "/: internal anchor href points to retired route prefix /stablecoins/protocol/liquity-v2: /stablecoins/protocol/liquity-v2/risks/ (use /stablecoins/infrastructure/liquity-v2/)",
        ),
        expect.stringContaining(
          "/: internal anchor href points to retired route prefix /about/editorial: /about/editorial/history/ (use /about/)",
        ),
        expect.stringContaining(
          "/: internal anchor href points to retired route prefix /feed/digest: /feed/digest/ (use /feed/digest.xml)",
        ),
      ]),
    );
  });

  it("fails internal redirect chains and non-permanent internal redirects", async () => {
    const root = await makeOutDir();
    await writeBaselinePages(root);
    await writeFile(path.join(root, "_redirects"), "/legacy /middle/ 302\n/middle /final/ 301\n");
    await writeSitemap(root, ["/", "/stability-index/"]);

    const result = collectFixtureSeoResult(root);

    expect(result.errors).toEqual(
      expect.arrayContaining([
        "_redirects internal rule must be permanent (301): /legacy /middle/ 302",
        "_redirects source /legacy targets another redirect source /middle via /middle/; collapse to one hop",
      ]),
    );
  });

  it("ignores retired route text, canonical route links, and external retired-route links", async () => {
    const root = await makeOutDir();
    await writePage(root, "/", {
      h1: "Home",
      links: [
        "/stability-index/",
        "/freezewatch/",
        "/timeline/",
        "/compliance/",
        "/feed/digest.xml",
        "/pharoswatchbot/",
        "/blacklist-report/",
        "https://docs.example.com/blacklist/",
        "https://example.com/tape/",
      ],
      mainText: "Plain text mentions /blacklist/ and https://pharos.watch/tape/ without linking to either route.",
    });
    await writePage(root, "/stability-index/", { h1: "Stability Index" });
    await writeSitemap(root, ["/", "/stability-index/"]);

    const result = collectFixtureSeoResult(root);

    expect(result.errors.filter((error) => error.includes("retired route prefix"))).toEqual([]);
  });

  it("fails thin representative chain detail static HTML", async () => {
    const root = await makeOutDir();
    await writeBaselinePages(root, ["/chains/ethereum/"]);
    await writePage(root, "/chains/ethereum/", {
      h1: "Ethereum Stablecoins",
      mainText: "",
    });
    await writeSitemap(root, ["/", "/stability-index/", "/chains/ethereum/"]);

    const result = collectFixtureSeoResult(root);

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/chains/ethereum/: chain detail static HTML visible text is too thin"),
      ]),
    );
  });

  it("fails thin non-canary stablecoin detail pages", async () => {
    const root = await makeOutDir();
    await writeBaselinePages(root, ["/stablecoin/usdt-tether/", "/stablecoin/usdc-circle/", "/stablecoin/thin/"]);
    await writePage(root, "/stablecoin/usdt-tether/", {
      h1: "Tether",
      mainText: "Useful stablecoin detail text ".repeat(20),
    });
    await writePage(root, "/stablecoin/usdc-circle/", {
      h1: "USD Coin",
      mainText: "Useful stablecoin detail text ".repeat(20),
    });
    await writePage(root, "/stablecoin/thin/", {
      h1: "Thin Coin",
      mainText: "",
    });
    await writeSitemap(root, [
      "/",
      "/stability-index/",
      "/stablecoin/usdt-tether/",
      "/stablecoin/usdc-circle/",
      "/stablecoin/thin/",
    ]);

    const result = collectFixtureSeoResult(root);

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/stablecoin/thin/: stablecoin detail static HTML visible text is too thin"),
      ]),
    );
  });

  it("fails representative detail pages dominated by loading shell text", async () => {
    const root = await makeOutDir();
    await writeBaselinePages(root, ["/stablecoin/usdt-tether/"]);
    await writePage(root, "/stablecoin/usdt-tether/", {
      h1: "Tether",
      mainText: `${"Loading ".repeat(20)}${"analytics ".repeat(50)}`,
    });
    await writeSitemap(root, ["/", "/stability-index/", "/stablecoin/usdt-tether/"]);

    const result = collectFixtureSeoResult(root);

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "/stablecoin/usdt-tether/: stablecoin detail static HTML is dominated by loading shell text",
        ),
      ]),
    );
  });

  it("asserts required structured-data fields for representative routes", async () => {
    const root = await makeOutDir();
    await writeBaselinePages(root, ["/about/api/"]);
    await writePage(root, "/about/api/", {
      h1: "API Reference",
      extraHead: jsonLdScript({
        "@context": "https://schema.org",
        "@type": "DataCatalog",
        name: "Pharos Public API Data Catalog",
        url: "https://pharos.watch/about/api/",
      }),
    });
    await writeSitemap(root, ["/", "/stability-index/", "/about/api/"]);

    const result = collectSeoStaticCheckResult({
      outDir: root,
      structuredDataRouteMatrix: [
        {
          label: "about API reference",
          route: "/about/api/",
          nodes: [{ type: "DataCatalog", requiredPaths: ["name", "url", "dataset.0.@id"] }],
        },
      ],
    });

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/about/api/: about API reference DataCatalog structured data missing dataset.0.@id"),
      ]),
    );
  });

  it("asserts Dataset catalog references include Google-required fields", async () => {
    const root = await makeOutDir();
    await writeBaselinePages(root, ["/safety-scores/"]);
    await writePage(root, "/safety-scores/", {
      h1: "Safety Scores",
      extraHead: jsonLdScript({
        "@context": "https://schema.org",
        "@type": "Dataset",
        name: "Pharos Latest Stablecoin Scores Dataset",
        includedInDataCatalog: { "@id": "https://pharos.watch/about/api/#data-catalog" },
      }),
    });
    await writeSitemap(root, ["/", "/stability-index/", "/safety-scores/"]);

    const result = collectSeoStaticCheckResult({
      outDir: root,
      structuredDataRouteMatrix: [
        {
          label: "safety scores",
          route: "/safety-scores/",
          nodes: [
            {
              type: "Dataset",
              requiredPaths: ["includedInDataCatalog.name", "includedInDataCatalog.url"],
            },
          ],
        },
      ],
    });

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "/safety-scores/: safety scores Dataset structured data missing includedInDataCatalog.name",
        ),
        expect.stringContaining(
          "/safety-scores/: safety scores Dataset structured data missing includedInDataCatalog.url",
        ),
      ]),
    );
  });

  it("fails /about/ FAQ structured data when the emitted Q&A is not visible", async () => {
    const root = await makeOutDir();
    await writeBaselinePages(root, ["/about/"]);
    await writePage(root, "/about/", {
      h1: "About Pharos",
      mainText: "About Pharos overview without the structured question and answer.",
      extraHead: jsonLdScript({
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: [
          {
            "@type": "Question",
            name: "Why does Pharos exist?",
            acceptedAnswer: {
              "@type": "Answer",
              text: "Pharos makes stablecoin risk visible.",
            },
          },
        ],
      }),
    });
    await writeSitemap(root, ["/", "/stability-index/", "/about/"]);

    const result = collectSeoStaticCheckResult({
      outDir: root,
      structuredDataRouteMatrix: [
        {
          label: "about FAQ",
          route: "/about/",
          nodes: [{ type: "FAQPage", requiredPaths: ["mainEntity.0.name", "mainEntity.0.acceptedAnswer.text"] }],
          requireVisibleFaq: true,
        },
      ],
    });

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/about/: FAQPage question is not visible in page content: Why does Pharos exist?"),
        expect.stringContaining("/about/: FAQPage answer is not visible in page content for: Why does Pharos exist?"),
      ]),
    );
  });
});
