import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { getCurrentDonorKeyQualifyingCoins } from "@/lib/donor-key-qualifying-coins";
import { buildPageMetadata } from "@/lib/page-metadata";
import { CHAIN_META } from "@shared/types/chain-identity";
import donationsData from "@shared/data/funding/donations.json";
import { formatIsoDate } from "@shared/lib/format";
import { summarizeDonations } from "@shared/lib/funding/helpers";
import { TransferDonationsFileSchema } from "@shared/lib/funding/schema";
import { DONOR_API_KEY_MIN_USD } from "@shared/lib/ops-limits";
import { API_PAGE_ANCHORS, PUBLIC_API_ARTIFACTS } from "@shared/lib/public-api-contract";
import { buildApiPreviewExamples, getApiCoverageFacts } from "./api-landing-data";
import { ApiBadgeSection, ApiCoverageFactsRow, ApiFreeAccess, ApiTrustPoints } from "./api-landing-sections";
import { ApiOfferCards } from "./api-offer-cards";
import { ApiPartnerLogos } from "./api-partner-logos";
import { ApiPreviewTabs } from "./api-preview-tabs";
import { ApiTabs } from "./api-tabs";
import { SupporterClaimSteps } from "./supporter-claim-steps";

export const metadata = buildPageMetadata({
  title: "Stablecoin API: Free Safety Grades, Peg & Supply",
  description:
    `Free Safety Score grades with no key, a supporter key for $${DONOR_API_KEY_MIN_USD}+ donors, partner keys, and the full API reference: auth, endpoints, response contracts and datasets.`,
  canonical: "/api/",
});

// Eligibility follows the committed donation ledger, so the reconciliation date
// is the honest "as of" for the perk: a donation sent after it counts only once
// the funding skill appends the row and a release ships.
const LEDGER_RECONCILED_DATE = formatIsoDate(donationsData.last_updated_at);

const DEVELOPER_RESOURCES = [
  { label: "API reference", href: "/api/reference/", artifact: false },
  { label: "API terms", href: "/api/terms/", artifact: false },
  { label: "OpenAPI", href: PUBLIC_API_ARTIFACTS.openApi, artifact: true },
  { label: "Postman collection", href: PUBLIC_API_ARTIFACTS.postmanCollection, artifact: true },
  { label: "Postman environment", href: PUBLIC_API_ARTIFACTS.postmanEnvironment, artifact: true },
  { label: "Status", href: "/status/", artifact: false },
] as const;

const PILL_CLASS_NAME = "pharos-control-pill pharos-focus-ring gap-1.5";

export default async function ApiPage() {
  const ledger = TransferDonationsFileSchema.parse(donationsData);
  // Same count as the /funding/ "supporters since launch" figure.
  const supporterCount = summarizeDonations(ledger.donations, ledger.last_updated_at).lifetimeCommunityDonorCount;
  const { asOfDate, coins } = getCurrentDonorKeyQualifyingCoins();
  const coverage = getApiCoverageFacts();
  const previewExamples = buildApiPreviewExamples(asOfDate);
  // Chain display names resolve here so the wallet check ships no chain registry.
  const chainNames = Object.fromEntries(
    ledger.donations.map((donation) => [donation.chain, CHAIN_META[donation.chain]?.name ?? donation.chain]),
  );

  return (
    <FeaturePageShell
      breadcrumbName="API"
      path="/api/"
      title="Pharos API"
      leadParagraphs={[
        "Stablecoin risk data you can query, download and cite, from an independent open-source tracker. Safety grades, badges and MIT datasets are free with no key. Peg, supply, liquidity and depeg data need a key: a supporter key for personal use, or a team plan for products.",
      ]}
      headerSupplement={
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <ApiCoverageFactsRow facts={coverage} />
          <ApiPartnerLogos />
        </div>
      }
    >
      <ApiTabs active="access">
          <div className="space-y-12">
            <div className="space-y-4">
              <ApiOfferCards coins={coins} gradesAsOf={asOfDate} supporterCount={supporterCount} coverage={coverage} />
              <ApiFreeAccess />
            </div>

            <ApiPreviewTabs examples={previewExamples} />

            <ApiTrustPoints methodologyLabel={coverage.methodologyLabel} />

            <ApiBadgeSection badge={previewExamples.badge} asOfDate={previewExamples.asOfDate} />

            <SupporterClaimSteps
              coins={coins}
              gradesAsOf={asOfDate}
              donations={ledger.donations}
              chainNames={chainNames}
              ledgerReconciledDate={LEDGER_RECONCILED_DATE}
            />

            <nav
              id={API_PAGE_ANCHORS.developerResources}
              aria-label="Developer resources"
              className="scroll-mt-20 space-y-3 border-t border-border/55 pt-6"
            >
              <p className="pharos-label">Developer resources</p>
              <ul className="flex flex-wrap gap-2">
                {DEVELOPER_RESOURCES.map((resource) => (
                  <li key={resource.href}>
                    {resource.artifact || resource.href.startsWith("#") ? (
                      <a href={resource.href} className={PILL_CLASS_NAME}>
                        {resource.label}
                        {resource.artifact ? <ArrowUpRight className="h-4 w-4" aria-hidden="true" /> : null}
                      </a>
                    ) : (
                      <Link href={resource.href} className={PILL_CLASS_NAME}>
                        {resource.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </nav>
          </div>
      </ApiTabs>
    </FeaturePageShell>
  );
}
