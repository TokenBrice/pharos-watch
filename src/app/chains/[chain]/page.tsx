import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CHAIN_META, getActiveChainIds } from "@shared/lib/chains";
import { buildPageMetadata } from "@/lib/page-metadata";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { ChainProfileClient } from "./client";

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
      <ChainProfileClient chainId={chain} />
    </FeaturePageShell>
  );
}
