import Link from "next/link";
import { ArrowRight, ExternalLink, KeyRound } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import { summarizeCountingCoinNames, type DonorKeyQualifyingCoin } from "@/lib/donor-key-qualifying-coins";
import {
  API_KEY_DEFAULT_RATE_LIMIT_PER_MINUTE,
  DONOR_API_KEY_MIN_USD,
  DONOR_API_KEY_RATE_LIMIT_PER_MINUTE,
} from "@shared/lib/ops-limits";
import {
  API_ACCESS_TELEGRAM_HANDLE,
  API_ACCESS_TELEGRAM_URL,
  API_ACCESS_X_HANDLE,
  API_ACCESS_X_URL,
  API_PAGE_ANCHORS,
  PARTNER_KEY_REPLY_BUSINESS_DAYS,
  PARTNER_KEY_REQUEST_TEMPLATE,
} from "@shared/lib/public-api-contract";
import { ApiDisclosure } from "./api-disclosure";

const CARD_CLASS_NAME = "pharos-card-shell flex scroll-mt-20 flex-col gap-4 px-5 py-6 sm:px-6";
const CARD_TITLE_CLASS_NAME = "text-2xl font-semibold tracking-tight text-foreground";
const CARD_PITCH_CLASS_NAME = "text-sm leading-relaxed text-muted-foreground";
const CTA_ROW_CLASS_NAME = "flex flex-col gap-3 sm:flex-row sm:flex-wrap";

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
    return `No listed stablecoin has an A or B grade as of ${asOfDate}. The full list is in the claim steps below, and grades are checked again when you claim.`;
  }
  return `Counts toward the key: ${summarizeCountingCoinNames(coins)}, graded A or B as of ${asOfDate}. Grades are checked again when you claim.`;
}

function SupporterKeyCard({ coins, gradesAsOf, supporterCount }: SupporterOfferProps) {
  return (
    <section id={API_PAGE_ANCHORS.supporterKey} aria-labelledby="supporter-key-title" className={CARD_CLASS_NAME}>
      <div className="space-y-2">
        <p className="pharos-kicker">For individual builders</p>
        <h2 id="supporter-key-title" className={CARD_TITLE_CLASS_NAME}>
          Supporter key
        </h2>
        <p className={CARD_PITCH_CLASS_NAME}>
          Donate ${DONOR_API_KEY_MIN_USD} or more and claim a key to the data behind every grade.
        </p>
      </div>
      <ul className="flex flex-wrap gap-x-5 gap-y-1 text-sm font-semibold text-foreground">
        <li className="pharos-numeric">{DONOR_API_KEY_RATE_LIMIT_PER_MINUTE} requests/min</li>
        <li className="pharos-numeric">No expiry</li>
        <li className="pharos-numeric">Every read endpoint</li>
      </ul>
      <div className="space-y-1.5">
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
      <p className="pharos-meta">Given as a thank-you. Revocable, best effort, no SLA.</p>
    </section>
  );
}

function PartnerKeyCard() {
  return (
    <section id={API_PAGE_ANCHORS.partnerAccess} aria-labelledby="partner-key-title" className={CARD_CLASS_NAME}>
      <div className="space-y-2">
        <p className="pharos-kicker">For teams in production</p>
        <h2 id="partner-key-title" className={CARD_TITLE_CLASS_NAME}>
          Partner key
        </h2>
        <p className={CARD_PITCH_CLASS_NAME}>
          Issued by hand to exchanges, wallets, risk desks and data products.
        </p>
      </div>
      <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-muted-foreground">
        <li>
          Rate limits from <span className="pharos-numeric text-foreground">{API_KEY_DEFAULT_RATE_LIMIT_PER_MINUTE}</span>{" "}
          requests/min, raised per key.
        </li>
        <li>Expiry and rotation on request.</li>
        <li>Integration help with IDs, endpoints and polling.</li>
        <li>
          Service commitments, not a contractual SLA: freshness stamped on every response and a human reply within{" "}
          {PARTNER_KEY_REPLY_BUSINESS_DAYS} business days.
        </li>
        <li>Cached endpoints keep serving through brief database outages.</li>
      </ul>
      <p className="text-sm leading-relaxed text-foreground">
        Free when your service is free to its users. Commercial integrations agree terms per request.
      </p>
      <div className={CTA_ROW_CLASS_NAME}>
        <Button asChild size="lg" className="h-auto min-h-10 w-full gap-2 whitespace-normal sm:w-auto">
          <a href={API_ACCESS_TELEGRAM_URL} target="_blank" rel="noopener noreferrer">
            Message @{API_ACCESS_TELEGRAM_HANDLE} on Telegram
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
            Or DM @{API_ACCESS_X_HANDLE} on X
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </Button>
      </div>
      <ApiDisclosure summary="What to include" framed={false}>
        <div className="flex items-start gap-2">
          <pre className="min-w-0 flex-1 whitespace-pre-wrap rounded-md bg-muted/40 px-3 py-2 font-mono text-xs leading-relaxed text-foreground [overflow-wrap:anywhere]">
            <code>{PARTNER_KEY_REQUEST_TEMPLATE}</code>
          </pre>
          <CopyButton text={PARTNER_KEY_REQUEST_TEMPLATE} className="size-11 shrink-0 sm:size-8" />
        </div>
        <p className="mt-3 pharos-meta">
          Check the exact handle. Pharos never asks for wallet credentials or payment by direct message.
        </p>
      </ApiDisclosure>
    </section>
  );
}

/** The two offers, supporter first so it also leads the mobile stack. */
export function ApiOfferCards(props: SupporterOfferProps) {
  return (
    <div className="grid gap-4 md:grid-cols-2 md:items-start">
      <SupporterKeyCard {...props} />
      <PartnerKeyCard />
    </div>
  );
}
