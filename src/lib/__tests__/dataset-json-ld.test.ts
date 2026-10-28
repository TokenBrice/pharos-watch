import { describe, expect, it } from "vitest";
import {
  buildPublicDatasetCitation,
  buildPublicDatasetMirrorJsonLd,
  PHAROS_DATA_LICENSE_URL,
  PHAROS_PUBLIC_DATA_CATALOG_ID,
  PUBLIC_DATASET_JSON_LD_DESCRIPTORS,
  type PublicDatasetDescriptor,
} from "@/lib/analytics-dataset-json-ld";
import { buildCemeteryDatasetJsonLd } from "@/lib/cemetery-json-ld";
import { PUBLIC_DATASET_CURRENT_DATE, PUBLIC_DATASET_CURRENT_EXPORTS } from "@/lib/datasets/public-dataset-current";

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

describe("public dataset citations", () => {
  it.each([...PUBLIC_DATASET_JSON_LD_DESCRIPTORS])("cites $slug from its descriptor metadata", (descriptor) => {
    const citation = buildPublicDatasetCitation(descriptor);
    const meta = descriptor.export._meta;

    expect(citation).toContain(`Pharos, "${descriptor.name}," snapshot edition ${PUBLIC_DATASET_CURRENT_DATE}`);
    expect(citation).toContain(`as of ${meta.asOfISO}`);
    expect(citation).toContain(`methodology ${meta.methodologyLabel}`);
    expect(citation).toContain(`https://pharos.watch/api/reference/#dataset-${descriptor.slug}`);
    expect(citation).toContain(
      `Data: https://pharos.watch/datasets/${descriptor.slug}/${PUBLIC_DATASET_CURRENT_DATE}.json. MIT.`,
    );
  });

  it("keeps the depeg capture clock out of the dated download path", () => {
    const descriptor = PUBLIC_DATASET_JSON_LD_DESCRIPTORS.find((candidate) => candidate.slug === "depeg-history");
    if (!descriptor) throw new Error("Missing depeg-history descriptor");
    const meta = descriptor.export._meta;
    const captureDate = meta.asOfISO!.slice(0, 10);
    expect(captureDate).not.toBe(PUBLIC_DATASET_CURRENT_DATE);

    const citation = buildPublicDatasetCitation(descriptor);
    expect(citation).toContain(`as of ${meta.asOfISO}`);
    expect(citation).toContain(`/datasets/depeg-history/${PUBLIC_DATASET_CURRENT_DATE}.json`);
    expect(citation).not.toContain(`/datasets/depeg-history/${captureDate}.json`);
    expect(citation).toContain(`source generation ${meta.sourceGeneration}`);
    expect(citation).toContain(meta.freshnessContract!);
  });

  it("uses explicit unavailable values instead of inventing metadata", () => {
    const descriptor: PublicDatasetDescriptor = {
      slug: "top-stablecoins",
      name: "Fixture Dataset",
      description: "Fixture descriptor without export metadata.",
      keywords: [],
      export: { _meta: { endpoint: "top-stablecoins" }, rows: [] },
    };

    const citation = buildPublicDatasetCitation(descriptor);
    expect(citation).toContain("as of Snapshot time unavailable");
    expect(citation).toContain("methodology Methodology version unavailable");
    expect(citation).not.toContain("undefined");
    expect(citation).toContain(`/datasets/top-stablecoins/${PUBLIC_DATASET_CURRENT_DATE}.json`);
  });

  it.each([...PUBLIC_DATASET_JSON_LD_DESCRIPTORS])("shares the MIT license and dated metadata with $slug JSON-LD", (descriptor) => {
    const jsonLd = buildPublicDatasetMirrorJsonLd(descriptor.slug);
    const meta = descriptor.export._meta;
    expect(jsonLd.license).toBe(PHAROS_DATA_LICENSE_URL);
    expect(jsonLd.dateModified).toBe(meta.asOfISO?.slice(0, 10));
    expect(jsonLd.additionalProperty).toContainEqual({
      "@type": "PropertyValue",
      name: "methodologyLabel",
      value: meta.methodologyLabel,
    });
    expect(buildPublicDatasetCitation(descriptor)).toContain(`as of ${meta.asOfISO}`);
  });
});
