import { describe, expect, it } from "vitest";
import { buildApiArtifactCatalogJsonLd } from "@/lib/api-artifact-json-ld";

describe("buildApiArtifactCatalogJsonLd", () => {
  it("describes public integration artifacts without site-data proxy URLs", () => {
    const jsonLd = buildApiArtifactCatalogJsonLd();
    const serialized = JSON.stringify(jsonLd);

    expect(serialized).not.toContain("/_site-data/");
    expect(jsonLd).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          "@type": "DataCatalog",
          "@id": "https://pharos.watch/about/api/#data-catalog",
          dataset: expect.arrayContaining([
            { "@id": "https://pharos.watch/about/api/#openapi-spec" },
            { "@id": "https://pharos.watch/about/api/#postman-collection" },
            { "@id": "https://pharos.watch/about/api/#postman-environment" },
            { "@id": "https://pharos.watch/coverage/#dataset" },
            { "@id": "https://pharos.watch/cemetery/#dataset" },
            { "@id": "https://pharos.watch/datasets/top-stablecoins/#dataset" },
            { "@id": "https://pharos.watch/datasets/scores-latest/#dataset" },
            { "@id": "https://pharos.watch/datasets/depeg-history/#dataset" },
            { "@id": "https://pharos.watch/datasets/peg-mechanism-distribution/#dataset" },
          ]),
        }),
        expect.objectContaining({
          "@type": "WebAPI",
          endpointUrl: "https://api.pharos.watch",
          documentation: "https://pharos.watch/about/api/",
        }),
        expect.objectContaining({
          "@type": "CreativeWork",
          additionalType: "https://schema.org/APIReference",
          url: "https://pharos.watch/openapi.json",
        }),
        expect.objectContaining({
          "@type": "Dataset",
          "@id": "https://pharos.watch/cemetery/#dataset",
          includedInDataCatalog: {
            "@type": "DataCatalog",
            "@id": "https://pharos.watch/about/api/#data-catalog",
            name: "Pharos Public API Data Catalog",
            url: "https://pharos.watch/about/api/",
          },
          distribution: expect.arrayContaining([
            expect.objectContaining({
              "@type": "DataDownload",
              contentUrl: "https://pharos.watch/datasets/stablecoin-cemetery.json",
              encodingFormat: "application/json",
            }),
            expect.objectContaining({
              "@type": "DataDownload",
              contentUrl: "https://pharos.watch/datasets/stablecoin-cemetery.csv",
              encodingFormat: "text/csv",
            }),
          ]),
        }),
      ]),
    );
    const cemetery = jsonLd.find((node) => node["@id"] === "https://pharos.watch/cemetery/#dataset");
    expect(cemetery).not.toHaveProperty("isPartOf");

    expect(jsonLd).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          "@type": "Dataset",
          "@id": "https://pharos.watch/coverage/#dataset",
          includedInDataCatalog: {
            "@type": "DataCatalog",
            "@id": "https://pharos.watch/about/api/#data-catalog",
            name: "Pharos Public API Data Catalog",
            url: "https://pharos.watch/about/api/",
          },
        }),
        expect.objectContaining({
          "@type": "Dataset",
          "@id": "https://pharos.watch/datasets/top-stablecoins/#dataset",
          url: "https://pharos.watch/datasets/top-stablecoins/latest.json",
          includedInDataCatalog: {
            "@type": "DataCatalog",
            "@id": "https://pharos.watch/about/api/#data-catalog",
            name: "Pharos Public API Data Catalog",
            url: "https://pharos.watch/about/api/",
          },
          distribution: expect.arrayContaining([
            expect.objectContaining({
              contentUrl: "https://pharos.watch/datasets/top-stablecoins/latest.json",
              encodingFormat: "application/json",
            }),
            expect.objectContaining({
              contentUrl: "https://pharos.watch/datasets/top-stablecoins/latest.csv",
              encodingFormat: "text/csv",
            }),
            expect.objectContaining({
              contentUrl: "https://pharos.watch/datasets/top-stablecoins/latest.ndjson",
              encodingFormat: "application/x-ndjson",
            }),
            expect.objectContaining({
              contentUrl: "https://pharos.watch/sheets/top-stablecoins.csv",
              encodingFormat: "text/csv",
            }),
          ]),
        }),
      ]),
    );
  });
});
