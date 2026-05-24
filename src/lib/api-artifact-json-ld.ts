import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { PUBLIC_API_HOST } from "@shared/lib/public-api-contract";
import depegHistoryExport from "../../public/datasets/depeg-history/latest.json";
import pegMechanismDistributionExport from "../../public/datasets/peg-mechanism-distribution/latest.json";
import scoresLatestExport from "../../public/datasets/scores-latest/latest.json";
import topStablecoinsExport from "../../public/datasets/top-stablecoins/latest.json";
import { buildCoverageDatasetJsonLd } from "@/lib/analytics-dataset-json-ld";
import { buildCemeteryDatasetJsonLd } from "@/lib/cemetery-json-ld";

type PublicDatasetExport = {
  _meta: {
    endpoint: string;
    asOfISO?: string;
    methodologyLabel?: string;
    rowCount?: number;
  };
  rows: Record<string, unknown>[];
};

interface PublicDatasetDescriptor {
  slug: string;
  name: string;
  description: string;
  keywords: string[];
  export: PublicDatasetExport;
}

const PUBLIC_DATASET_EXPORTS: readonly PublicDatasetDescriptor[] = [
  {
    slug: "top-stablecoins",
    name: "Pharos Top Stablecoins Dataset",
    description:
      "Public snapshot of tracked stablecoins with peg type, peg mechanism, price, circulating USD supply, chain count, and chain coverage.",
    keywords: ["stablecoin market cap", "stablecoin supply", "stablecoin chains", "stablecoin dataset"],
    export: topStablecoinsExport as PublicDatasetExport,
  },
  {
    slug: "scores-latest",
    name: "Pharos Latest Stablecoin Scores Dataset",
    description:
      "Public snapshot of latest PegScore, Safety Score, DEWS, LiquidityScore, grade, and coverage-class values for tracked stablecoins.",
    keywords: ["stablecoin safety scores", "PegScore", "DEWS", "LiquidityScore", "stablecoin risk data"],
    export: scoresLatestExport as PublicDatasetExport,
  },
  {
    slug: "depeg-history",
    name: "Pharos Depeg History Dataset",
    description:
      "Public history of tracked depeg events with stablecoin IDs, direction, peak deviation, timing, duration, prices, peg reference, and source.",
    keywords: ["stablecoin depeg history", "depeg events", "peg monitoring", "stablecoin incident data"],
    export: depegHistoryExport as PublicDatasetExport,
  },
  {
    slug: "peg-mechanism-distribution",
    name: "Pharos Peg Mechanism Distribution Dataset",
    description:
      "Public market-structure export summarizing stablecoin counts by mechanism archetype, peg reference, and jurisdiction.",
    keywords: ["stablecoin mechanisms", "peg mechanism distribution", "stablecoin market structure"],
    export: pegMechanismDistributionExport as PublicDatasetExport,
  },
] as const;

function datasetDate(dataset: PublicDatasetExport): string | undefined {
  return dataset._meta.asOfISO?.slice(0, 10);
}

function buildDatasetDistributions(siteUrl: string, descriptor: PublicDatasetDescriptor) {
  const date = datasetDate(descriptor.export);
  const formats = [
    ["JSON", "application/json", "json"],
    ["CSV", "text/csv", "csv"],
    ["NDJSON", "application/x-ndjson", "ndjson"],
  ] as const;

  return [
    ...formats.map(([label, encodingFormat, extension]) => ({
      "@type": "DataDownload",
      "@id": `${siteUrl}/datasets/${descriptor.slug}/latest.${extension}#download`,
      name: `${descriptor.name} latest ${label} export`,
      encodingFormat,
      contentUrl: `${siteUrl}/datasets/${descriptor.slug}/latest.${extension}`,
    })),
    ...(date
      ? formats.map(([label, encodingFormat, extension]) => ({
        "@type": "DataDownload",
        "@id": `${siteUrl}/datasets/${descriptor.slug}/${date}.${extension}#download`,
        name: `${descriptor.name} ${date} ${label} export`,
        encodingFormat,
        contentUrl: `${siteUrl}/datasets/${descriptor.slug}/${date}.${extension}`,
      }))
      : []),
    {
      "@type": "DataDownload",
      "@id": `${siteUrl}/sheets/${descriptor.slug}.csv#download`,
      name: `${descriptor.name} Google Sheets CSV export`,
      encodingFormat: "text/csv",
      contentUrl: `${siteUrl}/sheets/${descriptor.slug}.csv`,
    },
  ];
}

