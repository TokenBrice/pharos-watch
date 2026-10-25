import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getActiveChainIds } from "@shared/lib/chains";
import { CHAIN_META, type ChainMeta } from "@shared/types/chain-identity";
import { formatProseList } from "@shared/lib/format";
import { buildApiOgImageUrl, buildPageMetadata } from "@/lib/page-metadata";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { isChainProfileIndexable } from "@/lib/chain-indexing";
import { buildChainProfileJsonLd } from "@/lib/chain-json-ld";
import { deploymentCountLabel, stablecoinCountLabel } from "@/lib/chain-labels";
import { buildStaticCompareHref } from "@/lib/compare-links";
import { safeJsonLd } from "@/lib/json-ld";
import {
  CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH,
  CHAIN_HEALTH_METHODOLOGY_VERSION,
} from "@shared/lib/methodology-versions/constants";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { ShareButton } from "@/components/share-button";
import { JsonLdScript } from "@/components/json-ld-script";
import { ChainProfileClient } from "./client";
import {
  CHAIN_STABLECOIN_FEATURE_LINKS,
  getRelatedChainTaxonomyLinks,
  getTrackedDeploymentsForChain,
  type ChainFeatureLink,
  type ChainTaxonomyLink,
  type ChainTrackedDeployment,
} from "../static-chain-content";

export function generateStaticParams() {
  return getActiveChainIds().map((chain) => ({ chain }));
}

export async function generateMetadata({ params }: { params: Promise<{ chain: string }> }): Promise<Metadata> {
  const { chain } = await params;
  const meta = CHAIN_META[chain];
  if (!meta) {
    return {
      title: "Chain Not Found",
      robots: { index: false },
    };
  }
  const deployments = getTrackedDeploymentsForChain(chain);
  return buildPageMetadata({
    title: chainPageTitle(meta.name, deployments),
    description: buildChainMetaDescription(meta.name, deployments),
    canonical: `/chains/${chain}/`,
    ogImage: buildApiOgImageUrl(API_PATHS.ogChain(chain)),
    robots: isChainProfileIndexable(chain) ? undefined : { index: false, follow: true },
  });
}

/** Base coins lead; NAV tokens and variants (sUSDe, spUSDT) only fill remaining slots. */
function formatSymbolList(deployments: readonly Pick<ChainTrackedDeployment, "symbol" | "isNavOrVariant">[]): string {
  const ranked = [
    ...deployments.filter((deployment) => !deployment.isNavOrVariant),
    ...deployments.filter((deployment) => deployment.isNavOrVariant),
  ];
  return formatProseList([...new Set(ranked.map((deployment) => deployment.symbol))].slice(0, 3));
}

function chainPageTitle(chainName: string, deployments: readonly ChainTrackedDeployment[] = []): string {
  const topSymbols = formatSymbolList(deployments);
  const options = [
    topSymbols ? `${chainName} Stablecoins: ${topSymbols}, Supply & Risk` : "",
    `${chainName} Stablecoins: Supply, Risk & Top Deployments`,
    `${chainName} Stablecoins: Supply & Risk`,
  ].filter(Boolean);

  return options.find((option) => option.length <= 61) ?? `${chainName} Stablecoins`;
}

const CHAIN_META_DESCRIPTION_MAX = 160;
const CHAIN_META_DESCRIPTION_FOLLOW_UPS = [
  "Compare supply, market share, Chain Health, backing mix, and concentration risk.",
  "Compare supply, market share, Chain Health, and backing mix.",
  "Compare supply and Chain Health.",
] as const;

/** Whole sentences only: the follow-up shrinks to fit rather than being cut mid-sentence. */
function buildChainMetaDescription(chainName: string, deployments: readonly ChainTrackedDeployment[]): string {
  const topSymbols = formatSymbolList(deployments);
  const listsEverySymbol = new Set(deployments.map((deployment) => deployment.symbol)).size <= 3;
  const tracked = `Pharos tracks ${stablecoinCountLabel(deployments.length)} on ${chainName}`;
  const lead = !topSymbols
    ? `Pharos monitors stablecoin supply on ${chainName}.`
    : listsEverySymbol
      ? `${tracked}: ${topSymbols}.`
      : `${tracked}, including ${topSymbols}.`;
  const followUp = CHAIN_META_DESCRIPTION_FOLLOW_UPS.find(
    (sentence) => lead.length + 1 + sentence.length <= CHAIN_META_DESCRIPTION_MAX,
  );
  return followUp ? `${lead} ${followUp}` : lead;
}

function formatDeploymentList(deployments: readonly Pick<ChainTrackedDeployment, "name" | "symbol">[]): string {
  if (deployments.length === 0) return "tracked stablecoins";
  return formatProseList(
    deployments.slice(0, 3).map((deployment) => `${deployment.name} (${deployment.symbol})`),
  );
}

