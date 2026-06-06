import { describe, expect, it } from "vitest";
import { buildCoverageDatasetJsonLd, buildPublicDatasetMirrorJsonLd } from "@/lib/analytics-dataset-json-ld";

describe("buildCoverageDatasetJsonLd", () => {
  it("describes the coverage matrix dataset without live values or site-data proxy URLs", () => {
    const jsonLd = buildCoverageDatasetJsonLd({ siteUrl: "https://pharos.watch" });
    const serialized = JSON.stringify(jsonLd);

    expect(serialized).not.toContain("/_site-data/");
    expect(serialized).not.toContain("/api/stablecoins");
    expect(serialized).not.toContain("/api/peg-summary");
    expect(serialized).not.toContain("/api/report-cards");
    expect(jsonLd).toMatchObject({
      "@context": "https://schema.org",
      "@type": "Dataset",
      "@id": "https://pharos.watch/coverage/#dataset",
      name: "Pharos Stablecoin Feature Coverage Dataset",
      url: "https://pharos.watch/coverage/",
      inLanguage: "en",
      creator: { "@id": "https://pharos.watch#organization", "@type": "Organization", name: "Pharos" },
      publisher: { "@id": "https://pharos.watch#organization", "@type": "Organization", name: "Pharos" },
      isAccessibleForFree: true,
      license: "https://github.com/TokenBrice/pharos-watch/blob/main/LICENSE",
      includedInDataCatalog: {
        "@type": "DataCatalog",
        "@id": "https://pharos.watch/about/api/#data-catalog",
        name: "Pharos Public API Data Catalog",
        url: "https://pharos.watch/about/api/",
      },
      identifier: [{ "@type": "PropertyValue", propertyID: "Pharos URN", value: "urn:pharos:dataset:coverage" }],
      sameAs: "https://pharos.watch/coverage/",
      mainEntityOfPage: { "@id": "https://pharos.watch/coverage/" },
    });
    expect(jsonLd).not.toHaveProperty("isPartOf");
    expect(jsonLd).not.toHaveProperty("distribution");
    expect(jsonLd).not.toHaveProperty("dateModified");
    expect(jsonLd.variableMeasured).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "priceAndDepegCoverage", description: expect.any(String) }),
        expect.objectContaining({ name: "reserveViewCoverage", description: expect.any(String) }),
        expect.objectContaining({ name: "mintBurnFlowCoverage", description: expect.any(String) }),
        expect.objectContaining({ name: "dependencyMapCoverage", description: expect.any(String) }),
      ]),
    );
  });
});

describe("buildPublicDatasetMirrorJsonLd", () => {
  it("describes public mirrored datasets with downloadable distributions", () => {
    const jsonLd = buildPublicDatasetMirrorJsonLd("scores-latest", {
      siteUrl: "https://pharos.watch",
    });
    const serialized = JSON.stringify(jsonLd);

    expect(serialized).not.toContain("/_site-data/");
    expect(jsonLd).toMatchObject({
      "@context": "https://schema.org",
      "@type": "Dataset",
      "@id": "https://pharos.watch/datasets/scores-latest/#dataset",
      name: "Pharos Latest Stablecoin Scores Dataset",
      url: "https://pharos.watch/datasets/scores-latest/latest.json",
      creator: { "@id": "https://pharos.watch#organization", "@type": "Organization", name: "Pharos" },
      publisher: { "@id": "https://pharos.watch#organization", "@type": "Organization", name: "Pharos" },
      license: "https://github.com/TokenBrice/pharos-watch/blob/main/LICENSE",
      includedInDataCatalog: {
        "@type": "DataCatalog",
        "@id": "https://pharos.watch/about/api/#data-catalog",
        name: "Pharos Public API Data Catalog",
        url: "https://pharos.watch/about/api/",
      },
      identifier: [{ "@type": "PropertyValue", propertyID: "Pharos URN", value: "urn:pharos:dataset:scores-latest" }],
      sameAs: "https://pharos.watch/datasets/scores-latest/latest.json",
    });
    expect(jsonLd.distribution).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          "@type": "DataDownload",
          contentUrl: "https://pharos.watch/datasets/scores-latest/latest.json",
          encodingFormat: "application/json",
        }),
        expect.objectContaining({
          "@type": "DataDownload",
          contentUrl: "https://pharos.watch/datasets/scores-latest/latest.csv",
          encodingFormat: "text/csv",
        }),
        expect.objectContaining({
          "@type": "DataDownload",
          contentUrl: "https://pharos.watch/sheets/scores-latest.csv",
          encodingFormat: "text/csv",
        }),
      ]),
    );
  });
});
