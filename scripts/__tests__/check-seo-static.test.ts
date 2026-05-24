import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { collectSeoStaticCheckResult } from "../ci/check-seo-static.mjs";

const roots: string[] = [];
const BASELINE_HEADERS = `/*.txt
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
    ogType = "website",
    canonical = pageUrl(route),
    extraHead = "",
    quote = "\"",
  }: {
    h1?: string;
    links?: string[];
    mainText?: string;
    robots?: string[];
    ogType?: string | null;
    canonical?: string | null;
    extraHead?: string;
    quote?: "\"" | "'";
  } = {},
) {
  const filePath = pagePath(root, route);
  await mkdir(path.dirname(filePath), { recursive: true });
  const robotsTags = robots.map((content) => `<meta name="robots" content="${content}"/>`).join("");
  const linkTags = links.map((href) => `<a href=${quote}${href}${quote}>${href}</a>`).join("");
  const ogTypeTag = ogType ? `<meta property="og:type" content="${ogType}"/>` : "";
  const canonicalTag = canonical ? `<link rel="canonical" href="${canonical}"/>` : "";
  await writeFile(
    filePath,
    `<!doctype html>
<html>
  <head>
    <title>${h1} | Pharos</title>
    <meta name="description" content="${h1} description"/>
    ${robotsTags}
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
  return collectSeoStaticCheckResult({ outDir: root, enforceStructuredDataMatrix: false });
}

function jsonLdScript(data: unknown) {
  return `<script type="application/ld+json">${JSON.stringify(data)}</script>`;
}

async function writeBaselinePages(root: string, rootLinks: string[] = []) {
  await writePage(root, "/", { h1: "Home", links: ["/stability-index/", ...rootLinks] });
  await writePage(root, "/stability-index/", { h1: "Stability Index" });
}

describe("check-seo-static", () => {
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

    expect(result.errors.some((error) => error.includes("/stability-index/: indexable page is unreachable"))).toBe(false);
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
