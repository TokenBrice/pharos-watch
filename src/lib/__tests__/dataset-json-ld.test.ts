import { describe, expect, it } from "vitest";
import { buildPublicDatasetMirrorJsonLd, PHAROS_PUBLIC_DATA_CATALOG_ID } from "@/lib/analytics-dataset-json-ld";
import { buildCemeteryDatasetJsonLd } from "@/lib/cemetery-json-ld";
import { PUBLIC_DATASET_CURRENT_EXPORTS } from "@/lib/datasets/public-dataset-current";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INTERVAL = /^\d{4}-\d{2}[-\d]{0,3}\/\d{4}-\d{2}[-\d]{0,3}$/;

describe("flagship Dataset JSON-LD", () => {
  it("dates the depeg history window from its earliest row start to the export snapshot", () => {
    const jsonLd = buildPublicDatasetMirrorJsonLd("depeg-history");
    const rows = PUBLIC_DATASET_CURRENT_EXPORTS["depeg-history"].rows as { startedAtISO: string }[];
    const earliest = rows.map((row) => row.startedAtISO).sort()[0].slice(0, 10);

    expect(jsonLd.temporalCoverage).toBe(`${earliest}/${jsonLd.dateModified}`);
    expect(jsonLd.temporalCoverage).toMatch(ISO_INTERVAL);
  });

  it("dates point-in-time score snapshots to the export date", () => {
    const jsonLd = buildPublicDatasetMirrorJsonLd("scores-latest");
    expect(jsonLd.temporalCoverage).toMatch(ISO_DATE);
    expect(jsonLd.temporalCoverage).toBe(jsonLd.dateModified);
  });

  it.each(["depeg-history", "scores-latest"] as const)("keeps %s downloads, license and creator @id", (topic) => {
    const jsonLd = buildPublicDatasetMirrorJsonLd(topic);
    expect(jsonLd.distribution.map((download) => download.encodingFormat)).toEqual(
      expect.arrayContaining(["application/json", "text/csv"]),
    );
    expect(jsonLd.license).toMatch(/^https:\/\//);
    expect(jsonLd.creator["@id"]).toBe("https://pharos.watch#organization");
  });

  it("gives the cemetery a death-date coverage interval and its data catalog", () => {
    const jsonLd = buildCemeteryDatasetJsonLd();
    expect(jsonLd.temporalCoverage).toMatch(ISO_INTERVAL);
    expect(jsonLd.includedInDataCatalog["@id"]).toBe(PHAROS_PUBLIC_DATA_CATALOG_ID);
    expect(jsonLd.creator["@id"]).toBe("https://pharos.watch#organization");
    expect(jsonLd.distribution.map((download) => download.encodingFormat)).toEqual(["application/json", "text/csv"]);
  });
});
