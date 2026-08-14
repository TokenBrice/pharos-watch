import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import type { PublicDatasetTopic } from "@shared/lib/api-endpoints/datasets";
import depegHistoryExport from "../../public/datasets/depeg-history/latest.json";
import pegMechanismDistributionExport from "../../public/datasets/peg-mechanism-distribution/latest.json";
import scoresLatestExport from "../../public/datasets/scores-latest/latest.json";
import topStablecoinsExport from "../../public/datasets/top-stablecoins/latest.json";
import { buildPharosOrganizationNode } from "@/lib/json-ld";
import { buildPharosUrnJsonLdIdentifier } from "@/lib/pharos-urn-json-ld";

type PublicDatasetExport = {
  _meta: {
    endpoint: string;
    asOfISO?: string;
    methodologyLabel?: string;
    rowCount?: number;
  };
  rows: Record<string, unknown>[];
};

export interface PublicDatasetDescriptor {
  slug: PublicDatasetTopic;
  name: string;
  description: string;
  keywords: string[];
  export: PublicDatasetExport;
}

export const PUBLIC_DATASET_JSON_LD_DESCRIPTORS: readonly PublicDatasetDescriptor[] = [
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

const COVERAGE_VARIABLES = [
  {
    name: "priceAndDepegCoverage",
    description: "Whether Pharos has current peg tracking or price-only coverage for each active stablecoin.",
  },
  {
    name: "safetyScoreCoverage",
    description: "Whether each active stablecoin has a published Pharos Safety Score.",
  },
  {
    name: "dexPriceCoverage",
    description: "DEX price coverage class for each active stablecoin where liquidity data is available.",
  },
  {
    name: "reserveViewCoverage",
    description: "Reserve-view availability and reserve-source class for each active stablecoin.",
  },
  {
    name: "redemptionBackstopCoverage",
    description: "Modeled redemption route availability for active stablecoins with redemption backstop data.",
  },
  {
    name: "yieldCoverage",
    description: "Whether each active stablecoin appears in the Pharos yield intelligence ranking dataset.",
  },
  {
    name: "mintBurnFlowCoverage",
    description: "Configured issuance-chain mint and burn flow coverage state for each active stablecoin.",
  },
  {
    name: "blacklistCoverage",
    description: "Freeze and blacklist event-tracker coverage for directly blacklistable stablecoins.",
  },
  {
    name: "micaCoverage",
    description: "EU MiCA assessment status coverage for each active stablecoin where compliance metadata is available.",
  },
  {
    name: "geniusCoverage",
    description:
      "U.S. GENIUS Act assessment status coverage for each active stablecoin where compliance metadata is available.",
  },
  {
    name: "dependencyMapCoverage",
    description:
      "Resolved dependency-map role for each active stablecoin, including upstream hubs, dependents, resolved no-dependency rows, and unmapped gaps.",
  },
] as const;

const PHAROS_DATA_LICENSE_URL = "https://github.com/TokenBrice/pharos-watch/blob/main/LICENSE";
export const PHAROS_PUBLIC_DATA_CATALOG_NAME = "Pharos Public API Data Catalog";

/** Canonical `@id` of the public data catalog every dataset node points at. */
export const PHAROS_PUBLIC_DATA_CATALOG_ID = `${SITE_URL}/about/api/#data-catalog`;

export function buildPharosDataCatalogReference() {
  return {
    "@type": "DataCatalog",
    "@id": PHAROS_PUBLIC_DATA_CATALOG_ID,
    name: PHAROS_PUBLIC_DATA_CATALOG_NAME,
    url: `${SITE_URL}/about/api/`,
  };
}

function datasetDate(dataset: PublicDatasetExport): string | undefined {
  return dataset._meta.asOfISO?.slice(0, 10);
}

function buildDatasetDistributions(descriptor: PublicDatasetDescriptor) {
  const formats = [
    ["JSON", "application/json", "json"],
    ["CSV", "text/csv", "csv"],
    ["NDJSON", "application/x-ndjson", "ndjson"],
  ] as const;

  return [
    ...formats.map(([label, encodingFormat, extension]) => ({
      "@type": "DataDownload",
      "@id": `${SITE_URL}/datasets/${descriptor.slug}/latest.${extension}#download`,
      name: `${descriptor.name} latest ${label} export`,
      encodingFormat,
      contentUrl: `${SITE_URL}/datasets/${descriptor.slug}/latest.${extension}`,
    })),
    {
      "@type": "DataDownload",
      "@id": `${SITE_URL}/sheets/${descriptor.slug}.csv#download`,
      name: `${descriptor.name} Google Sheets CSV export`,
      encodingFormat: "text/csv",
      contentUrl: `${SITE_URL}/sheets/${descriptor.slug}.csv`,
    },
  ];
}

export function buildPublicDatasetMirrorJsonLd(topic: PublicDatasetTopic) {
  const descriptor = PUBLIC_DATASET_JSON_LD_DESCRIPTORS.find((candidate) => candidate.slug === topic);
  if (!descriptor) {
    throw new Error(`Unknown public dataset topic for JSON-LD: ${topic}`);
  }

  const organization = buildPharosOrganizationNode();
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
    "@id": `${SITE_URL}/datasets/${descriptor.slug}/#dataset`,
    name: descriptor.name,
    description: descriptor.description,
    url: `${SITE_URL}/datasets/${descriptor.slug}/latest.json`,
    creator: organization,
    publisher: organization,
    isAccessibleForFree: true,
    license: PHAROS_DATA_LICENSE_URL,
    includedInDataCatalog: buildPharosDataCatalogReference(),
    identifier: [buildPharosUrnJsonLdIdentifier("dataset", descriptor.slug)],
    sameAs: `${SITE_URL}/datasets/${descriptor.slug}/latest.json`,
    ...(date ? { dateModified: date } : {}),
    keywords: descriptor.keywords,
    variableMeasured: rowFields.map((name) => ({
      "@type": "PropertyValue",
      name,
    })),
    distribution: buildDatasetDistributions(descriptor),
    additionalProperty,
  };
}

