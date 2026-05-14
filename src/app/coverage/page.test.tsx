import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import CoveragePage from "./page";

function extractJsonLd(html: string) {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((match) => match[1])
    .filter((json): json is string => Boolean(json))
    .map((json) => JSON.parse(json));
}

vi.mock("next/dynamic", () => ({
  default: () => function DynamicCoverageClient() {
    return <section>coverage matrix client</section>;
  },
}));

describe("CoveragePage", () => {
  it("emits static coverage Dataset JSON-LD without site-data URLs", () => {
    const html = renderToStaticMarkup(<CoveragePage />);
    const jsonLd = extractJsonLd(html).flat();
    const dataset = jsonLd.find((node) => node["@type"] === "Dataset");

    expect(dataset).toMatchObject({
      "@context": "https://schema.org",
      "@type": "Dataset",
      "@id": "https://pharos.watch/coverage/#dataset",
      name: "Pharos Stablecoin Feature Coverage Dataset",
      url: "https://pharos.watch/coverage/",
      isAccessibleForFree: true,
      includedInDataCatalog: { "@id": "https://pharos.watch/about/api/#data-catalog" },
    });
    expect(dataset).not.toHaveProperty("distribution");
    expect(dataset).not.toHaveProperty("dateModified");
    expect(dataset.variableMeasured).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "priceAndDepegCoverage" }),
        expect.objectContaining({ name: "safetyScoreCoverage" }),
        expect.objectContaining({ name: "blacklistCoverage" }),
      ]),
    );
    expect(JSON.stringify(jsonLd)).not.toContain("/_site-data/");
  });
});
