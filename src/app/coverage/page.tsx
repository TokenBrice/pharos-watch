import { FeaturePageShell } from "@/components/feature-page-shell";
import { buildPageMetadata } from "@/lib/page-metadata";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import CoveragePageClient from "./client";

const coverageDescription =
  "Per-coin feature coverage across Pharos. See which stablecoins have depeg tracking, DEX price verification, reserve views, yield intelligence, mint/burn flows, blacklist tracking, Bluechip ratings, and dependency-map visibility.";

export const metadata = buildPageMetadata({
  title: "Coverage Matrix: Stablecoin Feature Coverage",
  description: coverageDescription,
  canonical: "/coverage/",
});

export default function CoveragePage() {
  return (
    <FeaturePageShell
      breadcrumbName="Coverage"
      path="/coverage/"
      title="Coverage"
      statusBadge={{ status: "mature" }}
      leadParagraphs={[
        `Feature coverage across ${TRACKED_STABLECOINS.length} tracked stablecoins.`,
        "This matrix shows which Pharos surfaces are available per asset today, with counts and market-cap share so you can distinguish broad long-tail coverage from coverage concentrated in the majors.",
      ]}
    >
      <CoveragePageClient />
    </FeaturePageShell>
  );
}
