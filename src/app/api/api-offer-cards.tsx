import Link from "next/link";
import { ArrowRight, ExternalLink, KeyRound } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import { summarizeCountingCoinNames, type DonorKeyQualifyingCoin } from "@/lib/donor-key-qualifying-coins";
import {
  API_KEY_COMMERCIAL_MONTHLY_REQUEST_QUOTA,
  API_KEY_COMMERCIAL_RATE_LIMIT_PER_MINUTE,
  API_KEY_FREE_PARTNER_MONTHLY_REQUEST_QUOTA,
  API_KEY_FREE_PARTNER_RATE_LIMIT_PER_MINUTE,
  API_KEY_INSTITUTIONAL_MONTHLY_REQUEST_QUOTA,
  API_KEY_INSTITUTIONAL_RATE_LIMIT_PER_MINUTE,
  API_KEY_MONTHLY_QUOTA_EFFECTIVE_SEC,
  DONOR_API_KEY_DAYS_PER_MIN_USD,
  DONOR_API_KEY_MIN_USD,
  DONOR_API_KEY_MONTHLY_REQUEST_QUOTA,
  DONOR_API_KEY_RATE_LIMIT_PER_MINUTE,
} from "@shared/lib/ops-limits";
import {
  API_ACCESS_TELEGRAM_HANDLE,
  API_ACCESS_TELEGRAM_URL,
  API_ACCESS_X_HANDLE,
  API_ACCESS_X_URL,
  API_BREAKING_CHANGE_NOTICE_DAYS,
  API_PAGE_ANCHORS,
  COMMERCIAL_API_KEY_EVAL_DAYS,
  COMMERCIAL_API_KEY_USD_PER_MONTH,
  COMMERCIAL_API_KEY_USD_PER_QUARTER,
  COMMERCIAL_API_KEY_USD_PER_YEAR,
  INSTITUTIONAL_API_KEY_USD_PER_MONTH,
  INSTITUTIONAL_API_KEY_USD_PER_YEAR,
  PARTNER_KEY_REPLY_BUSINESS_DAYS,
  PARTNER_KEY_REQUEST_TEMPLATE,
} from "@shared/lib/public-api-contract";
import { formatLongDate } from "@shared/lib/format";
import { ApiDisclosure } from "./api-disclosure";
import type { ApiCoverageFacts } from "./api-landing-data";

const CARD_CLASS_NAME = "pharos-card-shell flex scroll-mt-20 flex-col gap-4 px-5 py-6 sm:px-6";
const CARD_TITLE_CLASS_NAME = "text-2xl font-semibold tracking-tight text-foreground";
const CARD_PITCH_CLASS_NAME = "text-sm leading-relaxed text-muted-foreground";
const CTA_ROW_CLASS_NAME = "flex flex-col gap-3 sm:flex-row sm:flex-wrap";

const formatRequestQuota = (value: number): string => value.toLocaleString("en-US");
const QUOTA_EFFECTIVE_DATE = formatLongDate(new Date(API_KEY_MONTHLY_QUOTA_EFFECTIVE_SEC * 1000), { utc: true });
/** One request a minute over an average month, rounded to the nearest thousand. */
const ONE_PER_MINUTE_MONTHLY_REQUESTS = Math.round((60 * 24 * 365.25) / 12 / 1000) * 1000;

interface SupporterOfferProps {
  coins: readonly DonorKeyQualifyingCoin[];
  gradesAsOf: string;
  supporterCount: number;
}

// Only coins graded A or B are named; an unavailable grade is left out rather
// than described as not counting, and claim step 1 shows the full list.
function describeCountingCoins(coins: readonly DonorKeyQualifyingCoin[], asOfDate: string): string {
  const countingTotal = coins.filter((coin) => coin.status === "counts").length;
  if (countingTotal === 0) {
    if (coins.some((coin) => coin.status === "unavailable")) {
      return `No listed stablecoin is confirmed to count as of ${asOfDate}; some grades are unavailable. The full list is in the claim steps below, and grades are checked again when you claim.`;
    }
    return `No listed stablecoin has an A or B grade as of ${asOfDate}. The full list is in the claim steps below, and grades are checked again when you claim.`;
  }
  return `Counts toward the key: ${summarizeCountingCoinNames(coins)}, graded A or B as of ${asOfDate}. Grades are checked again when you claim.`;
}

