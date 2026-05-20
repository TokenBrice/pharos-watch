import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types/core";
import type { MechanismArchetype } from "@shared/types";
import {
  getMechanismArchetypeLabel,
  getMechanismExplainerPath,
} from "@shared/lib/classification";
import { buildPageMetadata } from "@/lib/page-metadata";
import { ArchetypeArticleJsonLd } from "@/lib/mechanism-json-ld";
import { ARCHETYPE_CONTENT } from "../content";
import { ArchetypeExplainerBody } from "../explainer-shell";
import { ExplainerPageShell } from "../explainer-page-shell";

const ARCHETYPE_SLUGS = new Set<string>(MECHANISM_ARCHETYPE_VALUES);

const TITLE_BY_ARCHETYPE: Record<MechanismArchetype, string> = {
  "fiat-cash": "Fiat-Backed Stablecoins, Explained",
  tbill: "Tokenized Treasury Stablecoins, Explained",
  cdp: "CDP Stablecoins, Explained",
  "synthetic-delta-neutral": "Delta-Neutral Stablecoins, Explained",
  algorithmic: "Algorithmic Stablecoins, Explained",
  "rwa-credit-fund": "Tokenized Credit Fund Stablecoins, Explained",
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
  "rwa-credit-fund":
    "Tokenized credit funds wrap private credit and CLO portfolios in an on-chain fund share. Learn the NAV mechanics, redemption gates, and credit risks.",
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
    <ExplainerPageShell
      breadcrumbItems={[
        { name: "Home", url: "/" },
        { name: "Learn", url: "/learn/mechanisms/" },
        { name: label, url: explainerPath },
      ]}
      breadcrumbLabel={label}
      title={content.headline}
      subtitle={content.subtitle}
      leadParagraphs={content.lead}
    >
      <ArchetypeArticleJsonLd archetype={slug} />
      <ArchetypeExplainerBody content={content} />
    </ExplainerPageShell>
  );
}