function formatClassificationMix(
  deployments: readonly ChainTrackedDeployment[],
  key: "pegLabel" | "backingLabel" | "governanceLabel",
): string {
  const counts = new Map<string, number>();
  for (const deployment of deployments) {
    counts.set(deployment[key], (counts.get(deployment[key]) ?? 0) + 1);
  }

  return formatProseList(
    [...counts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([label, count]) => `${label} (${count})`),
  );
}

function buildChainRuntimeDescription(meta: ChainMeta): string {
  if (meta.type === "evm" && meta.evmChainId != null) {
    return `an EVM network with chain ID ${meta.evmChainId}`;
  }
  if (meta.type === "tron") {
    return "a Tron account-model network";
  }
  return "a non-EVM or app-specific network";
}

function buildChainEditorialIntro({
  chainName,
  meta,
  deployments,
}: {
  chainName: string;
  meta: ChainMeta;
  deployments: readonly ChainTrackedDeployment[];
}): string[] {
  const highlightedDeployments = deployments.slice(0, 5);
  const trackedDeploymentCount = deployments.reduce((sum, deployment) => sum + deployment.contractCount, 0);

  if (trackedDeploymentCount === 0) {
    const explorerHost = new URL(meta.explorerUrl).hostname;
    return [
      `${chainName} is ${buildChainRuntimeDescription(meta)} in the Pharos chain map; its registered explorer is ${explorerHost}. The checked-in registry currently maps zero active tracked stablecoin contracts to this profile, so there are no named deployments or static peg and backing mixes to summarize.`,
      `This route remains a chain-level monitoring surface because coordinated live data can report market supply even when no explicit contract is mapped. Until a deployment enters the checked-in registry, treat the live Chain Health card as the available evidence rather than assuming that ${chainName} has no stablecoin activity.`,
    ];
  }

  const stablecoinCount = deployments.length;
  const multiContractAssets = deployments.filter((deployment) => deployment.contractCount > 1);
  const contractDistribution = multiContractAssets.length > 0
    ? `${formatDeploymentList(multiContractAssets)} ${multiContractAssets.length === 1 ? "has" : "have"} more than one mapped contract on the network.`
    : stablecoinCount === 1
      ? "That stablecoin has one mapped contract on the network."
      : `Each of the ${stablecoinCountLabel(stablecoinCount)} has one mapped contract on the network.`;

  return [
    `${chainName} has ${deploymentCountLabel(trackedDeploymentCount)} across ${stablecoinCountLabel(stablecoinCount)} in the checked-in Pharos registry. The mapped set includes ${formatDeploymentList(highlightedDeployments)}. ${contractDistribution}`,
    `The ${chainName} cohort's peg mix is ${formatClassificationMix(deployments, "pegLabel")}; its backing mix is ${formatClassificationMix(deployments, "backingLabel")}; and its governance mix is ${formatClassificationMix(deployments, "governanceLabel")}. These counts classify stablecoins rather than contracts, so an asset with multiple deployments is not double-counted.`,
    `Current supply ordering, global market share, and largest-asset concentration for ${chainName} come from the coordinated live snapshots below. Keeping those volatile values in the live profile lets this static overview identify the exact registry cohort without presenting a build-time concentration figure as current.`,
  ];
}

function RelatedLinkCard({ link }: { link: ChainTaxonomyLink | ChainFeatureLink }) {
  const detail = "count" in link ? `${stablecoinCountLabel(link.count)} in this chain profile` : link.description;

  return (
    <Link
      href={link.href}
      className="pharos-focus-ring rounded-xl border border-border/60 bg-background/60 px-3 py-3 text-sm transition-colors hover:bg-accent"
    >
      <span className="block font-medium text-foreground">{link.title}</span>
      <span className="mt-1 block text-xs text-muted-foreground">{detail}</span>
    </Link>
  );
}

function ChainRouteCta({
  chainName,
  deployments,
}: {
  chainName: string;
  deployments: readonly ChainTrackedDeployment[];
}) {
  const compareIds = deployments.slice(0, 4).map((deployment) => deployment.id);

  return (
    <section className="rounded-xl border border-border/60 bg-muted/20 px-4 py-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <p className="pharos-label">Next check</p>
          <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
            Compare the leading {chainName} stablecoins side by side, then subscribe to depeg and safety alerts for the
            assets you actually hold.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {compareIds.length >= 2 ? (
            <Link
              href={buildStaticCompareHref(compareIds)}
              className="pharos-focus-ring inline-flex min-h-11 items-center rounded-full border border-border/60 bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent sm:min-h-9"
            >
              Compare cohort
            </Link>
          ) : null}
          <Link
            href="/pharoswatchbot/#bot"
            className="pharos-focus-ring inline-flex min-h-11 items-center rounded-full bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 sm:min-h-9"
          >
            Set up alerts
          </Link>
        </div>
      </div>
    </section>
  );
}

