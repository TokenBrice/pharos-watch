import type { Metadata } from "next";
import { FeaturePageShell } from "@/components/feature-page-shell";
import {
  FundingKpiRow,
  CostBreakdown,
  DonorList,
  SupportCtas,
  YearEndHorizon,
  FundingFaq,
} from "@/components/funding/funding-page-sections";
import { computeCostsTotal, summarizeDonations } from "@shared/lib/funding/helpers";
import costsData from "@shared/data/funding/costs.json";
import donationsData from "@shared/data/funding/donations.json";
import type { CostsFile, DonationsFile } from "@shared/lib/funding/types";

export const metadata: Metadata = {
  title: "Funding",
  description: "On-chain donations, running costs, and Pharos's path to staying freely accessible.",
  robots: { index: false, follow: false }, // stealth release — not indexed in v1
  alternates: { canonical: "/funding/" },
};

// Build-time timestamp anchors "this month" for the KPI split. Static export
// means this reflects the last deploy, not the visitor's clock. Monthly
// boundaries can be up to ~7 days stale (funding-update skill cadence);
// acceptable for a stealth-released page with weekly redeploys.
const BUILD_TIMESTAMP_SEC = Math.floor(Date.now() / 1000);

export default function FundingPage() {
  const costs = costsData as CostsFile;
  const donations = donationsData as DonationsFile;
  const summary = summarizeDonations(donations.donations, BUILD_TIMESTAMP_SEC);
  const monthlyTargetUsd = computeCostsTotal(costs.items);

  return (
    <FeaturePageShell
      breadcrumbName="Funding"
      path="/funding/"
      title="Funding"
      leadParagraphs={[
        "An honest ledger of what Pharos costs to run, what supporters cover, and how each donation helps keep stablecoin risk analytics freely accessible to everyone.",
      ]}
    >
      <div className="space-y-8">
        <FundingKpiRow summary={summary} monthlyTargetUsd={monthlyTargetUsd} />
        <div className="grid gap-4 lg:grid-cols-2">
          <CostBreakdown
            items={costs.items}
            currentCommunityUsd={summary.currentMonthCommunityUsd}
            lastReviewedAt={costs.last_reviewed_at}
          />
          <DonorList donations={donations.donations} lastUpdatedAt={donations.last_updated_at} />
        </div>
        <YearEndHorizon />
        <SupportCtas />
        <FundingFaq />
      </div>
    </FeaturePageShell>
  );
}
