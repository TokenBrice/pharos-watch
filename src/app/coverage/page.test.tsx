import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import CoveragePage from "./page";
import { extractJsonLd, findJsonLdNode } from "@/test/json-ld";

vi.mock("next/dynamic", () => ({
  default: () => function DynamicCoverageClient() {
    return <section>coverage matrix client</section>;
  },
}));

describe("CoveragePage", () => {
  it("emits static coverage Dataset JSON-LD without site-data URLs", () => {
    const html = renderToStaticMarkup(<CoveragePage />);
    const jsonLd = extractJsonLd(html);
    const dataset = findJsonLdNode(jsonLd, (node) => node["@type"] === "Dataset", "Dataset");

    expect(dataset).toMatchObject({
      "@context": "https://schema.org",
      "@type": "Dataset",
      "@id": "https://pharos.watch/coverage/#dataset",
      name: "Pharos Stablecoin Feature Coverage Dataset",
      url: "https://pharos.watch/coverage/",
      isAccessibleForFree: true,
      includedInDataCatalog: {
        "@type": "DataCatalog",
        "@id": "https://pharos.watch/about/api/#data-catalog",
        name: "Pharos Public API Data Catalog",
        url: "https://pharos.watch/about/api/",
      },
    });
    expect(dataset).not.toHaveProperty("isPartOf");
    expect(dataset).not.toHaveProperty("distribution");
    expect(dataset).not.toHaveProperty("dateModified");
    expect(dataset.variableMeasured).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "priceAndDepegCoverage" }),
        expect.objectContaining({ name: "safetyScoreCoverage" }),
        expect.objectContaining({ name: "redemptionBackstopCoverage" }),
        expect.objectContaining({ name: "blacklistCoverage" }),
      ]),
    );
    expect(JSON.stringify(jsonLd)).not.toContain("/_site-data/");
  });
});
