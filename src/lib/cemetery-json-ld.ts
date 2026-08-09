import cemeteryDatasetExport from "../../public/datasets/stablecoin-cemetery.json";
import { buildPharosOrganizationNode } from "@/lib/json-ld";
import { buildPharosUrnJsonLdIdentifier } from "@/lib/pharos-urn-json-ld";

type CemeteryDatasetExport = {
  schemaVersion: string;
  name: string;
  description: string;
  license: string;
  canonicalUrl: string;
  jsonUrl: string;
  csvUrl: string;
  sourceDataPath: string;
  sourceChecksum: string;
  sourceData?: {
    path: string;
    checksum: string;
    role: string;
  }[];
  recordsOrderedBy: string;
  rowCount: number;
  limitations: string[];
  fields: Record<string, string>;
};

const cemeteryDataset = cemeteryDatasetExport as CemeteryDatasetExport;
const PHAROS_DATA_LICENSE_URL = "https://github.com/TokenBrice/pharos-watch/blob/main/LICENSE";
const cemeterySourceData = cemeteryDataset.sourceData ?? [
  {
    path: cemeteryDataset.sourceDataPath,
    checksum: cemeteryDataset.sourceChecksum,
    role: "Dataset source metadata.",
  },
];

export function buildCemeteryDatasetJsonLd() {
  const organization = buildPharosOrganizationNode();

  return {
    "@context": "https://schema.org",
    "@type": "Dataset",
    "@id": `${cemeteryDataset.canonicalUrl}#dataset`,
    name: cemeteryDataset.name,
    description: cemeteryDataset.description,
    url: cemeteryDataset.canonicalUrl,
    creator: organization,
    publisher: organization,
    license: PHAROS_DATA_LICENSE_URL,
    isAccessibleForFree: true,
    sameAs: cemeteryDataset.jsonUrl,
    keywords: [
      "stablecoin cemetery",
      "defunct stablecoins",
      "depegged stablecoins",
      "stablecoin failures",
      "stablecoin dataset",
    ],
    identifier: [
      buildPharosUrnJsonLdIdentifier("dataset", "stablecoin-cemetery"),
      { "@type": "PropertyValue", propertyID: "sourceChecksum", value: cemeteryDataset.sourceChecksum },
      { "@type": "PropertyValue", propertyID: "schemaVersion", value: cemeteryDataset.schemaVersion },
      ...cemeterySourceData.map((source) => ({
        "@type": "PropertyValue",
        propertyID: `sourceChecksum:${source.path}`,
        value: source.checksum,
      })),
    ],
    variableMeasured: Object.entries(cemeteryDataset.fields).map(([name, description]) => ({
      "@type": "PropertyValue",
      name,
      description,
    })),
    distribution: [
      {
        "@type": "DataDownload",
        "@id": `${cemeteryDataset.jsonUrl}#download`,
        name: `${cemeteryDataset.name} JSON export`,
        encodingFormat: "application/json",
        contentUrl: cemeteryDataset.jsonUrl,
      },
      {
        "@type": "DataDownload",
        "@id": `${cemeteryDataset.csvUrl}#download`,
        name: `${cemeteryDataset.name} CSV export`,
        encodingFormat: "text/csv",
        contentUrl: cemeteryDataset.csvUrl,
      },
    ],
    additionalProperty: [
      { "@type": "PropertyValue", name: "rowCount", value: cemeteryDataset.rowCount },
      { "@type": "PropertyValue", name: "recordsOrderedBy", value: cemeteryDataset.recordsOrderedBy },
      { "@type": "PropertyValue", name: "sourceDataPath", value: cemeteryDataset.sourceDataPath },
      ...cemeterySourceData.map((source) => ({
        "@type": "PropertyValue",
        name: "sourceDataFile",
        value: source.path,
        description: source.role,
      })),
      ...cemeteryDataset.limitations.map((limitation) => ({
        "@type": "PropertyValue",
        name: "limitation",
        value: limitation,
      })),
    ],
  };
}
