import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CHAIN_META, getActiveChainIds } from "@shared/lib/chains";
import { formatProseList } from "@shared/lib/format";
import { buildApiOgImageUrl, buildPageMetadata, trimTextAtWordBoundary } from "@/lib/page-metadata";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { buildChainProfileJsonLd } from "@/lib/chain-json-ld";
import { deploymentCountLabel, stablecoinCountLabel } from "@/lib/chain-labels";
import { buildLiveCompareUrl } from "@/lib/compare-links";
import { safeJsonLd } from "@/lib/json-ld";
import { FeaturePageShell } from "@/components/feature-page-shell";
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
  });
}

function formatSymbolList(deployments: readonly Pick<ChainTrackedDeployment, "symbol">[]): string {
  return formatProseList([...new Set(deployments.map((deployment) => deployment.symbol))].slice(0, 3));
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

function buildChainMetaDescription(chainName: string, deployments: readonly ChainTrackedDeployment[]): string {
  const trackedDeploymentCount = deployments.reduce((sum, deployment) => sum + deployment.contractCount, 0);
  const topSymbols = formatSymbolList(deployments);
  const lead = topSymbols
    ? `Track ${deploymentCountLabel(trackedDeploymentCount)} on ${chainName}, including ${topSymbols}.`
    : `Track stablecoin deployment coverage on ${chainName}.`;

  return trimTextAtWordBoundary(
    `${lead} Compare supply, market share, Chain Health, backing mix, concentration risk, and Pharos-tracked assets.`,
    160,
  );
}

function formatDeploymentList(deployments: readonly Pick<ChainTrackedDeployment, "name" | "symbol">[]): string {
  if (deployments.length === 0) return "tracked stablecoins";
  return formatProseList(
    deployments.slice(0, 3).map((deployment) => `${deployment.name} (${deployment.symbol})`),
  );
}

function buildChainEditorialIntro({
  chainName,
  deployments,
}: {
  chainName: string;
  deployments: readonly ChainTrackedDeployment[];
}): string {
  const topDeployments = deployments.slice(0, 3);
  const trackedDeploymentCount = deployments.reduce((sum, deployment) => sum + deployment.contractCount, 0);

  if (trackedDeploymentCount === 0) {
    return `${chainName} is part of the Pharos chain map, but no active tracked stablecoin contract has been mapped to this profile yet. Use the live Chain Health card to verify whether market supply appears before relying on this route for deployment-level risk review.`;
  }

  return `${chainName} has ${deploymentCountLabel(trackedDeploymentCount)} in the checked-in Pharos registry, led by ${formatDeploymentList(topDeployments)}. Use this page to compare live stablecoin supply, global market share, concentration, peg health, and backing mix before treating ${chainName} liquidity as interchangeable with the same assets on other chains.`;
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
          <p className="pharos-kicker">Next Check</p>
          <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
            Compare the leading {chainName} stablecoins side by side, then subscribe to depeg and safety alerts for the
            assets you actually hold.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {compareIds.length >= 2 ? (
            <Link
              href={buildLiveCompareUrl(compareIds)}
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
          className="pharos-kicker"
        >
          Tracked Stablecoins On {chainName}
        </h2>
        <p className="text-sm text-muted-foreground">
          Crawlable links to the stablecoin profiles with checked-in deployments on this chain.
        </p>
      </div>
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {deployments.map((deployment) => (
          <li key={deployment.id} className="min-w-0">
            <Link
              href={deployment.href}
              className="pharos-focus-ring block rounded-xl border border-border/60 bg-background/60 px-3 py-3 text-sm transition-colors hover:bg-accent"
            >
              <span className="flex min-w-0 items-baseline justify-between gap-3">
                <span className="min-w-0 truncate font-medium text-foreground">{deployment.name}</span>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">{deployment.symbol}</span>
              </span>
              <span className="mt-1 block text-xs text-muted-foreground">
                {deploymentCountLabel(deployment.contractCount)} on {chainName}
              </span>
              <span className="mt-2 block truncate text-[11px] text-muted-foreground/80">
                {deployment.pegLabel} / {deployment.backingLabel} / {deployment.governanceLabel}
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
        <h2 className="pharos-kicker">
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
          className="pharos-kicker"
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
      leadParagraphs={[buildChainEditorialIntro({ chainName: meta.name, deployments })]}
      preface={
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: safeJsonLd(buildChainProfileJsonLd({ chainId: chain, meta, deployments })),
          }}
        />
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
