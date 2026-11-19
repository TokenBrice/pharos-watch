import { FeaturePageShell } from "@/components/feature-page-shell";
import {
  FundingHero,
  CostBreakdown,
  DonorList,
  SupportCtas,
  FundingFaq,
} from "@/components/funding/funding-page-sections";
import { buildPageMetadata } from "@/lib/page-metadata";
import { buildMonthlyFunding, computeCostsTotal, summarizeDonations } from "@shared/lib/funding/helpers";
import costsData from "@shared/data/funding/costs.json";
import donationsData from "@shared/data/funding/donations.json";
import { CostsFileSchema, TransferDonationsFileSchema } from "@shared/lib/funding/schema";

export const metadata = buildPageMetadata({
  title: "Funding: Costs, Donations & Public Ledger",
  description:
    "See Pharos running costs, on-chain donations, monthly funding progress, donor ledger, and the path to keeping stablecoin risk analytics freely accessible.",
  canonical: "/funding/",
});

// Build-time timestamp anchors "this month". Static export means this reflects
// the last deploy, not the visitor's clock; the hero names the ledger date.
const BUILD_TIMESTAMP_SEC = Math.floor(Date.now() / 1000);

export default function FundingPage() {
  const costs = CostsFileSchema.parse(costsData);
  const donations = TransferDonationsFileSchema.parse(donationsData);
  const summary = summarizeDonations(donations.donations, BUILD_TIMESTAMP_SEC);
  const months = buildMonthlyFunding(donations.donations, costs, BUILD_TIMESTAMP_SEC);
  const founderOneTimeUsd = costs.one_time
    .filter((cost) => cost.paid_by === "founder")
    .reduce((sum, cost) => sum + cost.usd, 0);

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
        <FundingHero
          summary={summary}
          months={months}
          monthlyCostUsd={computeCostsTotal(costs.items)}
          founderUsd={summary.lifetimeFounderUsd + founderOneTimeUsd}
          ledgerUpdatedAt={donations.last_updated_at}
        />
        <CostBreakdown items={costs.items} oneTime={costs.one_time} lastReviewedAt={costs.last_reviewed_at} />
        <SupportCtas />
        <DonorList donations={donations.donations} lastUpdatedAt={donations.last_updated_at} />
        <FundingFaq />
      </div>
    </FeaturePageShell>
  );
}
