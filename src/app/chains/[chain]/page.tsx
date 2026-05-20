import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CHAIN_META, getActiveChainIds } from "@shared/lib/chains";
import { buildPageMetadata } from "@/lib/page-metadata";
import { buildChainProfileJsonLd } from "@/lib/chain-json-ld";
import { safeJsonLd } from "@/lib/json-ld";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { ChainProfileClient } from "./client";
import {
  CHAIN_STABLECOIN_FEATURE_LINKS,
  getRelatedChainTaxonomyLinks,
  getTrackedDeploymentsForChain,
  type ChainFeatureLink,
  type ChainTaxonomyLink,
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

function stablecoinCountLabel(count: number): string {
  return `${count} stablecoin${count === 1 ? "" : "s"}`;
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

function ChainResearchSurfaces({ chainName }: { chainName: string }) {
  return (
    <section className="space-y-3" aria-label={`${chainName} stablecoin research surfaces`}>
      <div className="space-y-1.5">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Stablecoin Research Surfaces</h2>
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

function ChainRelatedHubs({
  chainId,
  taxonomyLinks,
}: {
  chainId: string;
  taxonomyLinks: ChainTaxonomyLink[];
}) {
  return (
    <section className="space-y-3" aria-labelledby={`${chainId}-related-hubs-heading`}>
      <div className="space-y-1.5">
        <h2 id={`${chainId}-related-hubs-heading`} className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
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

export default async function ChainProfilePage({
  params,
}: {
  params: Promise<{ chain: string }>;
}) {
  const { chain } = await params;
  const meta = CHAIN_META[chain];
  if (!meta) notFound();
  const deployments = getTrackedDeploymentsForChain(chain);
  const taxonomyLinks = getRelatedChainTaxonomyLinks(deployments);

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
      <ChainRelatedHubs chainId={chain} taxonomyLinks={taxonomyLinks} />
      <ChainResearchSurfaces chainName={meta.name} />
    </FeaturePageShell>
  );
}
