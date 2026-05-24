import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";

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
    name: "dependencyMapCoverage",
    description: "Resolved dependency-map role for each active stablecoin, including upstream hubs, dependents, resolved no-dependency rows, and unmapped gaps.",
  },
] as const;

export function buildCoverageDatasetJsonLd(options: { siteUrl?: string } = {}) {
  const siteUrl = options.siteUrl ?? SITE_URL;
  const organization = { "@id": `${siteUrl}#organization` };

  return {
    "@context": "https://schema.org",
    "@type": "Dataset",
    "@id": `${siteUrl}/coverage/#dataset`,
    name: "Pharos Stablecoin Feature Coverage Dataset",
    description:
      "Methodological dataset descriptor for the Pharos coverage matrix, which maps active stablecoins to user-facing feature availability across peg tracking, safety scores, DEX price coverage, reserve views, redemption backstops, yield intelligence, mint and burn flows, blacklist tracking, and dependency-map visibility.",
    url: `${siteUrl}/coverage/`,
    inLanguage: "en",
    creator: organization,
    publisher: organization,
    isAccessibleForFree: true,
    includedInDataCatalog: { "@id": `${siteUrl}/about/api/#data-catalog` },
    mainEntityOfPage: { "@id": `${siteUrl}/coverage/` },
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
        url: `${siteUrl}/about/api/`,
      },
    ],
  };
}