function ChainDeploymentAnchors({
  chainName,
  deployments,
}: {
  chainName: string;
  deployments: readonly ChainTrackedDeployment[];
}) {
  if (deployments.length === 0) {
    return null;
  }

  return (
    <nav className="space-y-3" aria-labelledby="chain-deployment-anchors-heading">
      <div className="space-y-1.5">
        <h2
          id="chain-deployment-anchors-heading"
          className="pharos-label"
        >
          Tracked Stablecoins On {chainName}
        </h2>
        <p className="text-sm text-muted-foreground">
          Crawlable links to the stablecoin profiles with checked-in deployments on this chain.
        </p>
      </div>
      <ul className="grid gap-x-4 gap-y-1 sm:grid-cols-2 lg:grid-cols-4">
        {deployments.map((deployment) => (
          <li key={deployment.id} className="min-w-0">
            <Link
              href={deployment.href}
              title={`${deployment.pegLabel} / ${deployment.backingLabel} / ${deployment.governanceLabel}`}
              className="pharos-focus-ring flex min-w-0 items-baseline justify-between gap-3 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent"
            >
              <span className="min-w-0 truncate font-medium text-foreground">{deployment.name}</span>
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                {deployment.symbol}
                {deployment.contractCount > 1 ? ` ×${deployment.contractCount}` : ""}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function ChainResearchSurfaces({ chainName }: { chainName: string }) {
  return (
    <section className="space-y-3" aria-label={`${chainName} stablecoin research surfaces`}>
      <div className="space-y-1.5">
        <h2 className="pharos-label">
          Stablecoin Research Surfaces
        </h2>
        <p className="text-sm text-muted-foreground">
          Use these feature pages to compare the same stablecoin set from other angles.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {CHAIN_STABLECOIN_FEATURE_LINKS.map((link) => (
          <RelatedLinkCard key={link.href} link={link} />
        ))}
      </div>
    </section>
  );
}

function ChainRelatedHubs({ chainId, taxonomyLinks }: { chainId: string; taxonomyLinks: ChainTaxonomyLink[] }) {
  return (
    <section className="space-y-3" aria-labelledby={`${chainId}-related-hubs-heading`}>
      <div className="space-y-1.5">
        <h2
          id={`${chainId}-related-hubs-heading`}
          className="pharos-label"
        >
          Related Stablecoin Hubs
        </h2>
        <p className="text-sm text-muted-foreground">
          Taxonomy pages represented by the stablecoins deployed on this chain.
        </p>
      </div>
      {taxonomyLinks.length > 0 ? (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {taxonomyLinks.map((link) => (
            <RelatedLinkCard key={link.href} link={link} />
          ))}
        </div>
      ) : (
        <p className="rounded-xl border border-dashed border-border/70 bg-muted/10 px-4 py-4 text-sm text-muted-foreground">
          Related taxonomy hubs appear after Pharos maps tracked deployments on this chain.
        </p>
      )}
    </section>
  );
}

export default async function ChainProfilePage({ params }: { params: Promise<{ chain: string }> }) {
  const { chain } = await params;
  const meta = CHAIN_META[chain];
  if (!meta) notFound();
  const deployments = getTrackedDeploymentsForChain(chain);
  const taxonomyLinks = getRelatedChainTaxonomyLinks(deployments);

  return (
    <FeaturePageShell
      breadcrumbName={meta.name}
      path={`/chains/${chain}/`}
      breadcrumbItems={[
        { name: "Home", url: "/" },
        { name: "Chains", url: "/chains/" },
        { name: meta.name, url: `/chains/${chain}/` },
      ]}
      title={chainPageTitle(meta.name, deployments)}
      header="instrument"
      methodology={{
        label: "Chain Health methodology",
        version: CHAIN_HEALTH_METHODOLOGY_VERSION,
        changelogPath: CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH,
      }}
      headerActions={<ShareButton ogPath={API_PATHS.ogChain(chain)} />}
      leadParagraphs={[
        `Stablecoin supply, Chain Health and tracked deployments on ${meta.name}.`,
        ...buildChainEditorialIntro({ chainName: meta.name, meta, deployments }),
      ]}
      leadDisclosureLabel={`About the ${meta.name} registry cohort`}
      preface={
        <JsonLdScript json={safeJsonLd(buildChainProfileJsonLd({ chainId: chain, meta, deployments }))} />
      }
    >
      <ChainProfileClient chainId={chain} />
      <ChainDeploymentAnchors chainName={meta.name} deployments={deployments} />
      <ChainRouteCta chainName={meta.name} deployments={deployments} />
      <ChainRelatedHubs chainId={chain} taxonomyLinks={taxonomyLinks} />
      <ChainResearchSurfaces chainName={meta.name} />
    </FeaturePageShell>
  );
}
