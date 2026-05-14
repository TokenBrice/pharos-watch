import { describe, expect, it } from "vitest";
import { buildApiArtifactCatalogJsonLd } from "@/lib/api-artifact-json-ld";

describe("buildApiArtifactCatalogJsonLd", () => {
  it("describes public integration artifacts without site-data proxy URLs", () => {
    const jsonLd = buildApiArtifactCatalogJsonLd({ siteUrl: "https://pharos.watch" });
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
            { "@id": "https://pharos.watch/cemetery/#dataset" },
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
  });
});
