/* eslint-disable security/detect-non-literal-fs-filename */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { collectSeoStaticCheckResult } from "../check-seo-static.mjs";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function makeOutDir() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pharos-seo-static-"));
  roots.push(root);
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
    extraHead = "",
  }: {
    h1?: string;
    links?: string[];
    mainText?: string;
    robots?: string[];
    ogType?: string | null;
    extraHead?: string;
  } = {},
) {
  const filePath = pagePath(root, route);
  await mkdir(path.dirname(filePath), { recursive: true });
  const robotsTags = robots.map((content) => `<meta name="robots" content="${content}"/>`).join("");
  const linkTags = links.map((href) => `<a href="${href}">${href}</a>`).join("");
  const ogTypeTag = ogType ? `<meta property="og:type" content="${ogType}"/>` : "";
  await writeFile(
    filePath,
    `<!doctype html>
<html>
  <head>
    <title>${h1} | Pharos</title>
    <meta name="description" content="${h1} description"/>
    ${robotsTags}
    <link rel="canonical" href="${pageUrl(route)}"/>
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

    const result = collectSeoStaticCheckResult({ outDir: root });

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

    const result = collectSeoStaticCheckResult({ outDir: root });

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

    const result = collectSeoStaticCheckResult({ outDir: root });

    expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining("/: missing og:type")]));
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

    const result = collectSeoStaticCheckResult({ outDir: root });

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

    const result = collectSeoStaticCheckResult({ outDir: root });

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "sitemap.xml URL has no local static HTML artifact: https://pharos.watch/missing/ (expected /missing/)",
        ),
      ]),
    );
  });

  it("fails thin representative chain detail static HTML", async () => {
    const root = await makeOutDir();
    await writeBaselinePages(root, ["/chains/ethereum/"]);
    await writePage(root, "/chains/ethereum/", {
      h1: "Ethereum Stablecoins",
      mainText: "",
    });
    await writeSitemap(root, ["/", "/stability-index/", "/chains/ethereum/"]);

    const result = collectSeoStaticCheckResult({ outDir: root });

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/chains/ethereum/: chain detail static HTML visible text is too thin"),
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

    const result = collectSeoStaticCheckResult({ outDir: root });

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "/stablecoin/usdt-tether/: stablecoin detail static HTML is dominated by loading shell text",
        ),
      ]),
    );
  });
});
