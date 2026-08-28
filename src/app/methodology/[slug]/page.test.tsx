import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { METHODOLOGY_CHANGELOG_REGISTRY } from "@shared/lib/methodology-versions/registry";
import { METHODOLOGY_CHANGELOG_SITEMAP_PATHS } from "../../sitemap";
import MethodologyChangelogRoute, { generateMetadata, generateStaticParams } from "./page";
import { LEGACY_CHANGELOG_ROUTE_FIXTURES } from "./route-parity.fixture";

const INDEXABLE_ROBOTS = {
  index: true,
  follow: true,
  googleBot: {
    index: true,
    follow: true,
    "max-snippet": -1,
    "max-image-preview": "large",
    "max-video-preview": -1,
  },
};

function legacyMetadata(fixture: (typeof LEGACY_CHANGELOG_ROUTE_FIXTURES)[number]) {
  const socialImage = { url: "/og-editorial-methodology.png", width: 1200, height: 628 };
  return {
    title: fixture.metadataTitle,
    description: fixture.metadataDescription,
    alternates: {
      canonical: fixture.path,
      types: {
        "text/markdown": [{
          title: `${fixture.metadataTitle} (Markdown)`,
          url: `${fixture.path}index.md`,
        }],
      },
    },
    openGraph: {
      title: fixture.metadataTitle,
      description: fixture.metadataDescription,
      url: fixture.path,
      type: "website",
      images: [socialImage],
    },
    twitter: {
      card: "summary_large_image",
      title: fixture.metadataTitle,
      description: fixture.metadataDescription,
      images: [socialImage],
    },
    robots: INDEXABLE_ROBOTS,
  };
}

function jsonLdBytes(value: unknown): string {
  return JSON.stringify(value)
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\//g, "\\u002f");
}

function legacyJsonLd(fixture: (typeof LEGACY_CHANGELOG_ROUTE_FIXTURES)[number]) {
  return [
    jsonLdBytes({
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: "https://pharos.watch/" },
        { "@type": "ListItem", position: 2, name: "Methodology", item: "https://pharos.watch/methodology/" },
        {
          "@type": "ListItem",
          position: 3,
          name: fixture.breadcrumbName,
          item: `https://pharos.watch${fixture.path}`,
        },
      ],
    }),
    jsonLdBytes({
      "@context": "https://schema.org",
      "@type": "Article",
      additionalType: "https://schema.org/TechArticle",
      headline: `${fixture.pageTitle} - Version History`,
      description: `${fixture.breadcrumbName} version history for Pharos.`,
      mainEntityOfPage: `https://pharos.watch${fixture.path}`,
      image: "https://pharos.watch/og-editorial-methodology.png",
      datePublished: `${fixture.datePublished}T00:00:00Z`,
      dateModified: `${fixture.dateModified}T00:00:00Z`,
      author: { "@id": "https://pharos.watch#person-tokenbrice" },
      publisher: { "@id": "https://pharos.watch#organization" },
      identifier: [{
        "@type": "PropertyValue",
        propertyID: "Pharos URN",
        value: fixture.citationUrn,
      }],
    }),
  ];
}

function extractJsonLd(html: string): string[] {
  return Array.from(
    html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g),
    (match) => match[1],
  );
}

describe("registry-backed methodology changelog route", () => {
  it("derives the exact public static params from registry publicPath values", () => {
    const expectedSlugs = LEGACY_CHANGELOG_ROUTE_FIXTURES.map(({ slug }) => slug).sort();
    const expectedPaths = LEGACY_CHANGELOG_ROUTE_FIXTURES.map(({ path }) => path).sort();

    expect(generateStaticParams().map(({ slug }) => slug).sort()).toEqual(expectedSlugs);
    expect(METHODOLOGY_CHANGELOG_REGISTRY.map(({ publicPath }) => publicPath).sort()).toEqual(expectedPaths);
    expect([...METHODOLOGY_CHANGELOG_SITEMAP_PATHS].sort()).toEqual(expectedPaths);
  });

  it.each(LEGACY_CHANGELOG_ROUTE_FIXTURES)(
    "preserves $path metadata, OG fields, and citation JSON-LD byte-for-byte",
    async (fixture) => {
      const params = Promise.resolve({ slug: fixture.slug });

      await expect(generateMetadata({ params }))
        .resolves.toEqual(legacyMetadata(fixture));

      const page = await MethodologyChangelogRoute({ params });
      expect(extractJsonLd(renderToStaticMarkup(page))).toEqual(legacyJsonLd(fixture));
    },
  );

  it("retains scoring's authored custom content and anchors", async () => {
    const page = await MethodologyChangelogRoute({
      params: Promise.resolve({ slug: "scoring-changelog" }),
    });
    const html = renderToStaticMarkup(page);

    expect(html).toContain('id="scoring-v6-92"');
    expect(html).toContain('id="scoring-v7-291"');
    expect(html).toContain("Grade threshold evolution");
  });
});
