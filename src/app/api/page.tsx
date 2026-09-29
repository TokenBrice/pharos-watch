import Link from "next/link";
import { ArrowUpRight, BookOpen, Handshake, KeyRound } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { getCurrentDonorKeyQualifyingCoins } from "@/lib/donor-key-qualifying-coins";
import { buildPageMetadata } from "@/lib/page-metadata";
import { API_PATHS } from "@shared/lib/api-endpoints";
import { CHAIN_META } from "@shared/lib/chains";
import donationsData from "@shared/data/funding/donations.json";
import { formatIsoDate } from "@shared/lib/format";
import { summarizeDonations } from "@shared/lib/funding/helpers";
import { DonationsFileSchema } from "@shared/lib/funding/schema";
import { DONOR_API_KEY_MIN_USD } from "@shared/lib/ops-limits";
import { API_PAGE_ANCHORS, PUBLIC_API_ARTIFACTS, PUBLIC_API_HOST } from "@shared/lib/public-api-contract";
import { ApiOfferCards } from "./api-offer-cards";
import { SupporterClaimSteps } from "./supporter-claim-steps";

export const metadata = buildPageMetadata({
  title: "Stablecoin API Access: Supporter and Partner Keys",
  description:
    `Free Safety Score grades with no key, a supporter key for $${DONOR_API_KEY_MIN_USD}+ donors, and partner keys with higher limits, integration help and direct support.`,
  canonical: "/api/",
});

const FREE_GRADES_CURL = `curl ${PUBLIC_API_HOST}${API_PATHS.safetyGrades()}`;

// Eligibility follows the committed donation ledger, so the reconciliation date
// is the honest "as of" for the perk: a donation sent after it counts only once
// the funding skill appends the row and a release ships.
const LEDGER_RECONCILED_DATE = formatIsoDate(donationsData.last_updated_at);

const DEVELOPER_RESOURCES = [
  { label: "API reference", href: "/about/api/", artifact: false },
  { label: "Full reference", href: "/docs/api-reference/", artifact: false },
  { label: "OpenAPI", href: PUBLIC_API_ARTIFACTS.openApi, artifact: true },
  { label: "Postman collection", href: PUBLIC_API_ARTIFACTS.postmanCollection, artifact: true },
  { label: "Postman environment", href: PUBLIC_API_ARTIFACTS.postmanEnvironment, artifact: true },
  { label: "Status", href: "/status/", artifact: false },
] as const;

const PILL_CLASS_NAME = "pharos-control-pill pharos-focus-ring gap-1.5";

export default function ApiAccessPage() {
  const ledger = DonationsFileSchema.parse(donationsData);
  // Same count as the /funding/ "supporters since launch" figure.
  const supporterCount = summarizeDonations(ledger.donations, ledger.last_updated_at).lifetimeCommunityDonorCount;
  const { asOfDate, coins } = getCurrentDonorKeyQualifyingCoins();
  // Chain display names resolve here so the wallet check ships no chain registry.
  const chainNames = Object.fromEntries(
    ledger.donations.map((donation) => [donation.chain, CHAIN_META[donation.chain]?.name ?? donation.chain]),
  );

  return (
    <FeaturePageShell
      breadcrumbName="API Access"
      path="/api/"
      title="Pharos API access"
      leadParagraphs={[
        "Safety Score grades need no key. Peg, supply, liquidity, reserve and depeg data need a supporter or partner key.",
      ]}
      headerSupplement={
        <div className="flex flex-wrap gap-2">
          <Link href={`#${API_PAGE_ANCHORS.supporterKey}`} className={PILL_CLASS_NAME}>
            <KeyRound className="h-4 w-4" aria-hidden="true" />
            Supporter key
          </Link>
          <Link href={`#${API_PAGE_ANCHORS.partnerAccess}`} className={PILL_CLASS_NAME}>
            <Handshake className="h-4 w-4" aria-hidden="true" />
            Partner key
          </Link>
          <Link href="/about/api/" className={PILL_CLASS_NAME}>
            <BookOpen className="h-4 w-4" aria-hidden="true" />
            API reference
          </Link>
        </div>
      }
    >
      <div className="space-y-12">
        <div className="space-y-4">
          <ApiOfferCards coins={coins} gradesAsOf={asOfDate} supporterCount={supporterCount} />
          <div className="pharos-subtle-band flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <p className="text-sm font-medium text-foreground">
              No key needed: Safety Score grades for every tracked stablecoin.
            </p>
            <div className="flex min-w-0 items-center gap-1">
              <code className="min-w-0 font-mono text-xs text-foreground [overflow-wrap:anywhere]">
                {FREE_GRADES_CURL}
              </code>
              <CopyButton text={FREE_GRADES_CURL} className="size-11 shrink-0 sm:size-8" />
            </div>
          </div>
        </div>

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
          <p className="pharos-kicker">Developer resources</p>
          <ul className="flex flex-wrap gap-2">
            {DEVELOPER_RESOURCES.map((resource) => (
              <li key={resource.href}>
                {resource.artifact ? (
                  <a href={resource.href} className={PILL_CLASS_NAME}>
                    {resource.label}
                    <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
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
    </FeaturePageShell>
  );
}
