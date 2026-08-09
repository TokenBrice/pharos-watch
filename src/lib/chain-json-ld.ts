import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { buildCollectionItemListJsonLd } from "@/lib/json-ld";

export interface ChainJsonLdDirectoryEntry {
  id: string;
  name: string;
  href: string;
  type: string;
  deploymentCount: number;
}

export interface ChainJsonLdDeployment {
  id: string;
  name: string;
  symbol: string;
  href: string;
  pegLabel: string;
  backingLabel: string;
  governanceLabel: string;
  contractCount: number;
}

export interface ChainJsonLdMeta {
  name: string;
  type: string;
  evmChainId?: number | null;
  explorerUrl?: string;
}

function absoluteUrl(href: string): string {
  return `${SITE_URL}${href}`;
}

export function buildChainDirectoryJsonLd(
  entries: readonly ChainJsonLdDirectoryEntry[],
) {
  return buildCollectionItemListJsonLd({
    url: `${SITE_URL}/chains/`,
    name: "Stablecoin Chain Profiles",
    description: `${entries.length} crawlable chain profiles covering stablecoin deployments, supply, composition, and Chain Health data.`,
    inLanguage: "en",
    itemListName: "Crawlable stablecoin chain profile routes",
    entries: entries.map((entry) => {
      const url = absoluteUrl(entry.href);

      return {
        item: {
          "@type": "WebPage",
          "@id": `${url}#webpage`,
          name: `${entry.name} Stablecoin Analytics`,
          url,
          description: `${entry.deploymentCount} tracked stablecoin deployment${entry.deploymentCount === 1 ? "" : "s"} mapped on ${entry.name}.`,
          about: {
            "@type": "Thing",
            name: entry.name,
            additionalType: entry.type,
          },
        },
      };
    }),
  });
}

export function buildChainProfileJsonLd({
  chainId,
  meta,
  deployments,
}: {
  chainId: string;
  meta: ChainJsonLdMeta;
  deployments: readonly ChainJsonLdDeployment[];
}) {
  const pageUrl = `${SITE_URL}/chains/${chainId}/`;
  const trackedDeploymentCount = deployments.reduce((sum, deployment) => sum + deployment.contractCount, 0);

  return buildCollectionItemListJsonLd({
    url: pageUrl,
    name: `${meta.name} Stablecoin Analytics`,
    description: `Stablecoin supply, composition, Chain Health, and ${trackedDeploymentCount} tracked deployment${trackedDeploymentCount === 1 ? "" : "s"} on ${meta.name}.`,
    inLanguage: "en",
    itemListId: `${pageUrl}#deployments`,
    itemListName: `${meta.name} tracked stablecoin deployments`,
    about: {
      "@type": "Thing",
      "@id": `${pageUrl}#chain`,
      name: meta.name,
      additionalType: meta.type,
      ...(meta.evmChainId != null
        ? { identifier: { "@type": "PropertyValue", propertyID: "evmChainId", value: meta.evmChainId } }
        : {}),
      ...(meta.explorerUrl ? { sameAs: [meta.explorerUrl] } : {}),
    },
    entries: deployments.map((deployment) => {
      const url = absoluteUrl(deployment.href);

      return {
        item: {
          "@type": "Thing",
          "@id": `${pageUrl}#deployment-${deployment.id}`,
          name: `${deployment.name} (${deployment.symbol})`,
          url,
          description: `${deployment.name} is a ${deployment.pegLabel}, ${deployment.backingLabel}, ${deployment.governanceLabel} stablecoin with ${deployment.contractCount} tracked deployment${deployment.contractCount === 1 ? "" : "s"} on ${meta.name}.`,
          mainEntityOfPage: url,
        },
      };
    }),
  });
}