function SupporterKeyCard({ coins, gradesAsOf, supporterCount }: SupporterOfferProps) {
  return (
    <section id={API_PAGE_ANCHORS.supporterKey} aria-labelledby="supporter-key-title" className={CARD_CLASS_NAME}>
      <div className="space-y-2">
        <p className="pharos-label">For individuals</p>
        <h2 id="supporter-key-title" className={CARD_TITLE_CLASS_NAME}>
          Supporter key
        </h2>
        <p className={CARD_PITCH_CLASS_NAME}>
          Donate ${DONOR_API_KEY_MIN_USD} or more for {DONOR_API_KEY_DAYS_PER_MIN_USD} days of access, counted from when
          you claim. Covers peg, supply, depeg events, liquidity, reserves and contract lookup.
        </p>
      </div>
      <ul className="flex flex-wrap gap-x-5 gap-y-1 text-sm font-semibold text-foreground">
        <li className="pharos-numeric">{DONOR_API_KEY_RATE_LIMIT_PER_MINUTE} requests/min</li>
        <li className="pharos-numeric">{formatRequestQuota(DONOR_API_KEY_MONTHLY_REQUEST_QUOTA)} requests/month</li>
        <li className="pharos-numeric">
          {DONOR_API_KEY_DAYS_PER_MIN_USD} days per ${DONOR_API_KEY_MIN_USD}
        </li>
      </ul>
      <div className="space-y-1.5">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Polling one endpoint every minute uses about {formatRequestQuota(ONE_PER_MINUTE_MONTHLY_REQUESTS)} requests a
          month. Keys are ready the Sunday after your donation is recorded, so within 7 days.
        </p>
        <p className={CARD_PITCH_CLASS_NAME}>{describeCountingCoins(coins, gradesAsOf)}</p>
        {supporterCount > 0 ? (
          <p className="text-sm text-foreground">
            Backed by <span className="pharos-numeric">{supporterCount}</span>{" "}
            {supporterCount === 1 ? "supporter" : "supporters"} since launch.
          </p>
        ) : null}
      </div>
      <div className={CTA_ROW_CLASS_NAME}>
        <Button asChild size="lg" className="w-full gap-2 sm:w-auto">
          <Link href={`#${API_PAGE_ANCHORS.claim}`}>
            <KeyRound className="h-4 w-4" aria-hidden="true" />
            Claim your key
          </Link>
        </Button>
        <Button asChild variant="outline" size="lg" className="w-full gap-2 bg-transparent sm:w-auto">
          <Link href="/funding/#how-to-support">
            Donate ${DONOR_API_KEY_MIN_USD}+
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </Button>
      </div>
      <p className="border-t border-border/55 pt-3 text-xs leading-relaxed text-muted-foreground">
        Open-source project or academic research? A free partner key carries{" "}
        <span className="pharos-numeric text-foreground">{API_KEY_FREE_PARTNER_RATE_LIMIT_PER_MINUTE}/min</span> and{" "}
        <span className="pharos-numeric text-foreground">
          {formatRequestQuota(API_KEY_FREE_PARTNER_MONTHLY_REQUEST_QUOTA)} requests/month
        </span>
        , with attribution.{" "}
        <a href={API_ACCESS_TELEGRAM_URL} target="_blank" rel="noopener noreferrer" className="pharos-prose-link text-foreground">
          Ask on Telegram
        </a>
        .
      </p>
      <p className="pharos-meta">For personal, non-commercial use. Revocable, best effort, no SLA.</p>
    </section>
  );
}

