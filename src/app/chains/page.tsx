import type { Metadata } from "next";
import Link from "next/link";
import {
  CHAIN_HEALTH_METHODOLOGY_VERSION,
  CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH,
} from "@shared/lib/methodology-versions/constants";
import { buildPageMetadata } from "@/lib/page-metadata";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { safeJsonLd } from "@/lib/json-ld";
import { buildChainDirectoryJsonLd } from "@/lib/chain-json-ld";
import type { FaqItem } from "@/lib/faq";
import { FaqSection } from "@/components/faq-section";
import { JsonLdScript } from "@/components/json-ld-script";
import { ChainTypeBadge } from "@/components/chain-type-badge";
import { ChainsLeaderboardClient } from "./client";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { getChainDirectoryEntries, getChainRuntimeContext, type ChainDirectoryEntry } from "./static-chain-content";

export const metadata: Metadata = buildPageMetadata({
  title: "Stablecoin Distribution by Chain",
  description:
    "Ranking blockchain networks by stablecoin supply, health score, and composition. Explore per-chain stablecoin analytics on Pharos.",
  canonical: "/chains/",
  ogImage: `${SITE_URL}/og-chains.png`,
});

const CHAINS_FAQ_ITEMS = [
  {
    question: "What is the Chain Health Score?",
    answer:
      "The Chain Health Score is a composite rating (0–100) that evaluates a blockchain's stablecoin ecosystem across five dimensions: stablecoin quality (supply-weighted Safety Scores), chain environment (resilience tier), concentration risk (supply distribution across coins), peg stability (supply-weighted proximity to target prices), and backing diversity (RWA-backed vs crypto-backed supply mix).",
  },
  {
    question: "Which chains have the most stablecoin supply?",
    answer:
      "The leaderboard ranks chains by the latest stablecoin supply snapshot, but supply alone doesn't tell the full story. Concentration risk and backing diversity also matter: a chain with slightly lower total supply but better distribution across high-quality, diverse stablecoins may have a higher Chain Health Score.",
  },
] satisfies readonly FaqItem[];

function ChainDirectory({ entries }: { entries: readonly ChainDirectoryEntry[] }) {
  return (
    <section className="space-y-3" aria-labelledby="chain-directory-heading">
      <div className="space-y-1.5">
        <h2
          id="chain-directory-heading"
          className="pharos-kicker"
        >
          Chain Profile Directory
        </h2>
        <p className="text-sm text-muted-foreground">
          Open any static chain profile, then compare its live supply, health score, and tracked deployments.
        </p>
      </div>
      <nav aria-label="Chain profile directory" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {entries.map((entry) => (
          <Link
            key={entry.id}
            href={entry.href}
            className="pharos-focus-ring rounded-xl border border-border/60 bg-background/60 px-3 py-3 text-sm transition-colors hover:bg-accent"
          >
            <span className="flex items-center justify-between gap-2">
              <span className="font-medium text-foreground">{entry.name} stablecoins</span>
              <ChainTypeBadge type={entry.type} />
            </span>
            <span className="mt-2 block text-xs text-muted-foreground">
              {entry.deploymentCount} tracked deployment{entry.deploymentCount === 1 ? "" : "s"}
            </span>
            <span className="mt-1 block text-xs text-muted-foreground">{getChainRuntimeContext(entry)}</span>
          </Link>
        ))}
      </nav>
    </section>
  );
}

export default function ChainsPage() {
  const chainEntries = getChainDirectoryEntries();
  const chainDirectoryJsonLd = buildChainDirectoryJsonLd(chainEntries);

  return (
    <FeaturePageShell
      breadcrumbName="Chains"
      path="/chains/"
      title="Chains"
      methodology={{
        version: CHAIN_HEALTH_METHODOLOGY_VERSION,
        changelogPath: CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH,
      }}
      leadParagraphs={["Blockchain networks ranked by stablecoin supply and ecosystem health."]}
      preface={
        <JsonLdScript json={safeJsonLd(chainDirectoryJsonLd)} />
      }
    >
      <ChainsLeaderboardClient />
      <FaqSection items={CHAINS_FAQ_ITEMS} title="Chains FAQ" includeJsonLd />
      <ChainDirectory entries={chainEntries} />
    </FeaturePageShell>
  );
}
