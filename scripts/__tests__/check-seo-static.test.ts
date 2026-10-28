import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  vi.unstubAllEnvs();
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
    ogSiteName = "Pharos Watch",
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
    ogSiteName?: string | null;
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
  const ogSiteNameTag = ogSiteName ? `<meta property="og:site_name" content="${ogSiteName}"/>` : "";
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
    ${ogSiteNameTag}
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

async function writeBaselinePages(
  root: string,
  rootLinks: string[] = [],
  overrides: Record<string, Parameters<typeof writePage>[2]> = {},
  sitemapRoutes?: string[],
) {
  await writePage(root, "/", { h1: "Home", links: ["/stability-index/", ...rootLinks], ...overrides["/"] });
  await writePage(root, "/stability-index/", { h1: "Stability Index", ...overrides["/stability-index/"] });
  if (sitemapRoutes) await writeSitemap(root, sitemapRoutes);
}

describe("check-seo-static", () => {
  it.each([
    ["/stablecoins/dola-inverse-finance", "/stablecoin/dola-inverse-finance/"],
    ["/stablecoins/backing/algorithmic", "/stablecoins/backing/"],
  ])("redirects retired taxonomy URL %s directly before dynamic rules", async (source, destination) => {
    const redirects = await readFile(new URL("../../public/_redirects", import.meta.url), "utf8");
    const rules = redirects.split("\n").filter((line) => line.trim() && !line.startsWith("#"));
    const firstDynamic = rules.findIndex((line) => /[*:]/.test(line.split(/\s+/)[0]));
    for (const alias of [source, `${source}/`]) {
      const index = rules.indexOf(`${alias} ${destination} 301`);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(firstDynamic);
    }
    expect(rules.some((line) => line.split(/\s+/)[0].replace(/\/$/, "") === destination.replace(/\/$/, "")))
      .toBe(false);
  });

  it("reuses complete redirect rules for archive continuity while retaining source-only sitemap conflicts", async () => {
    const root = await makeOutDir();
    await writeBaselinePages(root, ["/digest/new/"], {}, ["/", "/stability-index/", "/digest/new/"]);
    await writePage(root, "/digest/new/", { h1: "New digest" });
    await writeFile(path.join(root, "_redirects"), [
      "# Authored redirects",
      "/digest/old/ /digest/new/ 301",
      "/stability-index",
      "/external https://example.test",
      "",
    ].join("\n"));

    const result = collectFixtureSeoResult(root);
    expect(result.redirectRules).toEqual([
      { source: "/digest/old/", destination: "/digest/new/", status: "301" },
      { source: "/external", destination: "https://example.test", status: "" },
    ]);
    expect(result.errors).toContain(
      "sitemap.xml URL https://pharos.watch/stability-index/ conflicts with _redirects source /stability-index; drop one of the two signals",
    );
    expect(findPublishedArchiveContinuityErrors(
      `<urlset><url><loc>${pageUrl("/digest/old/")}</loc></url></urlset>`,
      `<urlset><url><loc>${pageUrl("/digest/new/")}</loc></url></urlset>`,
      result.redirectRules,
      new Set(result.pageRecords.map((record: { route: string }) => record.route)),
    )).toEqual([]);
  });

  it.each([
    { robots: ["noindex, follow"] },
    { robots: ["none"] },
    { googleBotRobots: ["noindex, follow"] },
    { googleBotRobots: ["none"] },
  ])("rejects sitemap targets with effective HTML noindex metadata %j", async (metadata) => {
    const root = await makeOutDir();
    await writeBaselinePages(root, ["/private/"], {}, ["/", "/stability-index/", "/private/"]);
    await writePage(root, "/private/", metadata);
    const result = collectFixtureSeoResult(root);
    expect(result.pageRecords.find((page: { route: string }) => page.route === "/private/")?.indexable).toBe(false);
    expect(result.errors).toContain(
      "sitemap.xml URL https://pharos.watch/private/ conflicts with non-indexable HTML metadata; drop one of the two signals",
    );
    await writeSitemap(root, ["/", "/stability-index/"]);
    expect(collectFixtureSeoResult(root).errors).toEqual([]);
  });

  type SeoFixtureCase = {
    name: string;
    rootLinks?: string[];
    overrides?: Record<string, Parameters<typeof writePage>[2]>;
    extraPages?: Record<string, Parameters<typeof writePage>[2]>;
    sitemapRoutes?: string[];
    headers?: string;
    redirects?: string;
    errors?: string[];
    absentErrors?: string[];
  };

  // One row per gate rule: the fixture that should trip it (or prove it stays quiet).
  it.each([
    {
      name: "fails invalid application/ld+json blocks",
      overrides: { "/": { extraHead: '<script type="application/ld+json">{"@context":"https://schema.org",}</script>' } },
      errors: ["/: invalid JSON-LD block #1"],
    },
    {
      name: "fails missing og:type on indexable pages",
      overrides: { "/": { ogType: null } },
      errors: ["/: missing og:type"],
    },
    {
      name: "fails missing og:site_name on indexable pages",
      overrides: { "/": { ogSiteName: null } },
      errors: ["/: missing og:site_name"],
    },
    {
      name: "allows noindex pages to omit canonical",
      extraPages: { "/404/": { h1: "Not Found", robots: ["noindex, follow"], canonical: null } },
      absentErrors: ["/404/: missing canonical"],
    },
    {
      name: "fails when static X-Robots header rules drift",
      headers: "/llms.txt\n  X-Robots-Tag: noindex, nofollow\n",
      errors: [
        "static headers missing raw .txt payloads rule for /*.txt",
        "static headers LLM-facing index rule /llms.txt must reset X-Robots-Tag",
      ],
    },
    {
      name: "fails when document caching can outlive deployment chunks",
      headers: BASELINE_HEADERS.replace(
        "Cache-Control: public, max-age=0, must-revalidate",
        "Cache-Control: public, max-age=0, s-maxage=300, stale-while-revalidate=86400",
      ),
      errors: [
        "missing Cache-Control directive must-revalidate",
        "must not use Cache-Control directive s-maxage",
        "must not use Cache-Control directive stale-while-revalidate",
      ],
    },
    {
      name: "fails indexable pages whose canonical does not match their local route",
      overrides: { "/stability-index/": { canonical: "https://pharos.watch/" } },
      errors: [
        "/stability-index/: canonical does not self-match local route: https://pharos.watch/ (expected https://pharos.watch/stability-index/)",
      ],
    },
    {
      name: "requires the homepage canonical to include the root slash",
      overrides: { "/": { canonical: "https://pharos.watch" } },
      errors: ["/: canonical does not self-match local route: https://pharos.watch (expected https://pharos.watch/)"],
    },
    {
      name: "fails conflicting robots directives across robots tags",
      overrides: { "/": { robots: ["noindex", "index, follow"] } },
      errors: ["/: conflicting robots directives (noindex conflicts with index)"],
    },
    {
      name: "fails sitemap pharos.watch URLs without local HTML artifacts",
      sitemapRoutes: ["/", "/stability-index/", "/missing/"],
      errors: ["sitemap.xml URL has no local static HTML artifact: https://pharos.watch/missing/ (expected /missing/)"],
    },
    {
      name: "fails duplicate sitemap locations",
      sitemapRoutes: ["/", "/stability-index/", "/stability-index/"],
      errors: ["sitemap.xml contains duplicate <loc> entries: https://pharos.watch/stability-index/"],
    },
    {
      name: "fails sitemap URLs that conflict with _redirects sources",
      redirects: "/redirected /target/ 301\n/wildcard/* /target/:splat 301\n",
      rootLinks: ["/redirected/"],
      extraPages: { "/redirected/": { h1: "Redirected" } },
      sitemapRoutes: ["/", "/stability-index/", "/redirected/"],
      errors: [
        "sitemap.xml URL https://pharos.watch/redirected/ conflicts with _redirects source /redirected; drop one of the two signals",
      ],
      absentErrors: ["/wildcard/"],
    },
    {
      name: "fails slashless internal anchor hrefs that map to static routes",
      rootLinks: ["/stability-index", "https://pharos.watch/about#sources"],
      extraPages: { "/about/": { h1: "About" } },
      sitemapRoutes: ["/", "/stability-index/", "/about/"],
      errors: [
        "/: internal anchor href omits canonical trailing slash: /stability-index (use /stability-index/)",
        "/: internal anchor href omits canonical trailing slash: https://pharos.watch/about#sources (use /about/#sources)",
      ],
    },
    {
      name: "fails internal anchor hrefs that point at retired route prefixes",
      rootLinks: [
        "/blacklist/usdt-tether?view=issuer#top",
        "https://pharos.watch/tape?event=depeg",
        "/mica/",
        "/telegram/install/",
        "/stablecoins/protocol/liquity-v2/risks/",
        "/about/editorial/history/",
        "/feed/digest/",
      ],
      errors: [
        "/: internal anchor href points to retired route prefix /blacklist: /blacklist/usdt-tether?view=issuer#top (use /freezewatch/)",
        "/: internal anchor href points to retired route prefix /tape: https://pharos.watch/tape?event=depeg (use /timeline/)",
        "/: internal anchor href points to retired route prefix /mica: /mica/ (use /compliance/)",
        "/: internal anchor href points to retired route prefix /telegram: /telegram/install/ (use /pharoswatchbot/)",
        "/: internal anchor href points to retired route prefix /stablecoins/protocol/liquity-v2: /stablecoins/protocol/liquity-v2/risks/ (use /stablecoins/infrastructure/liquity-v2/)",
        "/: internal anchor href points to retired route prefix /about/editorial: /about/editorial/history/ (use /about/)",
        "/: internal anchor href points to retired route prefix /feed/digest: /feed/digest/ (use /feed/digest.xml)",
      ],
    },
    {
      name: "fails internal anchor hrefs that point at any _redirects source, not only listed prefixes",
      redirects: [
        "/about/api/ /api/reference/ 301",
        "/about/api /api/reference/ 301",
        "/datasets/x/latest.csv /datasets/x/2026-10-22.csv 200",
        "/old-tool/* /new-tool/ 301",
        "",
      ].join("\n"),
      rootLinks: ["/about/api/", "/old-tool/deep/view/", "/datasets/x/latest.csv", "/blacklist/"],
      errors: [
        "/: internal anchor href points to _redirects source /about/api/: /about/api/ (use /api/reference/)",
        "/: internal anchor href points to _redirects source /old-tool/*: /old-tool/deep/view/ (use /new-tool/)",
        "/: internal anchor href points to retired route prefix /blacklist: /blacklist/ (use /freezewatch/)",
      ],
      absentErrors: ["/datasets/x/latest.csv", "_redirects source /blacklist"],
    },
    {
      name: "fails internal redirect chains and non-permanent internal redirects",
      redirects: "/legacy /middle/ 302\n/middle /final/ 301\n",
      errors: [
        "_redirects internal rule must be permanent (301): /legacy /middle/ 302",
        "_redirects source /legacy targets another redirect source /middle via /middle/; collapse to one hop",
      ],
    },
    {
      name: "fails static redirect rules placed after a dynamic rule",
      redirects: "/old/* /new/:splat 301\n/old/ /new/ 301\n/retired /new/ 301\n",
      errors: [
        "_redirects static rule /old/ follows a dynamic rule; move it above every splat/placeholder rule",
        "_redirects static rule /retired follows a dynamic rule; move it above every splat/placeholder rule",
      ],
    },
    {
      name: "fails retired-coin redirects into a peg hub the build does not export",
      redirects: "/stablecoin/retired-coin /stablecoins/hkd/ 301\n/stablecoin/other-coin /stablecoins/usd/ 301\n",
      extraPages: { "/stablecoins/usd/": { h1: "US Dollar stablecoins" } },
      errors: [
        "_redirects source /stablecoin/retired-coin targets /stablecoins/hkd/, which the build does not export; redirect it to /coverage/",
      ],
      absentErrors: ["_redirects source /stablecoin/other-coin targets"],
    },
    {
      name: "accepts static redirect rules ahead of dynamic rules",
      redirects: "/old/ /new/ 301\n/retired /new/ 301\n/old/* /new/:splat 301\n",
      absentErrors: ["follows a dynamic rule", "dynamic-counted rules"],
    },
    {
      name: "allows direct public-dataset and Sheets 200 rewrites to dated artifacts",
      redirects: [
        "/datasets/top-stablecoins/latest.csv /datasets/top-stablecoins/2026-07-08.csv 200",
        "/datasets/top-stablecoins/latest.json /datasets/top-stablecoins/2026-07-08.json 200",
        "/datasets/top-stablecoins/latest.ndjson /datasets/top-stablecoins/2026-07-08.ndjson 200",
        "/sheets/top-stablecoins.csv /datasets/top-stablecoins/2026-07-08.csv 200",
        "",
      ].join("\n"),
      absentErrors: ["_redirects internal rule must be permanent"],
    },
    {
      name: "fails thin representative chain detail static HTML",
      rootLinks: ["/chains/ethereum/"],
      extraPages: { "/chains/ethereum/": { h1: "Ethereum Stablecoins", mainText: "" } },
      sitemapRoutes: ["/", "/stability-index/", "/chains/ethereum/"],
      errors: ["/chains/ethereum/: chain detail static HTML visible text is too thin"],
    },
    {
      name: "fails thin non-canary stablecoin detail pages",
      rootLinks: ["/stablecoin/usdt-tether/", "/stablecoin/usdc-circle/", "/stablecoin/thin/"],
      extraPages: {
        "/stablecoin/usdt-tether/": { h1: "Tether", mainText: "Useful stablecoin detail text ".repeat(20) },
        "/stablecoin/usdc-circle/": { h1: "USD Coin", mainText: "Useful stablecoin detail text ".repeat(20) },
        "/stablecoin/thin/": { h1: "Thin Coin", mainText: "" },
      },
      sitemapRoutes: [
        "/",
        "/stability-index/",
        "/stablecoin/usdt-tether/",
        "/stablecoin/usdc-circle/",
        "/stablecoin/thin/",
      ],
      errors: ["/stablecoin/thin/: stablecoin detail static HTML visible text is too thin"],
    },
    {
      name: "fails representative detail pages dominated by loading shell text",
      rootLinks: ["/stablecoin/usdt-tether/"],
      extraPages: {
        "/stablecoin/usdt-tether/": { h1: "Tether", mainText: `${"Loading ".repeat(20)}${"analytics ".repeat(50)}` },
      },
      sitemapRoutes: ["/", "/stability-index/", "/stablecoin/usdt-tether/"],
      errors: ["/stablecoin/usdt-tether/: stablecoin detail static HTML is dominated by loading shell text"],
    },
    {
      name: "fails profiles that render an unresolved grade claim or a bare loading dossier",
      rootLinks: ["/stablecoin/usdt-tether/", "/stablecoin/jpyc-jpyc/", "/stablecoin/usdc-circle/"],
      extraPages: {
        "/stablecoin/usdt-tether/": {
          h1: "Tether (USDT)",
          mainText: `${"Useful stablecoin detail text ".repeat(20)}<span hidden>USDT carries a N/A overall grade.</span>`,
        },
        "/stablecoin/jpyc-jpyc/": { h1: "JPY Coin (JPYC)", mainText: `Loading research dossier… ${"detail ".repeat(70)}` },
        "/stablecoin/usdc-circle/": {
          h1: "USD Coin (USDC)",
          mainText: `Loading research dossier… ${"detail ".repeat(70)}<h2 id="stablecoin-static-profile-title">Static</h2>`,
        },
      },
      sitemapRoutes: ["/", "/stability-index/", "/stablecoin/usdt-tether/", "/stablecoin/jpyc-jpyc/", "/stablecoin/usdc-circle/"],
      errors: [
        '/stablecoin/usdt-tether/: profile HTML renders an unresolved claim ("N/A overall grade")',
        '/stablecoin/jpyc-jpyc/: profile HTML is a "Loading research dossier" shell without the static profile',
      ],
      absentErrors: ["/stablecoin/usdc-circle/: profile HTML"],
    },
  ] as SeoFixtureCase[])("$name", async (fixture) => {
    const root = await makeOutDir();
    if (fixture.headers !== undefined) await writeFile(path.join(root, "_headers"), fixture.headers);
    if (fixture.redirects !== undefined) await writeFile(path.join(root, "_redirects"), fixture.redirects);
    await writeBaselinePages(root, fixture.rootLinks ?? [], fixture.overrides ?? {});
    for (const [route, options] of Object.entries(fixture.extraPages ?? {})) await writePage(root, route, options);
    await writeSitemap(root, fixture.sitemapRoutes ?? ["/", "/stability-index/"]);

    const result = collectFixtureSeoResult(root);

    expect(result.errors).toEqual(
      expect.arrayContaining((fixture.errors ?? []).map((fragment) => expect.stringContaining(fragment))),
    );
    for (const fragment of fixture.absentErrors ?? []) {
      expect(result.errors.filter((error) => error.includes(fragment))).toEqual([]);
    }
  });

  it("enforces the retained depeg History preview in pilot profile HTML", async () => {
    // React streaming inserts hydration comment separators between text nodes.
    const streamedCaption = "Latest <!-- -->6<!-- --> of <!-- -->248 archived incidents · as of <!-- -->2026-10-17<!-- --> UTC. Recorded history; coverage may be incomplete.";
    const preview = ({ rows = 6, anchors = 1, withCaption = true }: { rows?: number; anchors?: number; withCaption?: boolean } = {}) => {
      const anchor = '<div id="depeg-history" data-history-tab="depeg" hidden><div data-testid="depeg-history-preview"><table>'
        + `${withCaption ? `<caption>${streamedCaption}</caption>` : ""}<tbody>`
        + Array.from({ length: rows }, (_, index) => `<tr><td>2024-01-0${index + 1}</td><td>+1${index} bps</td><td>1h</td><td>Recovered</td><td>Historical backfill</td></tr>`).join("")
        + "</tbody></table></div></div>";
      return `<div data-history-tab="grade" hidden></div>${Array.from({ length: anchors }, () => anchor).join("")}`;
    };
    const collect = async (route: string, mainText: string) => {
      const root = await makeOutDir();
      await writeBaselinePages(root, [route]);
      await writePage(root, route, { h1: "Pilot profile", mainText: `${"Useful stablecoin detail text ".repeat(20)}${mainText}` });
      await writeSitemap(root, ["/", "/stability-index/", route]);
      return collectFixtureSeoResult(root).errors.filter((error: string) => error.includes("History preview") || error.includes("NAV profile"));
    };

    expect(await collect("/stablecoin/usdt-tether/", preview())).toEqual([]);
    expect(await collect("/stablecoin/usdt-tether/", preview({ anchors: 2 }))).toEqual(
      expect.arrayContaining([
        expect.stringContaining("History preview must own exactly one #depeg-history (found 2)"),
        expect.stringContaining("History preview must render exactly once (found 2)"),
      ]),
    );
    expect(await collect("/stablecoin/usdt-tether/", preview({ rows: 7 }))).toEqual([
      expect.stringContaining("History preview renders 7 incident rows (maximum 6)"),
    ]);
    expect(await collect("/stablecoin/usdt-tether/", preview({ rows: 0 }))).toEqual([
      expect.stringContaining("History preview renders no incident rows"),
    ]);
    expect(await collect("/stablecoin/usdt-tether/", preview({ withCaption: false }))).toEqual([
      expect.stringContaining("History preview is missing its capture date or coverage caption"),
    ]);
    expect(await collect("/stablecoin/usdt-tether/", `<div data-history-tab="depeg" hidden><script>{"text":"Latest 6 of 248 archived incidents · as of 2026-10-17 UTC. Recorded history; coverage may be incomplete."}</script></div>`)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("History preview must render exactly once (found 0)"),
      ]),
    );
    expect(await collect("/stablecoin/aa-falconx-mev-capital/", preview())).toEqual(
      expect.arrayContaining([
        expect.stringContaining("NAV profile renders a depeg history preview"),
        expect.stringContaining("NAV profile renders a #depeg-history panel"),
      ]),
    );
  });

  it("requires one visible <h1> inside <main> on former loading-boundary route families", async () => {
    const root = await makeOutDir();
    await writeBaselinePages(root, ["/depeg/", "/compare/", "/flows/"]);
    await writePage(root, "/compare/", { h1: "Compare stablecoins" });
    for (const [route, title] of [["/depeg/", "Depeg tracker"], ["/flows/", "Mint/Burn Flows"]] as const) {
      await mkdir(path.join(root, route.slice(1, -1)), { recursive: true });
      await writeFile(
        pagePath(root, route),
        `<!doctype html><html><head><title>${title} | Pharos</title>
<meta name="description" content="${title} description"/>
<link rel="canonical" href="https://pharos.watch${route}"/></head>
<body><main><div class="skeleton">Loading</div></main><div hidden id="S:0"><h1>${title}</h1></div></body></html>`,
      );
    }
    await writeSitemap(root, ["/", "/stability-index/", "/depeg/", "/compare/", "/flows/"]);

    const result = collectFixtureSeoResult(root);

    expect(result.errors).toContainEqual(expect.stringContaining("/depeg/: expected exactly one visible <h1> inside <main>, got 0"));
    expect(result.errors).toContainEqual(expect.stringContaining("/flows/: expected exactly one visible <h1> inside <main>, got 0"));
    expect(result.errors.filter((error) => error.startsWith("/compare/: expected exactly one visible"))).toEqual([]);
    expect(result.errors.filter((error) => error.startsWith("/stability-index/: expected exactly one visible"))).toEqual([]);
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

  it("enforces title brand, dash and description ellipsis hygiene with warn-only families", async () => {
    const root = await makeOutDir();
    const description = "A complete meta description sentence that is long enough for the snippet envelope used by the check.";
    const pages: Record<string, Parameters<typeof writePage>[2]> = {
      "/": { h1: "Home", title: "Pharos: Stablecoin Analytics Dashboard Home | Pharos", description },
      "/stablecoin/a/": { h1: "A", title: "AAA Stablecoin on Pharos: Safety Score & Risk | Pharos", description },
      "/stablecoin/b/": { h1: "B", title: "BBB Stablecoin \u2014 Safety Score and Risk Profile | Pharos", description },
      "/stablecoin/c/": { h1: "C", title: "CCC Stablecoin: Safety Score & Risk Profile | Pharos", description: `${description.slice(0, -1)}…` },
      "/chains/pharos/": { h1: "Chain", title: "Pharos Network Stablecoins: Supply & Risk | Pharos", description },
      "/blog/post/": { h1: "Post", title: "Pharos at Six Months: The Lighthouse Is Lit | Pharos Blog", description },
      "/docs/dews/": { h1: "Docs", title: "DEWS Methodology - Pharos Docs | Pharos", description },
      "/depeg/x/": { h1: "Depeg", title: "XYZ Depeg \u2014 March 2026: 2% Below Peg Event | Pharos", description },
      "/compare/a-vs-b/": { h1: "Compare", title: "AAA vs BBB: Safety Scores, Reserves & Risk | Pharos", description: `${description.slice(0, -1)}…` },
      "/stablecoin/long/": { h1: "Long", title: "LONGSYM Stablecoin (Some Issuer): Safety Score & Risk | Pharos", description },
    };
    for (const [route, options] of Object.entries(pages)) {
      await writePage(root, route, { ...options, links: route === "/" ? Object.keys(pages).filter((r) => r !== "/") : [] });
    }
    await writeSitemap(root, Object.keys(pages));

    const result = collectSeoStaticCheckResult({ outDir: root, enforceStructuredDataMatrix: false });
    const hygiene = (messages: string[]) => messages.filter((message) =>
      /repeats "Pharos"|dash \(U\+2012|ends in "…"|exceed 60 chars/.test(message));

    expect(hygiene(result.errors)).toHaveLength(3);
    expect(hygiene(result.errors)).toEqual(expect.arrayContaining([
      expect.stringContaining('/stablecoin/a/: <title> repeats "Pharos" before the suffix'),
      expect.stringContaining("/stablecoin/b/: <title> contains a figure, en or em dash"),
      expect.stringContaining('/stablecoin/c/: meta description ends in "…"'),
    ]));
    expect(hygiene(result.warnings)).toHaveLength(4);
    expect(hygiene(result.warnings)).toEqual(expect.arrayContaining([
      expect.stringContaining('/docs/dews/: <title> repeats "Pharos" before the suffix'),
      expect.stringContaining("/depeg/x/: <title> contains a figure, en or em dash"),
      expect.stringContaining('/compare/a-vs-b/: meta description ends in "…"'),
      expect.stringMatching(/^1 indexable <title>s exceed 60 chars .*\/stablecoin\/long\/$/),
    ]));
  });

  it.each([
    { kind: "missing", og: "https://pharos.watch/og-missing.png", twitter: "/og-missing.png", localFile: null,
      errors: ["/: og:image references missing file /og-missing.png", "/: twitter:image references missing file /og-missing.png"] },
    { kind: "local", og: "https://pharos.watch/og-card.png", twitter: "/og-card.png", localFile: "og-card.png", errors: [] },
    { kind: "external", og: "https://api.pharos.watch/api/og/stablecoin/usdt-tether",
      twitter: "https://api.pharos.watch/api/og/stablecoin/usdt-tether", localFile: null, errors: [] },
  ])("checks $kind social image references", async ({ og, twitter, localFile, errors }) => {
    const root = await makeOutDir();
    if (localFile) await writeFile(path.join(root, localFile), "");
    await writeBaselinePages(root, [], {
      "/": { extraHead: `<meta property="og:image" content="${og}"/><meta name="twitter:image" content="${twitter}"/>` },
    }, ["/", "/stability-index/"]);

    const result = collectFixtureSeoResult(root);
    expect(result.errors.filter((error) => error.includes("references missing file"))).toEqual(errors);
  });

  it("asserts required structured-data fields for representative routes", async () => {
    const root = await makeOutDir();
    await writeBaselinePages(root, ["/api/"]);
    await writePage(root, "/api/", {
      h1: "API Reference",
      extraHead: jsonLdScript({
        "@context": "https://schema.org",
        "@type": "DataCatalog",
        name: "Pharos Public API Data Catalog",
        url: "https://pharos.watch/api/",
      }),
    });
    await writeSitemap(root, ["/", "/stability-index/", "/api/"]);

    const result = collectSeoStaticCheckResult({
      outDir: root,
      structuredDataRouteMatrix: [
        {
          label: "API page",
          route: "/api/",
          nodes: [{ type: "DataCatalog", requiredPaths: ["name", "url", "dataset.0.@id"] }],
        },
      ],
    });

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/api/: API page DataCatalog structured data missing dataset.0.@id"),
      ]),
    );
  });

});
