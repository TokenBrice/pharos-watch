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

  return {
    "@context": "https://schema.org",
    "@type": "Dataset",
    "@id": `${detailUrl}#dataset`,
    name: `${coin.name} Stablecoin Analytics`,
    description: `Live analytics for ${coin.name} (${coin.symbol}). ${GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance} stablecoin, ${BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing}, pegged to ${PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency}. Price, market cap, supply trends, chain distribution, peg score, and depeg history.`,
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
      GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance,
      BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing,
      PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency,
      "analytics",
      "peg tracking",
    ],
    identifier: [
      ...(coin.geckoId ? [{ "@type": "PropertyValue", propertyID: "geckoId", value: coin.geckoId }] : []),
      ...(coin.variantOf ? [{ "@type": "PropertyValue", propertyID: "variantOf", value: coin.variantOf }] : []),
      ...(coin.variantKind ? [{ "@type": "PropertyValue", propertyID: "variantKind", value: coin.variantKind }] : []),
      ...contractIdentifiers,
    ],
    variableMeasured: [
      { "@type": "PropertyValue", name: "price", unitText: "USD" },
      { "@type": "PropertyValue", name: "marketCap", unitText: "USD" },
      { "@type": "PropertyValue", name: "circulatingSupply", unitText: coin.symbol },
      { "@type": "PropertyValue", name: "pegScore", minValue: 0, maxValue: 100 },
      { "@type": "PropertyValue", name: "dewsScore", minValue: 0, maxValue: 100 },
      { "@type": "PropertyValue", name: "safetyGrade" },
    ],
    dateModified: options.dateModified ?? new Date().toISOString(),
    spatialCoverage: { "@type": "Place", name: "Global" },
    measurementTechnique:
      "Aggregated supply and price from DefiLlama, CoinGecko, GeckoTerminal, Pyth, Chainlink and on-chain RPCs; normalized in a Cloudflare Worker pipeline.",
    distribution: [
      {
        "@type": "DataDownload",
        name: `${coin.name} detail JSON`,
        encodingFormat: "application/json",
        contentUrl: `${siteUrl}/_site-data/stablecoin/${coin.id}`,
      },
    ],
  };
}
