import type { Metadata } from "next";
import Link from "next/link";
import { CHAIN_META } from "@shared/lib/chains";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { CHAIN_HEALTH_METHODOLOGY_VERSION, CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH } from "@shared/lib/chain-health-version";
import { buildPageMetadata } from "@/lib/page-metadata";
import { ChainsLeaderboardClient } from "./client";
import { FeaturePageShell } from "@/components/feature-page-shell";

export const metadata: Metadata = buildPageMetadata({
  title: "Chains",
  description: "Ranking blockchain networks by stablecoin supply, health score, and composition. Explore per-chain stablecoin analytics on Pharos.",
  canonical: "/chains/",
});

function getActiveChainIds(): string[] {
  const chainIds = new Set<string>();
  for (const coin of TRACKED_STABLECOINS) {
    if (coin.contracts) {
      for (const contract of coin.contracts) {
        if (CHAIN_META[contract.chain]) chainIds.add(contract.chain);
      }
    }
  }
  return Array.from(chainIds).sort();
}

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
        "Blockchain networks ranked by stablecoin supply and health. The Chain Health Score rates each chain's stablecoin ecosystem on quality, chain environment, concentration, peg stability, and backing diversity.",
      ]}
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
