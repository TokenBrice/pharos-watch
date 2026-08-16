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
import { MECHANISM_EXPLAINER_TITLES } from "@/lib/mechanism-explainer-registry";
import { LearnPageShell } from "../../_shared/learn-page-shell";
import { ARCHETYPE_CONTENT } from "@/lib/mechanism-explainers";
import { ArchetypeExplainerBody } from "../explainer-shell";

const ARCHETYPE_SLUGS = new Set<string>(MECHANISM_ARCHETYPE_VALUES);

const DESCRIPTION_BY_ARCHETYPE: Record<MechanismArchetype, string> = {
  "fiat-cash":
    "Fiat-backed stablecoins hold cash, Treasury bills, and short-term debt off-chain and mint 1:1 against deposits. See how the model works and which coins use it.",
  tbill:
    "Tokenized T-bill stablecoins put short-dated US government debt onchain, earning a market rate while tracking $1. Learn the structure, risks, and tracked examples.",
  cdp:
    "CDP stablecoins are minted as debt against onchain collateral, then kept on peg through liquidations and rate fees. Read how the design works and where it breaks.",
  "synthetic-delta-neutral":
    "Delta-neutral stablecoins offset economic exposures through perp-short or on-chain borrow-and-stake strategies. Read how each variant works and where its risks differ.",
  algorithmic:
    "Algorithmic stablecoins use supply controls or reflexive incentives instead of full reserves. Read why the design keeps failing and what's still being attempted.",
  "rwa-credit-fund":
    "Tokenized credit funds wrap private credit and CLO portfolios in an on-chain fund share. Learn the NAV mechanics, redemption gates, and credit risks.",
  "commodity-claim":
    "Gold and silver tokens are title claims on specific vaulted bars, not on dollars. Learn how allocation, vault custody, bar-list audits, and physical redemption work.",
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
    title: MECHANISM_EXPLAINER_TITLES[slug],
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
    <LearnPageShell
      breadcrumbItems={[
        { name: "Home", url: "/" },
        { name: "Mechanisms", url: "/learn/mechanisms/" },
        { name: label, url: explainerPath },
      ]}
      title={content.headline}
      subtitle={content.subtitle}
      leadParagraphs={content.lead}
      titleClassName="max-w-[22ch]"
    >
      <ArchetypeArticleJsonLd archetype={slug} />
      <ArchetypeExplainerBody content={content} />
    </LearnPageShell>
  );
}
