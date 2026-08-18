import { describe, expect, it } from "vitest";
import { buildCemeteryDatasetJsonLd } from "@/lib/cemetery-json-ld";

describe("buildCemeteryDatasetJsonLd", () => {
  it("describes the public cemetery dataset downloads", () => {
    const jsonLd = buildCemeteryDatasetJsonLd();

    expect(jsonLd).toMatchObject({
      "@context": "https://schema.org",
      "@type": "Dataset",
      "@id": "https://pharos.watch/cemetery/#dataset",
      name: "Pharos Stablecoin Cemetery Dataset",
      description: expect.stringContaining("defunct"),
      url: "https://pharos.watch/cemetery/",
      creator: { "@id": "https://pharos.watch#organization", "@type": "Organization", name: "Pharos" },
      publisher: { "@id": "https://pharos.watch#organization", "@type": "Organization", name: "Pharos" },
      license: "https://github.com/TokenBrice/pharos-watch/blob/main/LICENSE",
      isAccessibleForFree: true,
      sameAs: "https://pharos.watch/datasets/stablecoin-cemetery.json",
      distribution: [
        {
          "@type": "DataDownload",
          "@id": "https://pharos.watch/datasets/stablecoin-cemetery.json#download",
          encodingFormat: "application/json",
          contentUrl: "https://pharos.watch/datasets/stablecoin-cemetery.json",
        },
        {
          "@type": "DataDownload",
          "@id": "https://pharos.watch/datasets/stablecoin-cemetery.csv#download",
          encodingFormat: "text/csv",
          contentUrl: "https://pharos.watch/datasets/stablecoin-cemetery.csv",
        },
      ],
    });
    expect(jsonLd.variableMeasured).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "id", description: expect.any(String) }),
        expect.objectContaining({ name: "deathDate", description: expect.any(String) }),
        expect.objectContaining({ name: "archivedDataAvailable", description: expect.any(String) }),
      ]),
    );
    expect(jsonLd.additionalProperty).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "rowCount", value: expect.any(Number) }),
        expect.objectContaining({ name: "sourceDataPath", value: "shared/lib/cemetery-merged.ts" }),
        expect.objectContaining({ name: "sourceDataFile", value: "shared/data/dead-stablecoins.json" }),
        expect.objectContaining({
          name: "sourceDataFile",
          value: "shared/lib/cemetery-merged.ts#frozenCemeteryProjection",
        }),
      ]),
    );
    expect(jsonLd.identifier).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ propertyID: "Pharos URN", value: "urn:pharos:dataset:stablecoin-cemetery" }),
        expect.objectContaining({ propertyID: "sourceChecksum" }),
        expect.objectContaining({ propertyID: "sourceChecksum:shared/data/dead-stablecoins.json" }),
        expect.objectContaining({
          propertyID: "sourceChecksum:shared/lib/cemetery-merged.ts#frozenCemeteryProjection",
        }),
      ]),
    );
    expect(JSON.stringify(jsonLd)).not.toContain("/_site-data/");
  });
});
