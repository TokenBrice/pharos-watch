import { FeaturePageShell } from "@/components/feature-page-shell";
import {
  FundingKpiRow,
  CostBreakdown,
  DonorList,
  SupportCtas,
  YearEndHorizon,
  FundingFaq,
} from "@/components/funding/funding-page-sections";
import { buildPageMetadata } from "@/lib/page-metadata";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { computeCostsTotal, computeMonthlyHistory, summarizeDonations } from "@shared/lib/funding/helpers";
import costsData from "@shared/data/funding/costs.json";
import donationsData from "@shared/data/funding/donations.json";
import { CostsFileSchema, DonationsFileSchema } from "@shared/lib/funding/schema";

export const metadata = buildPageMetadata({
  title: "Pharos Funding: Costs, Donations & Public Ledger",
  description:
    "See Pharos running costs, on-chain donations, monthly funding progress, donor ledger, and the path to keeping stablecoin risk analytics freely accessible.",
  canonical: "/funding/",
  ogImage: `${SITE_URL}/og-funding.png`,
});

// Build-time timestamp anchors "this month" for the KPI split. Static export
// means this reflects the last deploy, not the visitor's clock. Monthly
// boundaries can be up to ~7 days stale (funding-update skill cadence).
const BUILD_TIMESTAMP_SEC = Math.floor(Date.now() / 1000);

export default function FundingPage() {
  const costs = CostsFileSchema.parse(costsData);
  const donations = DonationsFileSchema.parse(donationsData);
  const summary = summarizeDonations(donations.donations, BUILD_TIMESTAMP_SEC);
  const monthlyHistory = computeMonthlyHistory(donations.donations, BUILD_TIMESTAMP_SEC);
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
        <FundingKpiRow
          summary={summary}
          monthlyTargetUsd={monthlyTargetUsd}
          monthlyHistory={monthlyHistory}
        />
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
