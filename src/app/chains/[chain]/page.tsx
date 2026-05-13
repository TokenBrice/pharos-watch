import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CHAIN_META, getActiveChainIds } from "@shared/lib/chains";
import { buildPageMetadata } from "@/lib/page-metadata";
import { ChainTypeBadge } from "@/components/chain-type-badge";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { ChainProfileClient } from "./client";
import {
  CHAIN_STABLECOIN_FEATURE_LINKS,
  getChainRuntimeContext,
  getRelatedChainTaxonomyLinks,
  getTrackedDeploymentsForChain,
  type ChainFeatureLink,
  type ChainTaxonomyLink,
  type ChainTrackedDeployment,
} from "../static-chain-content";

export function generateStaticParams() {
  return getActiveChainIds().map((chain) => ({ chain }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ chain: string }>;
}): Promise<Metadata> {
  const { chain } = await params;
  const meta = CHAIN_META[chain];
  if (!meta) {
    return {
      title: "Chain Not Found",
      robots: { index: false },
    };
  }
  return buildPageMetadata({
    title: `${meta.name} Stablecoin Analytics`,
    description: `Stablecoin supply, composition, health score, and activity on ${meta.name}. Explore which stablecoins are deployed on ${meta.name} and their market share.`,
    canonical: `/chains/${chain}/`,
  });
}

function deploymentCountLabel(count: number): string {
  return `${count} tracked deployment${count === 1 ? "" : "s"}`;
}

function stablecoinCountLabel(count: number): string {
  return `${count} stablecoin${count === 1 ? "" : "s"}`;
}

function DeploymentLink({ deployment }: { deployment: ChainTrackedDeployment }) {
  return (
    <Link
      href={deployment.href}
      className="pharos-focus-ring inline-flex min-w-0 max-w-full flex-col rounded-xl border border-border/60 bg-background/60 px-3 py-2 text-sm transition-colors hover:bg-accent"
    >
      <span className="truncate font-medium text-foreground">
        {deployment.name} ({deployment.symbol})
      </span>
      <span className="mt-1 truncate text-xs text-muted-foreground">
        {deployment.pegLabel} / {deployment.backingLabel} / {deployment.governanceLabel}
      </span>
      {deployment.contractCount > 1 && (
        <span className="mt-1 text-xs text-muted-foreground">
          {deploymentCountLabel(deployment.contractCount)}
        </span>
      )}
    </Link>
  );
}

function RelatedLinkCard({ link }: { link: ChainTaxonomyLink | ChainFeatureLink }) {
  const detail = "count" in link
    ? `${stablecoinCountLabel(link.count)} in this chain profile`
    : link.description;

  return (
    <Link
      href={link.href}
      className="pharos-focus-ring rounded-xl border border-border/60 bg-background/60 px-3 py-3 text-sm transition-colors hover:bg-accent"
    >
      <span className="block font-medium text-foreground">{link.title}</span>
      <span className="mt-1 block text-xs text-muted-foreground">
        {detail}
      </span>
    </Link>
  );
}

