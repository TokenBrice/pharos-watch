import Image from "next/image";
import Link from "next/link";
import { ArrowUpRight, Building2, ExternalLink, Heart, KeyRound, Server, Share2, Star, Wallet, Wrench } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/copy-button";
import { FeatureHeroSplit, HeroMetricRow } from "@/components/feature-hero-split";
import { TableBody, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/table";
import { buildExplorerUrl } from "@shared/lib/explorer";
import { formatAddress, formatDecimal, formatEventDate } from "@shared/lib/format";
import { CHAIN_META } from "@shared/types/chain-identity";
import { CLIENT_TRACKED_STABLECOINS } from "@shared/lib/stablecoins/client-registry";
import { fundingTransferId, type CostLineItem, type CostsFile, type Donation, type FundingChain } from "@shared/lib/funding/schema";
import type { DonationSummary, MonthlyFunding } from "@shared/lib/funding/helpers";
import {
  DONOR_API_KEY_DAYS_PER_MIN_USD,
  DONOR_API_KEY_MIN_USD,
  DONOR_API_KEY_RATE_LIMIT_PER_MINUTE,
} from "@shared/lib/ops-limits";
import {
  API_ACCESS_TELEGRAM_HANDLE,
  API_ACCESS_TELEGRAM_URL,
  API_PAGE_ANCHORS,
  COMMERCIAL_API_KEY_USD_PER_MONTH,
  DONOR_KEY_CLAIMS_OPEN,
} from "@shared/lib/public-api-contract";
import { DONOR_KEY_QUALIFYING_STABLECOINS } from "@shared/lib/funding/donor-eligibility";
import { formatCoveragePct, isCommunityDonation, isUnpricedDonation } from "@shared/lib/funding/helpers";
import { resolveCompactLogoSrc } from "@/lib/logo-variants";
import { CostAllocation, CostMark, MonthlyFundingChart, formatUsdWhole } from "./funding-visuals";

const PHAROS_FUNDING_WALLET_DISPLAY = "0x5d698362EDb8AEa1C2b2483096BDeE3265D860DB";
const PHAROS_FUNDING_ENS = "pharos-watch.eth";
const GIVETH_URL = "https://giveth.io/project/pharos-watch:-transparent-stablecoins-analytics";
const GITHUB_URL = "https://github.com/TokenBrice/pharos-watch";
const DWELLIR_POST_HREF = "/blog/dwellir-in-kind-sponsorship/";
const TWITTER_URL = "https://x.com/PharosWatch";
const TELEGRAM_GROUP_URL = "https://t.me/pharoswatchers";
const SUPPORTED_CHAINS: FundingChain[] = ["ethereum", "base", "optimism", "arbitrum", "polygon", "gnosis"];
// Floor to the nearest 10 so the share message reads as a round figure and stays
// honestly conservative as canonical-order grows.
const TRACKED_COUNT_FLOOR = Math.floor(CLIENT_TRACKED_STABLECOINS.length / 10) * 10;
const SUPPORTER_KEY_HREF = `/api/#${API_PAGE_ANCHORS.supporterKey}`;
const PARTNER_ACCESS_HREF = `/api/#${API_PAGE_ANCHORS.partnerAccess}`;
const QUALIFYING_LABELS = DONOR_KEY_QUALIFYING_STABLECOINS.map((coin) => coin.label);
// Past this many coins the inline list crowds the note; link to the full list on /api/ instead.
const MAX_INLINE_QUALIFYING_COINS = 6;
const QUALIFYING_COINS_TEXT =
  QUALIFYING_LABELS.length > 1
    ? `${QUALIFYING_LABELS.slice(0, -1).join(", ")} or ${QUALIFYING_LABELS[QUALIFYING_LABELS.length - 1]}`
    : (QUALIFYING_LABELS[0] ?? "");
const PHAROS_SHARE_MESSAGE = `Stablecoin risk data should be public infrastructure, not a private terminal. Pharos tracks ${TRACKED_COUNT_FLOOR}+ stablecoins with peg, safety, liquidity, depeg, blacklist, flow, yield, and dependency signals. MIT-licensed, practitioner-built, free to use. Help keep it open: https://pharos.watch/funding/`;
const SHARE_URL = "https://x.com/intent/tweet?text=" + encodeURIComponent(PHAROS_SHARE_MESSAGE);

/** The funding rule, stated once in the hero and expanded in the FAQ. */
const INDEPENDENCE_STATEMENT =
  "Funding never buys a score. Pharos takes no money for listings, reviews, ratings or placement, from issuers or anyone else. Paid service work for an issuer or its DAO, if any, is public, listed on this page and kept apart from that coin's score.";

// Brand-marked icons matching the footer (lucide has no X/Telegram icons).
function XIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}
function TelegramIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.820 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
    </svg>
  );
}

