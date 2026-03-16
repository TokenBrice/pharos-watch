import type { Metadata } from "next";
import { buildPageMetadata } from "@/lib/page-metadata";
import { ChainsLeaderboardClient } from "./client";
import { FeaturePageShell } from "@/components/feature-page-shell";

export const metadata: Metadata = buildPageMetadata({
  title: "Chains",
  description: "Ranking blockchain networks by stablecoin supply, health score, and composition. Explore per-chain stablecoin analytics on Pharos.",
  canonical: "/chains/",
});

export default function ChainsPage() {
  return (
    <FeaturePageShell
      breadcrumbName="Chains"
      path="/chains/"
      title="Chains"
      statusBadge={{ status: "experimental" }}
      methodology={{ version: "1.0", changelogPath: "/methodology#chain-health-score" }}
      leadParagraphs={[
        "Blockchain networks ranked by stablecoin supply and health. The Chain Health Score rates each chain's stablecoin ecosystem on quality, concentration, peg stability, and backing diversity.",
      ]}
    >
      <ChainsLeaderboardClient />
    </FeaturePageShell>
  );
}
