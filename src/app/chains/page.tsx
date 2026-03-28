import type { Metadata } from "next";
import Link from "next/link";
import { CHAIN_META, getActiveChainIds } from "@shared/lib/chains";
import { CHAIN_HEALTH_METHODOLOGY_VERSION, CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH } from "@shared/lib/chain-health-version";
import { buildPageMetadata } from "@/lib/page-metadata";
import { SITE_URL } from "@/lib/site-config";
import { safeJsonLd } from "@/lib/json-ld";
import { buildFaqJsonLd } from "@/lib/faq";
import { ChainsLeaderboardClient } from "./client";
import { FeaturePageShell } from "@/components/feature-page-shell";

export const metadata: Metadata = buildPageMetadata({
  title: "Chains",
  description: "Ranking blockchain networks by stablecoin supply, health score, and composition. Explore per-chain stablecoin analytics on Pharos.",
  canonical: "/chains/",
  ogImage: `${SITE_URL}/og-chains.png`,
});

const CHAINS_FAQ_JSON_LD = buildFaqJsonLd([
  {
    question: "What is the Chain Health Score?",
    answer: "The Chain Health Score is a composite rating (0–100) that evaluates a blockchain's stablecoin ecosystem across five dimensions: stablecoin quality (market cap and safety grades), chain environment (settlement finality, uptime, and decentralization), concentration risk (supply distribution across coins), peg stability (aggregate deviation from target prices), and backing diversity (collateral types and governance models).",
  },
  {
    question: "Which chains have the most stablecoin supply?",
    answer: "Ethereum dominates stablecoin supply, followed by Tron, BSC, Solana, and Arbitrum. However, supply alone doesn't tell the full story—concentration risk and backing diversity also matter. A chain with slightly lower total supply but better distribution across high-quality, diverse stablecoins may have a higher Chain Health Score.",
  },
]);

export default function ChainsPage() {
  const chainIds = getActiveChainIds();
  return (
    <FeaturePageShell
      breadcrumbName="Chains"
      path="/chains/"
      title="Chains"
      statusBadge={{ status: "experimental" }}
      methodology={{ version: CHAIN_HEALTH_METHODOLOGY_VERSION, changelogPath: CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH }}
      leadParagraphs={[
        "Blockchain networks ranked by stablecoin supply and ecosystem health.",
      ]}
      preface={
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: safeJsonLd(CHAINS_FAQ_JSON_LD) }}
        />
      }
    >
      <ChainsLeaderboardClient />
      {/* Server-rendered chain links for SEO crawlability */}
      <nav className="sr-only" aria-label="All chain profiles">
        <ul>
          {chainIds.map((id) => (
            <li key={id}>
              <Link href={`/chains/${id}/`}>{CHAIN_META[id]?.name ?? id}</Link>
            </li>
          ))}
        </ul>
      </nav>
    </FeaturePageShell>
  );
}
