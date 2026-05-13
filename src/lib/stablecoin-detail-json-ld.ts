import { BACKING_LABELS, GOVERNANCE_LABELS, PEG_LABELS_SHORT } from "@shared/lib/classification";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import type { StablecoinMeta } from "@shared/types";
import { buildStablecoinUrl } from "@/lib/urls";

export const CONTRACT_IDENTIFIER_JSON_LD_LIMIT = 8;

export function buildStablecoinDatasetJsonLd(
  coin: StablecoinMeta,
  options: { siteUrl?: string; dateModified?: string } = {},
) {
  const siteUrl = options.siteUrl ?? SITE_URL;
  const detailUrl = `${siteUrl}${buildStablecoinUrl(coin.id)}`;
  const pegLabel = PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency;
  const governanceLabel = GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance;
  const backingLabel = BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing;
  const datasetSameAs = [
    coin.geckoId ? `https://www.coingecko.com/en/coins/${coin.geckoId}` : null,
    coin.llamaId ? `https://defillama.com/stablecoin/${coin.llamaId}` : null,
    ...(coin.links?.map((link) => link.url) ?? []),
  ].filter((url): url is string => Boolean(url));
  const contractIdentifiers = (coin.contracts ?? [])
    .slice(0, CONTRACT_IDENTIFIER_JSON_LD_LIMIT)
    .map((contract) => ({
      "@type": "PropertyValue",
      propertyID: `contract:${contract.chain}`,
      value: contract.address,
    }));

  const statusCopy =
    coin.status === "frozen"
      ? {
          name: `${coin.name} Frozen Stablecoin Archive`,
          description: `Historical archive for ${coin.name} (${coin.symbol}), a now-defunct stablecoin. ${governanceLabel} stablecoin, ${backingLabel}, pegged to ${pegLabel}. Static profile, historical context, chain deployments, and archived risk metadata.`,
          keywords: ["stablecoin archive", "frozen stablecoin", "historical stablecoin data"],
          variableMeasured: [
            { "@type": "PropertyValue", name: "archivedStatus" },
            { "@type": "PropertyValue", name: "historicalPegContext" },
            { "@type": "PropertyValue", name: "historicalChainDeployments" },
            { "@type": "PropertyValue", name: "archivedRiskProfile" },
          ],
          measurementTechnique:
            "Checked-in stablecoin metadata, archived Pharos observations, and historical source references preserved for now-defunct assets.",
        }
      : {
          name: `${coin.name} Stablecoin Analytics`,
          description: `Live analytics for ${coin.name} (${coin.symbol}). ${governanceLabel} stablecoin, ${backingLabel}, pegged to ${pegLabel}. Price, market cap, supply trends, chain distribution, peg score, and depeg history.`,
          keywords: ["analytics", "peg tracking"],
          variableMeasured: [
            { "@type": "PropertyValue", name: "price", unitText: "USD" },
            { "@type": "PropertyValue", name: "marketCap", unitText: "USD" },
            { "@type": "PropertyValue", name: "circulatingSupply", unitText: coin.symbol },
            { "@type": "PropertyValue", name: "pegScore", minValue: 0, maxValue: 100 },
            { "@type": "PropertyValue", name: "dewsScore", minValue: 0, maxValue: 100 },
            { "@type": "PropertyValue", name: "safetyGrade" },
          ],
          measurementTechnique:
            "Aggregated supply and price from DefiLlama, CoinGecko, GeckoTerminal, Pyth, Chainlink and on-chain RPCs; normalized in a Cloudflare Worker pipeline.",
        };

  return {
    "@context": "https://schema.org",
    "@type": "Dataset",
    "@id": `${detailUrl}#dataset`,
    name: statusCopy.name,
    description: statusCopy.description,
    url: detailUrl,
    ...(datasetSameAs.length > 0 ? { sameAs: datasetSameAs } : {}),
    creator: { "@id": `${siteUrl}#organization` },
    ...(coin.proofOfReserves?.url ? { citation: [coin.proofOfReserves.url] } : {}),
    publisher: { "@id": `${siteUrl}#organization` },
    isAccessibleForFree: true,
    license: "https://creativecommons.org/licenses/by/4.0/",
    keywords: [
      coin.symbol,
      coin.name,
      "stablecoin",
      ...(coin.variantKind ? [coin.variantKind, "stablecoin variant"] : []),
      governanceLabel,
      backingLabel,
      pegLabel,
      ...statusCopy.keywords,
    ],
    identifier: [
      ...(coin.geckoId ? [{ "@type": "PropertyValue", propertyID: "geckoId", value: coin.geckoId }] : []),
      ...(coin.variantOf ? [{ "@type": "PropertyValue", propertyID: "variantOf", value: coin.variantOf }] : []),
      ...(coin.variantKind ? [{ "@type": "PropertyValue", propertyID: "variantKind", value: coin.variantKind }] : []),
      ...contractIdentifiers,
    ],
    variableMeasured: statusCopy.variableMeasured,
    ...(options.dateModified ? { dateModified: options.dateModified } : {}),
    spatialCoverage: { "@type": "Place", name: "Global" },
    measurementTechnique: statusCopy.measurementTechnique,
  };
}

export function buildPreLaunchStablecoinJsonLd(
  coin: StablecoinMeta,
  options: { siteUrl?: string } = {},
) {
  const siteUrl = options.siteUrl ?? SITE_URL;
  const detailUrl = `${siteUrl}${buildStablecoinUrl(coin.id)}`;
  const pegLabel = PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency;
  const governanceLabel = GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance;
  const backingLabel = BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing;
  const description = `Pre-launch profile for ${coin.name} (${coin.symbol}). Planned ${pegLabel} stablecoin with ${governanceLabel} governance and ${backingLabel} backing. Live market, peg, liquidity, and safety data begin only after launch.`;
  const sameAs = [
    coin.geckoId ? `https://www.coingecko.com/en/coins/${coin.geckoId}` : null,
    coin.llamaId ? `https://defillama.com/stablecoin/${coin.llamaId}` : null,
    ...(coin.links?.map((link) => link.url) ?? []),
  ].filter((url): url is string => Boolean(url));

  return [
    {
      "@context": "https://schema.org",
      "@type": "WebPage",
      "@id": `${detailUrl}#webpage`,
      name: `${coin.name} (${coin.symbol}) Pre-Launch Stablecoin Tracker`,
      description,
      url: detailUrl,
      isPartOf: { "@id": `${siteUrl}#website` },
      about: { "@id": `${detailUrl}#stablecoin` },
    },
    {
      "@context": "https://schema.org",
      "@type": "Thing",
      "@id": `${detailUrl}#stablecoin`,
      name: coin.name,
      alternateName: coin.symbol,
      description,
      ...(sameAs.length > 0 ? { sameAs } : {}),
    },
  ];
}
