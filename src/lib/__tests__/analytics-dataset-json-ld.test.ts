import { describe, expect, it } from "vitest";
import { buildCoverageDatasetJsonLd } from "@/lib/analytics-dataset-json-ld";

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
      creator: { "@id": "https://pharos.watch#organization" },
      publisher: { "@id": "https://pharos.watch#organization" },
      isAccessibleForFree: true,
      includedInDataCatalog: { "@id": "https://pharos.watch/about/api/#data-catalog" },
      mainEntityOfPage: { "@id": "https://pharos.watch/coverage/" },
    });
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
