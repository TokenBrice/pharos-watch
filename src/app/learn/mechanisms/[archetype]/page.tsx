import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  MECHANISM_ARCHETYPE_VALUES,
  type MechanismArchetype,
} from "@shared/types";
import {
  getMechanismArchetypeLabel,
  getMechanismExplainerPath,
} from "@shared/lib/classification";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { buildPageMetadata } from "@/lib/page-metadata";
import { ARCHETYPE_CONTENT } from "../content";
import { ArchetypeExplainerBody } from "../explainer-shell";

const ARCHETYPE_SLUGS = new Set<string>(MECHANISM_ARCHETYPE_VALUES);

const TITLE_BY_ARCHETYPE: Record<MechanismArchetype, string> = {
  "fiat-cash": "Fiat-Backed Stablecoins, Explained",
  tbill: "Tokenized Treasury Stablecoins, Explained",
  cdp: "CDP Stablecoins, Explained",
  "synthetic-delta-neutral": "Delta-Neutral Stablecoins, Explained",
  algorithmic: "Algorithmic Stablecoins, Explained",
};

const DESCRIPTION_BY_ARCHETYPE: Record<MechanismArchetype, string> = {
  "fiat-cash":
    "Fiat-backed stablecoins hold cash, Treasury bills, and short-term debt off-chain and mint 1:1 against deposits. See how the model works and which coins use it.",
  tbill:
    "Tokenized T-bill stablecoins put short-dated US government debt onchain, earning a market rate while tracking $1. Learn the structure, risks, and tracked examples.",
  cdp:
    "CDP stablecoins are minted as debt against onchain collateral, then kept on peg through liquidations and rate fees. Read how the design works and where it breaks.",
  "synthetic-delta-neutral":
    "Delta-neutral stablecoins hold spot crypto and short perp futures so funding-rate yield holds the peg. Read how the structure works and the risks it carries.",
  algorithmic:
    "Algorithmic stablecoins use supply controls or reflexive incentives instead of full reserves. Read why the design keeps failing and what's still being attempted.",
};

export function generateStaticParams() {
  return MECHANISM_ARCHETYPE_VALUES.map((archetype) => ({ archetype }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ archetype: string }>;
}): Promise<Metadata> {
  const { archetype } = await params;
  if (!ARCHETYPE_SLUGS.has(archetype)) {
    return { title: "Not Found", robots: { index: false } };
  }
  const slug = archetype as MechanismArchetype;
  return buildPageMetadata({
    title: TITLE_BY_ARCHETYPE[slug],
    description: DESCRIPTION_BY_ARCHETYPE[slug],
    canonical: getMechanismExplainerPath(slug),
    ogImage: `/og-learn-${slug}.png`,
  });
}

export default async function ArchetypeExplainerPage({
  params,
}: {
  params: Promise<{ archetype: string }>;
}) {
  const { archetype } = await params;
  if (!ARCHETYPE_SLUGS.has(archetype)) {
    notFound();
  }
  const slug = archetype as MechanismArchetype;
  const content = ARCHETYPE_CONTENT[slug];
  const label = getMechanismArchetypeLabel(slug);
  const explainerPath = getMechanismExplainerPath(slug);

  return (
    <FeaturePageShell
      breadcrumbName={label}
      breadcrumbLabel={label}
      path={explainerPath}
      title={content.headline}
      variant="longform"
      containerClassName="mx-auto w-full max-w-[68rem] space-y-8"
      breadcrumbItems={[
        { name: "Home", url: "/" },
        { name: "Learn", url: "/learn/mechanisms/" },
        { name: label, url: explainerPath },
      ]}
      leadParagraphs={[content.subtitle, ...content.lead]}
    >
      <ArchetypeExplainerBody content={content} />
    </FeaturePageShell>
  );
}
