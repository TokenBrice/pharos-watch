import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { API_REFERENCE_URL } from "@shared/lib/public-api-contract";
import type { PublicDatasetTopic } from "@shared/lib/api-endpoints/datasets";
import { PUBLIC_DATASET_CURRENT_DATE, PUBLIC_DATASET_CURRENT_EXPORTS } from "@/lib/datasets/public-dataset-current";
import { buildPharosOrganizationNode } from "@/lib/json-ld";
import { buildPharosUrnJsonLdIdentifier } from "@/lib/pharos-urn-json-ld";

type PublicDatasetExport = {
  _meta: {
    endpoint: string;
    asOfISO?: string;
    methodologyLabel?: string;
    rowCount?: number;
    /** Exact shard capture identity, present when provenance is available. */
    sourceGeneration?: string;
    /** Observation semantics for the export's clock. */
    freshnessContract?: string;
  };
  rows: Record<string, unknown>[];
};

export interface PublicDatasetDescriptor {
  slug: PublicDatasetTopic;
  name: string;
  description: string;
  keywords: string[];
  export: PublicDatasetExport;
  /** Row field holding each record's start time, for exports that span a history window. */
  temporalStartField?: string;
}

/**
 * The depeg card's schema sentence names only fields the linked export
 * actually carries: a sheet capture must not promise an audit-verdict column
 * it lacks.
 */
export function buildDepegHistoryDescription(rowFields: readonly string[]): string {
  const auditVerdict = rowFields.includes("auditVerdict") ? ", plus the ledger's audit verdict" : "";
  return `Public history of tracked depeg events with stablecoin IDs, direction, peak deviation, timing, duration, prices, peg reference, and source${auditVerdict}.`;
}

export const PUBLIC_DATASET_JSON_LD_DESCRIPTORS: readonly PublicDatasetDescriptor[] = [
  {
    slug: "top-stablecoins",
    name: "Pharos Top Stablecoins Dataset",
    description:
      "Public snapshot of the stablecoin list, including rows outside the tracked catalog, with peg type, peg mechanism, price, circulating USD supply, chain count, and chain coverage. The supplyUnavailableReason column explains unavailable supply without shifting existing columns, and supplyProvenance is the final CSV column.",
    keywords: ["stablecoin market cap", "stablecoin supply", "stablecoin chains", "stablecoin dataset"],
    export: PUBLIC_DATASET_CURRENT_EXPORTS["top-stablecoins"] as PublicDatasetExport,
  },
  {
    slug: "scores-latest",
    name: "Pharos Latest Stablecoin Scores Dataset",
    description:
      "Public snapshot of latest Safety Score, DEWS, LiquidityScore, grade, and coverage-class values for tracked stablecoins.",
    keywords: ["stablecoin safety scores", "DEWS", "LiquidityScore", "stablecoin risk data"],
    export: PUBLIC_DATASET_CURRENT_EXPORTS["scores-latest"] as PublicDatasetExport,
  },
  {
    slug: "depeg-history",
    name: "Pharos Depeg History Dataset",
    description: buildDepegHistoryDescription(
      Object.keys(PUBLIC_DATASET_CURRENT_EXPORTS["depeg-history"].rows[0] ?? {}),
    ),
    keywords: ["stablecoin depeg history", "depeg events", "peg monitoring", "stablecoin incident data"],
    export: PUBLIC_DATASET_CURRENT_EXPORTS["depeg-history"] as PublicDatasetExport,
    temporalStartField: "startedAtISO",
  },
  {
    slug: "peg-mechanism-distribution",
    name: "Pharos Peg Mechanism Distribution Dataset",
    description:
      "Public market-structure export summarizing stablecoin counts by mechanism archetype, peg reference, and jurisdiction.",
    keywords: ["stablecoin mechanisms", "peg mechanism distribution", "stablecoin market structure"],
    export: PUBLIC_DATASET_CURRENT_EXPORTS["peg-mechanism-distribution"] as PublicDatasetExport,
  },
] as const;

/**
 * Plain-text citation for a public dataset card. The dated download uses the
 * generated edition date; `_meta.asOfISO` may name an earlier observation
 * clock (notably the depeg ledger capture) and must not be used for the path.
 */
export function buildPublicDatasetCitation(descriptor: PublicDatasetDescriptor): string {
  const meta = descriptor.export._meta;
  const editionDate = PUBLIC_DATASET_CURRENT_DATE;
  const asOf = meta.asOfISO ?? PUBLIC_DATASET_AS_OF_UNAVAILABLE;
  const methodology = meta.methodologyLabel ?? PUBLIC_DATASET_METHODOLOGY_UNAVAILABLE;
  const provenance = meta.sourceGeneration
    ? [`source generation ${meta.sourceGeneration}`, meta.freshnessContract]
      .filter((value): value is string => Boolean(value))
      .join("; ")
    : "";
  return `Pharos, "${descriptor.name}," snapshot edition ${editionDate}, as of ${asOf}; methodology ${methodology}${provenance ? `; ${provenance}` : ""}. ${API_REFERENCE_URL}#dataset-${descriptor.slug}. Data: ${SITE_URL}/datasets/${descriptor.slug}/${editionDate}.json. MIT.`;
}

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

export const PHAROS_DATA_LICENSE_URL = "https://github.com/TokenBrice/pharos-watch/blob/main/LICENSE";
export const PUBLIC_DATASET_AS_OF_UNAVAILABLE = "Snapshot time unavailable";
export const PUBLIC_DATASET_METHODOLOGY_UNAVAILABLE = "Methodology version unavailable";
export const PHAROS_PUBLIC_DATA_CATALOG_NAME = "Pharos Public API Data Catalog";

/** Canonical `@id` of the public data catalog every dataset node points at. */
export const PHAROS_PUBLIC_DATA_CATALOG_ID = `${SITE_URL}/api/#data-catalog`;

export function buildPharosDataCatalogReference() {
  return {
    "@type": "DataCatalog",
    "@id": PHAROS_PUBLIC_DATA_CATALOG_ID,
    name: PHAROS_PUBLIC_DATA_CATALOG_NAME,
    url: API_REFERENCE_URL,
  };
}

function datasetDate(dataset: PublicDatasetExport): string | undefined {
  return dataset._meta.asOfISO?.slice(0, 10);
}

/**
 * ISO 8601 coverage read from the export itself: the snapshot date, or for a
 * history window the earliest row start through the snapshot date.
 */
function datasetTemporalCoverage(descriptor: PublicDatasetDescriptor): string | undefined {
  const date = datasetDate(descriptor.export);
  if (!date || !descriptor.temporalStartField) return date;
  const field = descriptor.temporalStartField;
  const earliest = descriptor.export.rows
    .map((row) => row[field])
    .filter((value): value is string => typeof value === "string" && value.length >= 10)
    .sort()[0];
  return earliest ? `${earliest.slice(0, 10)}/${date}` : date;
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
  const temporalCoverage = datasetTemporalCoverage(descriptor);
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
    url: `${API_REFERENCE_URL}#dataset-${descriptor.slug}`,
    creator: organization,
    publisher: organization,
    isAccessibleForFree: true,
    license: PHAROS_DATA_LICENSE_URL,
    includedInDataCatalog: buildPharosDataCatalogReference(),
    identifier: [buildPharosUrnJsonLdIdentifier("dataset", descriptor.slug)],
    sameAs: `${API_REFERENCE_URL}#dataset-${descriptor.slug}`,
    ...(date ? { dateModified: date } : {}),
    ...(temporalCoverage ? { temporalCoverage } : {}),
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
        url: API_REFERENCE_URL,
      },
    ],
  };
}