/** Donor-wall receipts: provenance says whether the receipt was priced; zero is a value. */
function formatDonationUsd(value: number, priceNote: string): string {
  if (isUnpricedDonation(priceNote)) return "—";
  // A priced gift below one cent would round to "$0.00"; print the bound instead.
  if (value > 0 && value < 0.01) return "<$0.01";
  if (value < 1) return `$${formatDecimal(value, 2, 2)}`;
  return formatUsdWhole(value);
}

function formatMonthYear(timestampSec: number): string {
  return new Date(timestampSec * 1000).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

export interface FundingHeroProps {
  summary: DonationSummary;
  months: readonly MonthlyFunding[];
  monthlyCostUsd: number;
  /** Founder ledger transfers plus founder-paid one-time costs. */
  founderUsd: number;
  ledgerUpdatedAt: number;
}

/**
 * One Beam hero: today's monthly running cost, who covers it (community
 * coverage this month and last full month, lifetime community and founder
 * support) and the monthly history as the drawn visual.
 */
export function FundingHero({ summary, months, monthlyCostUsd, founderUsd, ledgerUpdatedAt }: FundingHeroProps) {
  const lastFullMonth = [...months].reverse().find((month) => !month.isCurrent) ?? null;
  const noCommunity = summary.lifetimeCommunityUsd === 0;
  return (
    <FeatureHeroSplit
      ariaLabel="Funding overview"
      mobileSubBeforeVisual
      beamLabel="Monthly running cost"
      beamValue={formatUsdWhole(monthlyCostUsd)}
      universe={
        <p className="max-w-xs text-sm leading-relaxed text-muted-foreground">
          What it takes to keep Pharos online, maintained and free to use, every month.
        </p>
      }
      subKicker="Who covers it"
      sub={
        <div className="space-y-4">
          <div className="divide-y divide-border/50">
            <HeroMetricRow
              label="Community, this month"
              value={noCommunity ? "Tracking begins" : formatCoveragePct(summary.currentMonthCommunityUsd, monthlyCostUsd)}
              detail={`ledger of ${formatEventDate(ledgerUpdatedAt)}`}
            />
            {lastFullMonth ? (
              <HeroMetricRow
                label={`Community, ${lastFullMonth.label}`}
                value={lastFullMonth.costUsd == null ? "—" : formatCoveragePct(lastFullMonth.communityUsd, lastFullMonth.costUsd)}
                detail="of that month's cost"
              />
            ) : null}
            <HeroMetricRow
              label="Community since launch"
              value={noCommunity ? "Be the first" : formatUsdWhole(summary.lifetimeCommunityUsd)}
              detail={noCommunity ? undefined : `${summary.lifetimeCommunityDonorCount} supporters`}
            />
            <HeroMetricRow label="TokenBrice since launch" value={formatUsdWhole(founderUsd)} detail="plus unpaid maintenance" />
            {summary.lifetimeRevenueUsd > 0 ? (
              <HeroMetricRow
                label="API revenue since launch"
                value={formatUsdWhole(summary.lifetimeRevenueUsd)}
                detail="paid partner-key revenue, counted separately from donations"
              />
            ) : null}
          </div>
          <Button asChild size="lg" className="w-full gap-2 sm:w-auto">
            <a href="#how-to-support">
              <Heart className="h-4 w-4" aria-hidden="true" />
              Support Pharos
            </a>
          </Button>
        </div>
      }
      footer={<p className="text-sm leading-relaxed text-muted-foreground">{INDEPENDENCE_STATEMENT}</p>}
    >
      <MonthlyFundingChart months={months} />
    </FeatureHeroSplit>
  );
}

function CostGroup({ title, totalUsd, children }: { title: string; totalUsd?: number; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-3 border-b border-border/50 pb-1.5">
        <h3 className="pharos-label">{title}</h3>
        {totalUsd == null ? null : (
          <span className="pharos-numeric text-xs text-muted-foreground">{formatUsdWhole(totalUsd)} / month</span>
        )}
      </div>
      {children}
    </section>
  );
}

function CostRow({ item, amount }: { item: Pick<CostLineItem, "label" | "note" | "mark" | "category">; amount: string }) {
  return (
    <li className="flex items-start gap-3">
      <CostMark item={item} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-sm font-medium text-foreground">{item.label}</span>
          <span className="pharos-numeric text-sm text-foreground">{amount}</span>
        </div>
        {item.note ? <p className="text-xs text-muted-foreground">{item.note}</p> : null}
      </div>
    </li>
  );
}

/** Services donated in kind: a disclosure, not revenue (docs/funding-page.md#data-model). */
function InKindSponsor({ item }: { item: CostLineItem }) {
  if (!item.sponsor) return null;
  const { sponsor } = item;
  return (
    <div className="space-y-2.5 pharos-inset p-3.5">
      <div className="flex items-center justify-between gap-3">
        <a href={sponsor.url} target="_blank" rel="noopener noreferrer" className="shrink-0 rounded-sm">
          <Image src={sponsor.logo} alt={item.label} width={114} height={24} unoptimized />
        </a>
        <span className="text-right text-xs text-muted-foreground">{item.note}</span>
      </div>
      <p className="text-sm leading-relaxed">{sponsor.blurb}</p>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {sponsor.announcement ? (
          <Link href={sponsor.announcement} className="underline underline-offset-2 hover:text-foreground">
            Read the announcement
          </Link>
        ) : null}
        <a
          href={sponsor.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-foreground"
        >
          {new URL(sponsor.url).hostname.replace(/^www\./, "")}
          <ExternalLink aria-hidden="true" className="h-3 w-3" />
        </a>
      </p>
    </div>
  );
}

export interface CostBreakdownProps {
  items: CostLineItem[];
  oneTime: CostsFile["one_time"];
  lastReviewedAt: number;
}

/**
 * Where the money goes: paid infrastructure as a share bar, the paid team,
 * lines that cost nothing (in-kind sponsors first) and one-time spend kept
 * outside the recurring total. The total itself is the hero's beam.
 */
export function CostBreakdown({ items, oneTime, lastReviewedAt }: CostBreakdownProps) {
  const paidInfra = items.filter((item) => item.category === "infra" && item.usd_per_month > 0);
  const paidTeam = items.filter((item) => item.category === "team" && item.usd_per_month > 0);
  const free = items.filter((item) => item.usd_per_month === 0);
  const sum = (lines: readonly CostLineItem[]) => lines.reduce((total, item) => total + item.usd_per_month, 0);
  const reviewed = new Date(lastReviewedAt * 1000);

  return (
    <Card variant="shell">
      <CardHeader
        kicker="Where it goes"
        heading="Monthly costs"
        freshness={
          <>
            Costs reviewed <time dateTime={reviewed.toISOString().slice(0, 7)}>{formatMonthYear(lastReviewedAt)}</time>
          </>
        }
      />
      <CardContent className="grid gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-8">
          {paidInfra.length > 0 ? (
            <CostGroup title="Infrastructure" totalUsd={sum(paidInfra)}>
              <CostAllocation items={paidInfra} ariaLabel="Share of the monthly infrastructure cost" />
            </CostGroup>
          ) : null}
          {paidTeam.length > 0 ? (
            <CostGroup title="Team" totalUsd={sum(paidTeam)}>
              <ul className="space-y-3">
                {paidTeam.map((item) => <CostRow key={item.label} item={item} amount={formatUsdWhole(item.usd_per_month)} />)}
              </ul>
            </CostGroup>
          ) : null}
        </div>
        <div className="space-y-8">
          {free.length > 0 ? (
            <CostGroup title="Covered at no cost">
              <div id="in-kind-supporters" className="space-y-3">
                {free.filter((item) => item.sponsor).map((item) => <InKindSponsor key={item.label} item={item} />)}
                <ul className="space-y-3">
                  {free.filter((item) => !item.sponsor).map((item) => <CostRow key={item.label} item={item} amount="$0" />)}
                </ul>
              </div>
            </CostGroup>
          ) : null}
          {oneTime.length > 0 ? (
            <CostGroup title="One-time, outside the monthly cost">
              <ul className="space-y-3">
                {oneTime.map((cost) => (
                  <CostRow
                    key={cost.label}
                    item={{ label: cost.label, note: "Paid by TokenBrice", category: "team" }}
                    amount={formatUsdWhole(cost.usd)}
                  />
                ))}
              </ul>
            </CostGroup>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

export interface DonorListProps {
  donations: Donation[];
  lastUpdatedAt: number;
  /** Rows shown before the "show all" fold. Default 10. */
  limit?: number;
}

function DonationTable({ rows, label }: { rows: readonly Donation[]; label: string }) {
  return (
    <TableFrame
      tableId={`funding-donations-${label.toLowerCase().replace(/\W+/g, "-")}`}
      chrome="bare"
      className="overflow-hidden rounded-lg border border-border/60"
      tableClassName="text-sm"
      tableProps={{ "aria-label": label }}
    >
      <TableHeader className="bg-muted/35">
        <TableRow rowIntent="static" className="hover:bg-transparent">
          <TableHead scope="col" className="h-9 px-3 text-xs font-medium">Supporter</TableHead>
          <TableHead scope="col" className="h-9 px-3 text-xs font-medium">Date</TableHead>
          <TableHead scope="col" className="h-9 px-3 text-xs font-medium">Sent</TableHead>
          <TableHead scope="col" className="h-9 px-3 text-right text-xs font-medium">Amount</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((d) => {
          const explorerUrl = buildExplorerUrl({ chainKey: d.chain, entityType: "tx", value: d.tx_hash });
          const displayText = d.display || formatAddress(d.from_address);
          const chain = CHAIN_META[d.chain];
          const amount = formatDonationUsd(d.usd_at_receipt, d.price_note);
          return (
            <TableRow key={fundingTransferId(d.chain, d.tx_hash, d.transfer_discriminator)} rowIntent="static" className="hover:bg-muted/20">
              <TableHead scope="row" className="h-auto max-w-56 truncate px-3 py-2 font-mono text-xs font-normal text-foreground">
                {displayText}
              </TableHead>
              <TableCell className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
                {formatEventDate(d.block_timestamp)}
              </TableCell>
              <TableCell className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  {chain?.logoPath ? (
                    <Image src={resolveCompactLogoSrc(chain.logoPath, 12)!} alt="" width={12} height={12} />
                  ) : null}
                  {d.asset_symbol} on {chain?.name ?? d.chain}
                </span>
              </TableCell>
              <TableCell className="whitespace-nowrap px-3 py-2 text-right">
                {explorerUrl ? (
                  <a
                    href={explorerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`${amount} from ${displayText}: view the transaction`}
                    className="pharos-numeric inline-flex items-center gap-1 text-foreground underline-offset-2 hover:underline"
                  >
                    {amount}
                    <ArrowUpRight aria-hidden="true" className="h-3 w-3 text-muted-foreground" />
                  </a>
                ) : (
                  <span className="pharos-numeric text-foreground">{amount}</span>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </TableFrame>
  );
}

export function DonorList({ donations, lastUpdatedAt, limit = 10 }: DonorListProps) {
  const community = donations.filter(isCommunityDonation).sort((a, b) => b.block_timestamp - a.block_timestamp);
  const visible = community.slice(0, limit);
  const earlier = community.slice(limit);

  return (
    <Card id="supporters" variant="shell">
      <CardHeader
        kicker="Where it comes from"
        heading="Supporters"
        freshness={lastUpdatedAt > 0 ? `Ledger updated ${formatEventDate(lastUpdatedAt)}, every Sunday` : undefined}
      />
      <CardContent className="space-y-3">
        {visible.length === 0 ? (
          <p className="text-sm text-muted-foreground">No community donations yet.</p>
        ) : (
          <>
            <DonationTable rows={visible} label="Most recent donations" />
            {earlier.length > 0 ? (
              <details className="space-y-3">
                <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
                  Show {earlier.length} earlier donations
                </summary>
                <div className="pt-3">
                  <DonationTable rows={earlier} label="Earlier donations" />
                </div>
              </details>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {community.length} donations in the public ledger, newest first.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function SupportCtas() {
  return (
    <section id="how-to-support" className="scroll-mt-20">
      <Card variant="shell">
        <CardHeader kicker="Get involved" heading="How to support" />
        <CardContent className="space-y-6">
          <div className="grid gap-3 lg:grid-cols-3">
            <PrimaryGivethTile />
            <WalletTile />
          </div>
          <SupporterKeyNote />
          <div className="grid gap-3 md:grid-cols-2">
            <FundingPathTile
              icon={Building2}
              title="Building a commercial product on Pharos data?"
              href={PARTNER_ACCESS_HREF}
              linkLabel="See partner keys"
            >
              Partner keys are free for services that are free to their users, and ${COMMERCIAL_API_KEY_USD_PER_MONTH} per
              month for commercial products.
            </FundingPathTile>
            <FundingPathTile
              icon={Server}
              title="Run infrastructure Pharos uses?"
              href={DWELLIR_POST_HREF}
              linkLabel="How Dwellir does it"
            >
              Data, RPC and hosting providers can sponsor a plan in kind. Sponsors are credited on this page and never
              influence a score; message{" "}
              <a href={API_ACCESS_TELEGRAM_URL} target="_blank" rel="noopener noreferrer" className="pharos-prose-link">
                @{API_ACCESS_TELEGRAM_HANDLE}
              </a>{" "}
              to talk.
            </FundingPathTile>
          </div>
          <div className="space-y-2">
            <p className="pharos-label text-muted-foreground">Other ways to help</p>
            <div className="flex flex-wrap gap-2">
              <SocialButton icon={Share2} label="Share Pharos" href={SHARE_URL} />
              <SocialButton icon={Star} label="Star on GitHub" href={GITHUB_URL} />
              <SocialButton icon={Wrench} label="Issues / PRs" href={`${GITHUB_URL}/issues`} />
              <SocialButton icon={XIcon} label="@PharosWatch" href={TWITTER_URL} />
              <SocialButton icon={TelegramIcon} label="@pharoswatchers" href={TELEGRAM_GROUP_URL} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Found bad data or a broken view? The feedback form on any stablecoin detail page goes straight to the
            maintainers.
          </p>
        </CardContent>
      </Card>
    </section>
  );
}

function FundingPathTile({
  icon: Icon,
  title,
  href,
  linkLabel,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  href: string;
  linkLabel: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 pharos-inset p-4">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 shrink-0 text-foreground" />
        <p className="text-sm font-semibold text-foreground">{title}</p>
      </div>
      <p className="text-sm leading-relaxed text-muted-foreground">{children}</p>
      <Link href={href} className="pharos-prose-link mt-auto text-sm text-foreground">
        {linkLabel}
      </Link>
    </div>
  );
}

function SupporterKeyNote() {
  return (
    <div className="flex flex-col gap-2 pharos-inset p-4 sm:flex-row sm:items-start sm:gap-3">
      <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-foreground" aria-hidden="true" />
      <div className="space-y-1">
        <p className="text-sm font-semibold text-foreground">Supporter API key</p>
        <p className="text-sm leading-relaxed text-muted-foreground">
          A direct transfer of ${DONOR_API_KEY_MIN_USD}+ in{" "}
          {QUALIFYING_LABELS.length > MAX_INLINE_QUALIFYING_COINS ? (
            <Link href={SUPPORTER_KEY_HREF} className="pharos-prose-link">
              one of {QUALIFYING_LABELS.length} reviewed stablecoins
            </Link>
          ) : (
            QUALIFYING_COINS_TEXT
          )}{" "}
          from a wallet you can sign with
          (not an exchange withdrawal or a Giveth stream) earns a personal, non-commercial key with{" "}
          {DONOR_API_KEY_RATE_LIMIT_PER_MINUTE} requests per minute, {DONOR_API_KEY_DAYS_PER_MIN_USD} days of access per $
          {DONOR_API_KEY_MIN_USD}:{" "}
          <Link href={SUPPORTER_KEY_HREF} className="pharos-prose-link">
            claim it on the API page
          </Link>
          . {DONOR_KEY_CLAIMS_OPEN
            ? "The donor list is updated every Sunday and grades are checked at claim time."
            : "Claims are paused. Eligibility will use Safety Score grades at claim time."}
        </p>
      </div>
    </div>
  );
}

function PrimaryGivethTile() {
  return (
    <div className="flex h-full flex-col gap-3 pharos-inset p-5 lg:col-span-2">
      <div className="flex items-center gap-2">
        <Heart className="h-4 w-4 text-foreground" />
        <p className="pharos-label text-muted-foreground">Recommended</p>
      </div>
      <p className="text-base font-semibold text-foreground">Recurring via Giveth</p>
      <p className="text-sm text-muted-foreground leading-relaxed">
        The strongest long-term signal: a recurring donation gives Pharos predictable runway while the website stays
        free for everyone. Streams run on Optimism or Base and appear on the supporter list as one &ldquo;via
        Giveth&rdquo; entry.
      </p>
      <p className="text-sm text-muted-foreground leading-relaxed">
        Giveth streams support Pharos but do not unlock the supporter API key.
      </p>
      <div className="mt-auto pt-2">
        <Button
          asChild
          className="min-h-10 w-full justify-between bg-foreground text-background hover:bg-foreground/90 sm:w-auto"
        >
          <a href={GIVETH_URL} target="_blank" rel="noopener noreferrer">
            Set up Giveth support
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </Button>
      </div>
    </div>
  );
}

function WalletTile() {
  return (
    <div className="flex h-full flex-col gap-2 pharos-inset p-4 lg:col-span-1">
      <div className="flex items-center gap-2">
        <Wallet className="h-4 w-4 text-foreground" />
        <p className="text-sm font-medium text-foreground">Direct wallet</p>
      </div>
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-base font-semibold text-foreground">{PHAROS_FUNDING_ENS}</p>
        <CopyButton text={PHAROS_FUNDING_ENS} />
      </div>
      <p className="text-xs text-muted-foreground">
        The same address on every supported chain; Base and Gnosis usually have the cheapest gas. ETH, stablecoins
        and other ERC-20s accepted.
      </p>
      <div className="mt-auto space-y-2 pt-2">
        <div className="flex items-center gap-2 rounded-md border border-border/60 bg-background px-3 py-1.5">
          <span className="flex-1 truncate font-mono text-xs">{formatAddress(PHAROS_FUNDING_WALLET_DISPLAY)}</span>
          <CopyButton text={PHAROS_FUNDING_WALLET_DISPLAY} />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {SUPPORTED_CHAINS.map((c) => {
            const meta = CHAIN_META[c];
            return (
              <span
                key={c}
                className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-3xs"
              >
                {meta?.logoPath ? <Image src={resolveCompactLogoSrc(meta.logoPath, 12)!} alt="" width={12} height={12} /> : null}
                {meta?.name ?? c}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function SocialButton({
  icon: Icon,
  label,
  href,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  href: string;
}) {
  return (
    <Button asChild variant="outline" size="sm">
      <a href={href} target="_blank" rel="noopener noreferrer">
        <Icon className="h-3.5 w-3.5" />
        {label}
        <ExternalLink className="h-3 w-3 opacity-60" />
      </a>
    </Button>
  );
}

export function FundingFaq() {
  const qa: Array<{ q: string; a: React.ReactNode }> = [
    {
      q: "Why does Pharos ask for support?",
      a: "Independent stablecoin analytics has real data, infrastructure, and research costs. Support keeps the website free for everyone instead of making risk analysis available only through private terminals.",
    },
    {
      q: "Does funding affect Safety Scores?",
      a: "No. Pharos takes no money for listings, reviews, ratings or placement, from issuers or anyone else. If Pharos does paid service work for an issuer or its DAO, it is public, listed on this page, and kept apart from that coin's score. The scoring code and methodology are open, so anyone can check.",
    },
    {
      q: "How will Pharos stay funded?",
      a: "From three sources: community donations, paid API access for commercial products, and infrastructure sponsored in kind. The website stays free for everyone, with no paywall.",
    },
    {
      q: "Is my donation tax-deductible?",
      a: "No. Pharos is not a registered charity. Giveth donations may qualify in some jurisdictions; check Giveth's documentation.",
    },
    {
      q: "What do supporters get?",
      a: (
        <>
          A place on the supporter list. A donation of ${DONOR_API_KEY_MIN_USD} or more in qualifying stablecoins from a
          wallet you can sign with also buys a personal, non-commercial supporter API key: {DONOR_API_KEY_DAYS_PER_MIN_USD}{" "}
          days of access per ${DONOR_API_KEY_MIN_USD}, extended by signing again after a later donation.{" "}
          <Link href={SUPPORTER_KEY_HREF} className="pharos-prose-link">
            See the API page
          </Link>
          . The donor list is updated every Sunday and grades are checked at claim time. Commercial products use a{" "}
          <Link href={PARTNER_ACCESS_HREF} className="pharos-prose-link">
            partner key
          </Link>
          .
        </>
      ),
    },
    {
      q: "Can I help without donating?",
      a: "Yes. Share Pharos, star the MIT-licensed repo, open issues for bad data, join Telegram, or contribute code and research.",
    },
    {
      q: "What does support make possible?",
      a: "More stablecoins covered, faster fixes when data breaks, clearer risk explanations, and a public reference that analysts, builders, and users can check before trusting a peg.",
    },
  ];
  return (
    <Card variant="shell">
      <CardHeader kicker="Questions" heading="FAQ" />
      <CardContent>
        <dl className="space-y-3">
          {qa.map(({ q, a }) => (
            <div key={q} className="space-y-1">
              <dt className="text-sm font-medium text-foreground">{q}</dt>
              <dd className="text-sm text-muted-foreground">{a}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}