function TeamPlansCard({ coverage }: { coverage?: ApiCoverageFacts }) {
  return (
    <section id={API_PAGE_ANCHORS.partnerAccess} aria-labelledby="partner-key-title" className={CARD_CLASS_NAME}>
      <div className="space-y-2">
        <p className="pharos-label">For teams in production</p>
        <h2 id="partner-key-title" className={CARD_TITLE_CLASS_NAME}>
          Team plans
        </h2>
        <p className={CARD_PITCH_CLASS_NAME}>
          Partner keys for vault curators, risk desks, exchanges, wallets and data products. Issued by hand, paid in
          stablecoins.
        </p>
      </div>
      <div className="space-y-2.5">
        <div className="pharos-inset space-y-1 p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-sm font-semibold text-foreground">Commercial</span>
            <span className="pharos-numeric text-sm font-semibold text-foreground">
              ${COMMERCIAL_API_KEY_USD_PER_MONTH}/mo · ${COMMERCIAL_API_KEY_USD_PER_QUARTER}/qtr · $
              {COMMERCIAL_API_KEY_USD_PER_YEAR.toLocaleString("en-US")}/yr
            </span>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            <span className="pharos-numeric text-foreground">{API_KEY_COMMERCIAL_RATE_LIMIT_PER_MINUTE}/min</span>,{" "}
            <span className="pharos-numeric text-foreground">
              {formatRequestQuota(API_KEY_COMMERCIAL_MONTHLY_REQUEST_QUOTA)} requests/month
            </span>
            . Every endpoint, plus the Compliance API, Risk-Gate and the hosted MCP server.
          </p>
        </div>
        <div className="pharos-inset space-y-1 p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-sm font-semibold text-foreground">Institutional</span>
            <span className="pharos-numeric text-sm font-semibold text-foreground">
              From ${INSTITUTIONAL_API_KEY_USD_PER_MONTH.toLocaleString("en-US")}/mo · $
              {INSTITUTIONAL_API_KEY_USD_PER_YEAR.toLocaleString("en-US")}/yr
            </span>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            <span className="pharos-numeric text-foreground">{API_KEY_INSTITUTIONAL_RATE_LIMIT_PER_MINUTE}/min</span>,{" "}
            <span className="pharos-numeric text-foreground">
              {formatRequestQuota(API_KEY_INSTITUTIONAL_MONTHLY_REQUEST_QUOTA)} requests/month
            </span>
            , higher on request. Everything in Commercial, plus priority integration help and custom coverage onboarding.
          </p>
        </div>
      </div>
      <div className="space-y-1.5 text-xs leading-relaxed text-muted-foreground">
        {coverage ? (
          <p>
            Covers <span className="pharos-numeric text-foreground">{formatRequestQuota(coverage.stablecoins)}</span>{" "}
            stablecoins, <span className="pharos-numeric text-foreground">{formatRequestQuota(coverage.deployments)}</span>{" "}
            contracts on <span className="pharos-numeric text-foreground">{coverage.chains}</span> chains and{" "}
            <span className="pharos-numeric text-foreground">{formatRequestQuota(coverage.complianceDossiers)}</span> MiCA
            and GENIUS dossiers.
          </p>
        ) : null}
        <p className="text-foreground">
          Paying buys throughput, endpoints and support. It never buys a grade, a listing or a softer score.
        </p>
      </div>
      <div className={CTA_ROW_CLASS_NAME}>
        <Button asChild size="lg" className="h-auto min-h-10 w-full gap-2 whitespace-normal sm:w-auto">
          <a href={API_ACCESS_TELEGRAM_URL} target="_blank" rel="noopener noreferrer">
            Request a {COMMERCIAL_API_KEY_EVAL_DAYS}-day evaluation key
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </Button>
        <Button
          asChild
          variant="outline"
          size="lg"
          className="h-auto min-h-10 w-full gap-2 whitespace-normal bg-transparent sm:w-auto"
        >
          <a href={API_ACCESS_X_URL} target="_blank" rel="noopener noreferrer">
            Message @{API_ACCESS_X_HANDLE} on X
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </Button>
      </div>
      <p className="pharos-meta">
        Requests go to @{API_ACCESS_TELEGRAM_HANDLE} on Telegram or @{API_ACCESS_X_HANDLE} on X, with a reply within{" "}
        {PARTNER_KEY_REPLY_BUSINESS_DAYS} business days (a service commitment, not a contractual SLA). Freshness is stamped
        on every response. Check the exact handle: Pharos never asks for wallet credentials, and payments go only to the
        addresses on the{" "}
        <Link href="/funding/#how-to-support" className="pharos-prose-link">
          funding page
        </Link>
        .
      </p>
      <ApiDisclosure summary="What to include in your request" framed={false}>
        <div className="flex items-start gap-2">
          <pre className="min-w-0 flex-1 whitespace-pre-wrap rounded-md bg-muted/40 px-3 py-2 font-mono text-xs leading-relaxed text-foreground [overflow-wrap:anywhere]">
            <code>{PARTNER_KEY_REQUEST_TEMPLATE}</code>
          </pre>
          <CopyButton text={PARTNER_KEY_REQUEST_TEMPLATE} className="size-11 shrink-0 sm:size-8" />
        </div>
      </ApiDisclosure>
    </section>
  );
}

/** The two offers, supporter first so it also leads the mobile stack. */
export function ApiOfferCards({ coverage, ...props }: SupporterOfferProps & { coverage?: ApiCoverageFacts }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2 md:items-start">
        <SupporterKeyCard {...props} />
        <TeamPlansCard coverage={coverage} />
      </div>
      <p className="pharos-meta">
        Monthly request volumes are counted per UTC calendar month and apply from {QUOTA_EFFECTIVE_DATE}. Breaking changes
        to keyed routes get {API_BREAKING_CHANGE_NOTICE_DAYS} days&apos; notice. See the{" "}
        <Link href="/api/terms/" className="pharos-prose-link">
          API terms
        </Link>
        .
      </p>
    </div>
  );
}
