import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import cemeteryDatasetExport from "../../public/datasets/stablecoin-cemetery.json";

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
  recordsOrderedBy: string;
  rowCount: number;
  limitations: string[];
  fields: Record<string, string>;
};

const cemeteryDataset = cemeteryDatasetExport as CemeteryDatasetExport;

export function buildCemeteryDatasetJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "Dataset",
    "@id": `${cemeteryDataset.canonicalUrl}#dataset`,
    name: cemeteryDataset.name,
    description: cemeteryDataset.description,
    url: cemeteryDataset.canonicalUrl,
    creator: { "@id": `${SITE_URL}#organization` },
    publisher: { "@id": `${SITE_URL}#organization` },
    license: cemeteryDataset.license,
    isAccessibleForFree: true,
    keywords: [
      "stablecoin cemetery",
      "defunct stablecoins",
      "depegged stablecoins",
      "stablecoin failures",
      "stablecoin dataset",
    ],
    identifier: [
      { "@type": "PropertyValue", propertyID: "sourceChecksum", value: cemeteryDataset.sourceChecksum },
      { "@type": "PropertyValue", propertyID: "schemaVersion", value: cemeteryDataset.schemaVersion },
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
      ...cemeteryDataset.limitations.map((limitation) => ({
        "@type": "PropertyValue",
        name: "limitation",
        value: limitation,
      })),
    ],
  };
}