export function buildCoverageDatasetJsonLd() {
  const organization = buildPharosOrganizationNode();

  return {
    "@context": "https://schema.org",
    "@type": "Dataset",
    "@id": `${SITE_URL}/coverage/#dataset`,
    name: "Pharos Stablecoin Feature Coverage Dataset",
    description:
      "Methodological dataset descriptor for the Pharos coverage matrix, which maps active stablecoins to user-facing feature availability across peg tracking, safety scores, DEX price coverage, reserve views, redemption backstops, yield intelligence, mint and burn flows, blacklist tracking, MiCA and GENIUS compliance assessments, dependency-map visibility, and mint-authority reviews.",
    url: `${SITE_URL}/coverage/`,
    inLanguage: "en",
    creator: organization,
    publisher: organization,
    isAccessibleForFree: true,
    license: PHAROS_DATA_LICENSE_URL,
    includedInDataCatalog: buildPharosDataCatalogReference(),
    identifier: [buildPharosUrnJsonLdIdentifier("dataset", "coverage")],
    sameAs: `${SITE_URL}/coverage/`,
    mainEntityOfPage: { "@id": `${SITE_URL}/coverage/` },
    keywords: [
      "stablecoin coverage",
      "stablecoin feature matrix",
      "stablecoin analytics",
      "depeg tracking",
      "stablecoin risk data",
    ],
    about: [
      { "@type": "Thing", name: "Stablecoins" },
      { "@type": "Thing", name: "Feature coverage" },
      { "@type": "Thing", name: "Stablecoin risk analytics" },
    ],
    measurementTechnique:
      "Feature coverage is derived from Pharos' documented page-level source mappings and summarized without embedding live metric values in the structured data.",
    variableMeasured: COVERAGE_VARIABLES.map((variable) => ({
      "@type": "PropertyValue",
      name: variable.name,
      description: variable.description,
    })),
    isBasedOn: [
      {
        "@type": "CreativeWork",
        name: "Pharos API Documentation",
        url: `${SITE_URL}/about/api/`,
      },
    ],
  };
}
