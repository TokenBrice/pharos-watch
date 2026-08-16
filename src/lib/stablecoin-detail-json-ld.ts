import { BACKING_LABELS, GOVERNANCE_LABELS, PEG_LABELS_SHORT } from "@shared/lib/classification";
import { API_ORIGIN, SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import type { StablecoinMeta } from "@shared/types";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { buildPharosUrnJsonLdIdentifier } from "@/lib/pharos-urn-json-ld";
import { buildPharosOrganizationNode } from "@/lib/json-ld";

export const CONTRACT_IDENTIFIER_JSON_LD_LIMIT = 8;
const STABLECOIN_IDENTIFIER_FIELD_KEYS = [
  "llamaId",
  "geckoId",
  "cmcSlug",
  "pythFeedId",
  "variantOf",
  "variantKind",
] as const;

type StablecoinIdentifierFieldKey = (typeof STABLECOIN_IDENTIFIER_FIELD_KEYS)[number];

function compactStrings(values: readonly (string | null | undefined)[]): string[] {
  return values.filter((value): value is string => Boolean(value));
}

function buildStablecoinSameAs(coin: StablecoinMeta): string[] {
  return compactStrings([
    coin.geckoId ? `https://www.coingecko.com/en/coins/${coin.geckoId}` : null,
    coin.llamaId ? `https://defillama.com/stablecoin/${coin.llamaId}` : null,
    coin.cmcSlug ? `https://coinmarketcap.com/currencies/${coin.cmcSlug}/` : null,
    ...(coin.links?.map((link) => link.url) ?? []),
  ]);
}

function buildStablecoinIdentifierProperties(coin: StablecoinMeta): Array<Record<string, unknown>> {
  const values: Record<StablecoinIdentifierFieldKey, string | undefined> = {
    llamaId: coin.llamaId,
    geckoId: coin.geckoId,
    cmcSlug: coin.cmcSlug,
    pythFeedId: coin.pythFeedId,
    variantOf: coin.variantOf,
    variantKind: coin.variantKind,
  };

  return STABLECOIN_IDENTIFIER_FIELD_KEYS.flatMap((propertyID) => {
    const value = values[propertyID];
    return value ? [{ "@type": "PropertyValue", propertyID, value }] : [];
  });
}

function buildStablecoinThingJsonLd({
  coin,
  detailUrl,
  description,
  sameAs,
  image,
}: {
  coin: StablecoinMeta;
  detailUrl: string;
  description: string;
  sameAs: readonly string[];
  image?: string;
}): Record<string, unknown> {
  return {
    "@type": "Thing",
    "@id": `${detailUrl}#stablecoin`,
    name: coin.name,
    alternateName: coin.symbol,
    description,
    url: detailUrl,
    ...(image ? { image } : {}),
    ...(sameAs.length > 0 ? { sameAs } : {}),
    identifier: [buildPharosUrnJsonLdIdentifier("coin", coin.id), ...buildStablecoinIdentifierProperties(coin)],
  };
}

function absoluteSiteUrl(pathOrUrl: string | undefined): string | undefined {
  if (!pathOrUrl) return undefined;
  try {
    return new URL(pathOrUrl, SITE_URL).toString();
  } catch {
    return undefined;
  }
}

export function buildStablecoinDatasetJsonLd(
  coin: StablecoinMeta,
  options: { dateModified?: string; logoPath?: string } = {},
) {
  const detailUrl = `${SITE_URL}${buildStablecoinUrl(coin.id)}`;
  const image = absoluteSiteUrl(options.logoPath);
  const pegLabel = PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency;
  const governanceLabel = GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance;
  const backingLabel = BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing;
  const datasetSameAs = buildStablecoinSameAs(coin);
  const datasetIdentityUrls = datasetSameAs.length > 0 ? datasetSameAs : [detailUrl];
  const organization = buildPharosOrganizationNode();
  const contractIdentifiers = (coin.contracts ?? []).slice(0, CONTRACT_IDENTIFIER_JSON_LD_LIMIT).map((contract) => ({
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
      : coin.status === "quarantined" || coin.status === "delisted"
        ? {
            name: `${coin.name} Inactive Listing Record`,
            description: `Static catalog record for ${coin.name} (${coin.symbol}). This asset is outside Pharos's active monitoring universe. ${coin.listingStatusReview?.reason ?? "The lifecycle record is retained for historical reference."}`,
            keywords: ["stablecoin catalog", "inactive listing", "historical reference"],
            variableMeasured: [
              { "@type": "PropertyValue", name: "listingStatus", value: coin.status },
              { "@type": "PropertyValue", name: "staticProfile" },
            ],
            measurementTechnique: "Checked-in catalog metadata and reviewed listing-policy decisions.",
          }
      : {
          name: `${coin.name} Stablecoin Analytics`,
          description: `Live analytics for ${coin.name} (${coin.symbol}). ${governanceLabel} stablecoin, ${backingLabel}, pegged to ${pegLabel}. Price, market cap, supply trends, chain distribution, peg score, redemption backstop coverage, and depeg history.`,
          keywords: ["analytics", "peg tracking"],
          variableMeasured: [
            { "@type": "PropertyValue", name: "price", unitText: "USD" },
            { "@type": "PropertyValue", name: "marketCap", unitText: "USD" },
            { "@type": "PropertyValue", name: "circulatingSupply", unitText: coin.symbol },
            { "@type": "PropertyValue", name: "pegScore", minValue: 0, maxValue: 100 },
            { "@type": "PropertyValue", name: "dewsScore", minValue: 0, maxValue: 100 },
            { "@type": "PropertyValue", name: "safetyGrade" },
            { "@type": "PropertyValue", name: "redemptionBackstopCoverage" },
          ],
          measurementTechnique:
            "Aggregated supply and price from DefiLlama, CoinGecko, GeckoTerminal, Pyth, Chainlink and on-chain RPCs; normalized in a Cloudflare Worker pipeline.",
        };
  const stablecoinThing = buildStablecoinThingJsonLd({
    coin,
    detailUrl,
    description: statusCopy.description,
    sameAs: datasetSameAs,
    image,
  });

  return {
    "@context": "https://schema.org",
    "@type": "Dataset",
    "@id": `${detailUrl}#dataset`,
    name: statusCopy.name,
    description: statusCopy.description,
    url: detailUrl,
    inLanguage: "en",
    mainEntityOfPage: detailUrl,
    about: stablecoinThing,
    ...(image ? { image } : {}),
    sameAs: datasetIdentityUrls,
    creator: organization,
    ...(coin.proofOfReserves?.url ? { citation: [coin.proofOfReserves.url] } : {}),
    publisher: organization,
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
      buildPharosUrnJsonLdIdentifier("coin", coin.id),
      ...buildStablecoinIdentifierProperties(coin),
      ...contractIdentifiers,
    ],
    variableMeasured: statusCopy.variableMeasured,
    distribution: [
      {
        "@type": "DataDownload",
        name: `${coin.name} (${coin.symbol}) API response`,
        encodingFormat: "application/json",
        contentUrl: `${API_ORIGIN}${API_PATHS.stablecoinDetail(coin.id)}`,
      },
      {
        "@type": "DataDownload",
        name: `${coin.name} (${coin.symbol}) markdown profile`,
        encodingFormat: "text/markdown",
        contentUrl: `${detailUrl}index.md`,
      },
    ],
    ...(options.dateModified ? { dateModified: options.dateModified } : {}),
    spatialCoverage: { "@type": "Place", name: "Global" },
    measurementTechnique: statusCopy.measurementTechnique,
  };
}

export function buildPreLaunchStablecoinJsonLd(coin: StablecoinMeta) {
  const detailUrl = `${SITE_URL}${buildStablecoinUrl(coin.id)}`;
  const pegLabel = PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency;
  const governanceLabel = GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance;
  const backingLabel = BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing;
  const description = `Pre-launch profile for ${coin.name} (${coin.symbol}). Planned ${pegLabel} stablecoin with ${governanceLabel} governance and ${backingLabel} backing. Live market, peg, liquidity, and safety data begin only after launch.`;
  const sameAs = buildStablecoinSameAs(coin);

  return [
    {
      "@context": "https://schema.org",
      "@type": "WebPage",
      "@id": `${detailUrl}#webpage`,
      name: `${coin.name} (${coin.symbol}) Pre-launch Stablecoin Tracker`,
      description,
      url: detailUrl,
      isPartOf: { "@id": `${SITE_URL}#website` },
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