function ChainStaticProfile({
  chainId,
  meta,
}: {
  chainId: string;
  meta: (typeof CHAIN_META)[string];
}) {
  const deployments = getTrackedDeploymentsForChain(chainId);
  const trackedDeploymentCount = deployments.reduce((sum, deployment) => sum + deployment.contractCount, 0);
  const taxonomyLinks = getRelatedChainTaxonomyLinks(deployments);
  const runtimeContext = getChainRuntimeContext({
    type: meta.type,
    evmChainId: meta.evmChainId,
  });

  return (
    <>
      <section className="pharos-subtle-band space-y-4" aria-labelledby={`${chainId}-static-summary-heading`}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-2">
            <p className="pharos-kicker">Chain Summary</p>
            <h2 id={`${chainId}-static-summary-heading`} className="text-lg font-semibold tracking-tight">
              Tracked deployments on {meta.name}
            </h2>
            <p className="max-w-3xl text-sm text-muted-foreground">
              Pharos maps {deploymentCountLabel(trackedDeploymentCount)} on {meta.name} across{" "}
              {stablecoinCountLabel(deployments.length)}. The live profile below adds supply, composition, and Chain Health data from the current API snapshot.
            </p>
          </div>
          <Link
            href="/chains/"
            className="pharos-focus-ring inline-flex min-h-10 items-center justify-center rounded-full border border-border/60 bg-background/70 px-3 text-sm font-medium transition-colors hover:bg-accent sm:min-h-0 sm:py-1.5"
          >
            All chains
          </Link>
        </div>

        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="pharos-kicker">Tracked Deployments</dt>
            <dd className="mt-1 font-mono text-lg font-semibold tabular-nums">
              {trackedDeploymentCount}
            </dd>
          </div>
          <div>
            <dt className="pharos-kicker">Chain Context</dt>
            <dd className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <ChainTypeBadge type={meta.type} />
              <span>{runtimeContext}</span>
            </dd>
          </div>
          <div>
            <dt className="pharos-kicker">Explorer</dt>
            <dd className="mt-1 text-sm">
              {meta.explorerUrl ? (
                <a
                  href={meta.explorerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="pharos-focus-ring rounded-sm underline underline-offset-4 hover:text-foreground"
                >
                  Open {meta.name} explorer
                </a>
              ) : (
                <span className="text-muted-foreground">Explorer not configured</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="pharos-kicker">Source Context</dt>
            <dd className="mt-1 text-sm text-muted-foreground">
              Deployment metadata is checked-in Pharos data; live chain metrics come from /api/chains.
            </dd>
          </div>
        </dl>
      </section>

      <section className="space-y-3" aria-labelledby={`${chainId}-deployment-list-heading`}>
        <div className="space-y-1.5">
          <h2 id={`${chainId}-deployment-list-heading`} className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Stablecoins Deployed On {meta.name}
          </h2>
          <p className="text-sm text-muted-foreground">
            Visible static links to tracked stablecoin detail pages before the live table hydrates.
          </p>
        </div>
        {deployments.length > 0 ? (
          <div className="grid max-h-[34rem] gap-2 overflow-y-auto pr-1 sm:grid-cols-2 lg:grid-cols-3">
            {deployments.map((deployment) => (
              <DeploymentLink key={deployment.id} deployment={deployment} />
            ))}
          </div>
        ) : (
          <p className="rounded-xl border border-dashed border-border/70 bg-muted/10 px-4 py-4 text-sm text-muted-foreground">
            Pharos does not currently map active tracked deployments on {meta.name}. The live chain profile will still show any available chain-level API data.
          </p>
        )}
      </section>

      <section className="grid gap-4 lg:grid-cols-2" aria-label={`${meta.name} related Pharos pages`}>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Related Stablecoin Hubs</h2>
            <p className="text-sm text-muted-foreground">
              Taxonomy pages represented by the stablecoins deployed on this chain.
            </p>
          </div>
          {taxonomyLinks.length > 0 ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {taxonomyLinks.map((link) => (
                <RelatedLinkCard key={link.href} link={link} />
              ))}
            </div>
          ) : (
            <p className="rounded-xl border border-dashed border-border/70 bg-muted/10 px-4 py-4 text-sm text-muted-foreground">
              Related taxonomy hubs appear after Pharos maps tracked deployments on this chain.
            </p>
          )}
        </div>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Stablecoin Research Surfaces</h2>
            <p className="text-sm text-muted-foreground">
              Use these feature pages to compare the same stablecoin set from other angles.
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {CHAIN_STABLECOIN_FEATURE_LINKS.map((link) => (
              <RelatedLinkCard key={link.href} link={link} />
            ))}
          </div>
        </div>
      </section>
    </>
  );
}

export default async function ChainProfilePage({
  params,
}: {
  params: Promise<{ chain: string }>;
}) {
  const { chain } = await params;
  const meta = CHAIN_META[chain];
  if (!meta) notFound();

  return (
    <FeaturePageShell
      breadcrumbName={meta.name}
      breadcrumbLabel={meta.name}
      path={`/chains/${chain}/`}
      breadcrumbItems={[
        { name: "Home", url: "/" },
        { name: "Chains", url: "/chains/" },
        { name: meta.name, url: `/chains/${chain}/` },
      ]}
      title={`${meta.name} Stablecoins`}
    >
      <ChainStaticProfile chainId={chain} meta={meta} />
      <ChainProfileClient chainId={chain} />
    </FeaturePageShell>
  );
}