function buildPublicDatasetJsonLd(siteUrl: string, descriptor: PublicDatasetDescriptor, catalogId: string) {
  const organization = { "@id": `${siteUrl}#organization` };
  const rowFields = Object.keys(descriptor.export.rows[0] ?? {});
  const date = datasetDate(descriptor.export);
  const additionalProperty = [
    { "@type": "PropertyValue", name: "endpoint", value: descriptor.export._meta.endpoint },
    { "@type": "PropertyValue", name: "rowCount", value: descriptor.export._meta.rowCount },
    { "@type": "PropertyValue", name: "methodologyLabel", value: descriptor.export._meta.methodologyLabel },
  ].filter((property) => property.value !== undefined);

  return {
    "@context": "https://schema.org",
    "@type": "Dataset",
    "@id": `${siteUrl}/datasets/${descriptor.slug}/#dataset`,
    name: descriptor.name,
    description: descriptor.description,
    url: `${siteUrl}/datasets/${descriptor.slug}/latest.json`,
    creator: organization,
    publisher: organization,
    isAccessibleForFree: true,
    license: "https://github.com/TokenBrice/pharos-watch/blob/main/LICENSE",
    includedInDataCatalog: { "@id": catalogId },
    ...(date ? { dateModified: date } : {}),
    keywords: descriptor.keywords,
    variableMeasured: rowFields.map((name) => ({
      "@type": "PropertyValue",
      name,
    })),
    distribution: buildDatasetDistributions(siteUrl, descriptor),
    additionalProperty,
  };
}

export function buildApiArtifactCatalogJsonLd(options: { siteUrl?: string } = {}) {
  const siteUrl = options.siteUrl ?? SITE_URL;
  const catalogId = `${siteUrl}/about/api/#data-catalog`;
  const organization = { "@id": `${siteUrl}#organization` };
  const coverageDataset = buildCoverageDatasetJsonLd({ siteUrl });
  const cemeteryDataset = buildCemeteryDatasetJsonLd();
  const publicDatasets = PUBLIC_DATASET_EXPORTS.map((descriptor) =>
    buildPublicDatasetJsonLd(siteUrl, descriptor, catalogId),
  );

  return [
    {
      "@context": "https://schema.org",
      "@type": "DataCatalog",
      "@id": catalogId,
      name: "Pharos Public API Data Catalog",
      description:
        "Machine-readable Pharos integration artifacts and public stablecoin data surfaces for external API consumers.",
      url: `${siteUrl}/about/api/`,
      inLanguage: "en",
      provider: organization,
      publisher: organization,
      isAccessibleForFree: true,
      dataset: [
        { "@id": `${siteUrl}/about/api/#openapi-spec` },
        { "@id": `${siteUrl}/about/api/#postman-collection` },
        { "@id": `${siteUrl}/about/api/#postman-environment` },
        { "@id": `${siteUrl}/coverage/#dataset` },
        { "@id": `${siteUrl}/cemetery/#dataset` },
        ...PUBLIC_DATASET_EXPORTS.map((descriptor) => ({
          "@id": `${siteUrl}/datasets/${descriptor.slug}/#dataset`,
        })),
      ],
    },
    {
      "@context": "https://schema.org",
      "@type": "WebAPI",
      "@id": `${siteUrl}/about/api/#webapi`,
      name: "Pharos API",
      description:
        "Read-only public integration API for stablecoin market, peg, liquidity, risk, blacklist, yield, chain, and flow data.",
      url: `${siteUrl}/about/api/`,
      documentation: `${siteUrl}/about/api/`,
      endpointUrl: PUBLIC_API_HOST,
      provider: organization,
      isPartOf: { "@id": catalogId },
    },
    {
      "@context": "https://schema.org",
      "@type": "CreativeWork",
      "@id": `${siteUrl}/about/api/#openapi-spec`,
      additionalType: "https://schema.org/APIReference",
      name: "Pharos OpenAPI Specification",
      description: "OpenAPI 3.1 specification for the public Pharos API endpoint catalog.",
      url: `${siteUrl}/openapi.json`,
      encodingFormat: "application/json",
      isAccessibleForFree: true,
      isPartOf: { "@id": catalogId },
      publisher: organization,
    },
    {
      "@context": "https://schema.org",
      "@type": "CreativeWork",
      "@id": `${siteUrl}/about/api/#postman-collection`,
      name: "Pharos Postman Collection",
      description: "Postman collection for testing and importing public Pharos API requests.",
      url: `${siteUrl}/postman/pharos-api.postman_collection.json`,
      encodingFormat: "application/json",
      isAccessibleForFree: true,
      isPartOf: { "@id": catalogId },
      publisher: organization,
    },
    {
      "@context": "https://schema.org",
      "@type": "CreativeWork",
      "@id": `${siteUrl}/about/api/#postman-environment`,
      name: "Pharos Postman Environment",
      description: "Postman environment template for the production Pharos API host.",
      url: `${siteUrl}/postman/pharos-api.postman_environment.json`,
      encodingFormat: "application/json",
      isAccessibleForFree: true,
      isPartOf: { "@id": catalogId },
      publisher: organization,
    },
    { ...cemeteryDataset, includedInDataCatalog: { "@id": catalogId } },
    coverageDataset,
    ...publicDatasets,
  ];
}
