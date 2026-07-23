import Image from "next/image";
import { ExternalLink, Heart, Star, Wallet, Wrench } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/copy-button";
import { TableBody, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/table";
import { buildExplorerUrl } from "@shared/lib/explorer";
import { formatAddress, formatEventDate } from "@shared/lib/format";
import { clampScore } from "@shared/lib/math";
import { CHAIN_META } from "@shared/lib/chains";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { CostLineItem, Donation, FundingChain } from "@shared/lib/funding/types";
import type { DonationSummary, MonthlyCommunityCoverage } from "@shared/lib/funding/helpers";
import { formatCoveragePct, groupCostsByCategory } from "@shared/lib/funding/helpers";

const PHAROS_FUNDING_WALLET_DISPLAY = "0x5d698362EDb8AEa1C2b2483096BDeE3265D860DB";
const PHAROS_FUNDING_ENS = "pharos-watch.eth";
const GIVETH_URL = "https://giveth.io/project/pharos-watch:-transparent-stablecoins-analytics";
const GITHUB_URL = "https://github.com/TokenBrice/pharos-watch";
const TWITTER_URL = "https://x.com/PharosWatch";
const TELEGRAM_GROUP_URL = "https://t.me/pharoswatchers";
const SUPPORTED_CHAINS: FundingChain[] = ["ethereum", "base", "optimism", "arbitrum", "polygon", "gnosis"];
// Floor to the nearest 10 so the share message reads as a round figure and stays
// honestly conservative as canonical-order grows.
const TRACKED_COUNT_FLOOR = Math.floor(TRACKED_STABLECOINS.length / 10) * 10;
const PHAROS_SHARE_MESSAGE = `Stablecoin risk data should be public infrastructure, not a private terminal. Pharos tracks ${TRACKED_COUNT_FLOOR}+ stablecoins with peg, safety, liquidity, depeg, blacklist, flow, yield, and dependency signals. MIT-licensed, practitioner-built, free to use. Help keep it open: https://pharos.watch/funding/`;

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

const USD_COMPACT = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

/* ------------------------------------------------------------------ KPI row */

interface KpiLabel {
  primary: string;
  secondary: string;
}

function buildThisMonthLabel(
  summary: DonationSummary,
  coveragePctLabel: string,
  monthlyTargetUsd: number,
): KpiLabel {
  if (summary.lifetimeCommunityUsd === 0) {
    return { primary: "Tracking begins", secondary: "first community donations will appear here" };
  }
  return {
    primary: coveragePctLabel,
    secondary: `${USD_COMPACT.format(summary.currentMonthCommunityUsd)} of ${USD_COMPACT.format(monthlyTargetUsd)} covered`,
  };
}

function buildCommunityLabel(summary: DonationSummary): KpiLabel {
  if (summary.lifetimeCommunityDonorCount === 0) {
    return { primary: "Be the first", secondary: "community support starts here" };
  }
  return {
    primary: USD_COMPACT.format(summary.lifetimeCommunityUsd),
    secondary: `from ${summary.lifetimeCommunityDonorCount} supporters since launch`,
  };
}

export interface FundingKpiRowProps {
  summary: DonationSummary;
  monthlyTargetUsd: number;
  monthlyHistory?: MonthlyCommunityCoverage[];
}

export function FundingKpiRow({ summary, monthlyTargetUsd, monthlyHistory = [] }: FundingKpiRowProps) {
  const rawCoveragePct = monthlyTargetUsd > 0 ? (summary.currentMonthCommunityUsd / monthlyTargetUsd) * 100 : 0;
  const progressPct = clampScore(rawCoveragePct);
  const ariaCoveragePct = Math.round(progressPct);
  const coveragePctLabel = formatCoveragePct(summary.currentMonthCommunityUsd, monthlyTargetUsd);
  const ariaCoverageText =
    summary.lifetimeCommunityUsd === 0
      ? "Tracking begins; no community donations recorded yet"
      : `${coveragePctLabel} covered this month`;
  const remainingUsd = Math.max(0, monthlyTargetUsd - summary.currentMonthCommunityUsd);

  const thisMonth = buildThisMonthLabel(summary, coveragePctLabel, monthlyTargetUsd);
  const community = buildCommunityLabel(summary);

  return (
    <Card className="pharos-card-shell">
      <CardContent className="space-y-5 p-4 sm:p-5">
        <div className="space-y-1.5 border-b border-border/50 pb-5">
          <p className="pharos-kicker text-muted-foreground">Monthly running cost</p>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <p className="pharos-numeric text-[2.1rem] font-semibold leading-none tracking-tight text-frost-blue sm:text-[2.45rem]">
              {USD_COMPACT.format(monthlyTargetUsd)}
            </p>
            <p className="text-sm text-muted-foreground">
              What it takes to keep Pharos online, maintained, and free to use every month.
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 space-y-1.5">
            <p className="pharos-kicker text-muted-foreground">This month coverage</p>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <p className="pharos-numeric text-3xl font-semibold tracking-tight text-foreground">
                {thisMonth.primary}
              </p>
              <p className="text-sm text-muted-foreground">{thisMonth.secondary}</p>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:min-w-[28rem]">
            <FundingMiniStat
              label="Community support"
              value={community.primary}
              detail={community.secondary}
            />
            <FundingMiniStat
              label="Best long-term help"
              value="Recurring Giveth"
              detail="predictable support for the public site"
            />
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{USD_COMPACT.format(summary.currentMonthCommunityUsd)} covered</span>
            <span>Monthly goal: {USD_COMPACT.format(monthlyTargetUsd)}</span>
          </div>
          <div
            className="relative h-2 w-full overflow-hidden rounded-full bg-muted/40"
            role="progressbar"
            aria-valuenow={ariaCoveragePct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Monthly funding coverage"
            aria-valuetext={ariaCoverageText}
          >
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-frost-blue/75"
              style={{ width: `${progressPct}%` }}
            />
            {progressPct > 2 && progressPct < 98 ? (
              <div
                className="absolute top-1/2 h-3 w-0.5 -translate-y-1/2 rounded-full bg-foreground"
                style={{ left: `${progressPct}%` }}
                title="Covered so far"
              />
            ) : null}
          </div>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Supporter-funded this month</span>
            <span>{remainingUsd > 0 ? `${USD_COMPACT.format(remainingUsd)} still open` : "Monthly costs covered"}</span>
          </div>
        </div>

        {monthlyHistory.length > 0 ? (
          <div className="space-y-2.5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <p className="text-sm font-medium text-foreground">Previous months</p>
              <p className="text-xs text-muted-foreground">
                Coverage against the {USD_COMPACT.format(monthlyTargetUsd)} monthly goal
              </p>
            </div>
            <TableFrame
              tableId="funding-previous-months"
              chrome="bare"
              className="overflow-hidden rounded-lg border border-border/60"
              tableClassName="table-fixed text-sm"
              tableProps={{ "aria-label": "Previous monthly funding coverage" }}
              viewportProps={{
                mobileScrollHint: false,
                scrollShadow: false,
                horizontal: false,
                overscrollX: false,
                compactBottomPadding: false,
              }}
            >
              <TableHeader className="bg-muted/35">
                <TableRow rowIntent="static" className="hover:bg-transparent">
                  <TableHead scope="col" className="h-9 w-[38%] px-3 text-xs font-medium">
                    Month
                  </TableHead>
                  <TableHead scope="col" className="h-9 w-[31%] px-3 text-right text-xs font-medium">
                    Community
                  </TableHead>
                  <TableHead scope="col" className="h-9 w-[31%] px-3 text-right text-xs font-medium">
                    Coverage
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {monthlyHistory.map((m) => {
                  const coveragePct = monthlyTargetUsd > 0
                    ? (m.communityUsd / monthlyTargetUsd) * 100
                    : 0;
                  return (
                    <TableRow key={m.monthKey} rowIntent="static" className="hover:bg-muted/20">
                      <TableHead scope="row" className="h-auto px-3 py-2.5 font-medium text-foreground">
                        {m.label}
                      </TableHead>
                      <TableCell className="px-3 py-2.5 text-right">
                        <span className="pharos-numeric text-foreground">
                          {USD_COMPACT.format(m.communityUsd)}
                        </span>
                      </TableCell>
                      <TableCell className="px-3 py-2.5">
                        <div className="flex items-center justify-end gap-3">
                          <div className="hidden h-1.5 w-20 overflow-hidden rounded-full bg-muted sm:block">
                            <div
                              className="h-full rounded-full bg-foreground/55"
                              style={{ width: `${clampScore(coveragePct)}%` }}
                            />
                          </div>
                          <span className="pharos-numeric min-w-10 text-right font-semibold text-foreground">
                            {formatCoveragePct(m.communityUsd, monthlyTargetUsd)}
                          </span>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </TableFrame>
          </div>
        ) : null}

        <p className="text-sm leading-relaxed text-muted-foreground">
          Donations keep Pharos freely accessible to all, so stablecoin users, analysts, and builders can check
          high-quality analytics and risk analysis without a private terminal or paywall.
        </p>
      </CardContent>
    </Card>
  );
}

function FundingMiniStat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/40 px-3 py-2.5">
      <p className="pharos-kicker text-muted-foreground">{label}</p>
      <p className="pharos-numeric text-lg font-semibold tracking-tight text-foreground">{value}</p>
      <p className="text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

/* ---------------------------------------------------------- Cost breakdown */

const CATEGORY_LABELS: Record<string, string> = { team: "Team", infra: "Infrastructure" };

export interface CostBreakdownProps {
  items: CostLineItem[];
  currentCommunityUsd: number;
  lastReviewedAt: number;
}

export function CostBreakdown({ items, currentCommunityUsd, lastReviewedAt }: CostBreakdownProps) {
  const groups = groupCostsByCategory(items);
  const total = groups.reduce((s, g) => s + g.subtotal, 0);
  const currentFundingGapUsd = Math.max(0, total - currentCommunityUsd);
  const reviewedDateObject = new Date(lastReviewedAt * 1000);
  const reviewedDateTime = reviewedDateObject.toISOString().slice(0, 7);
  const reviewedDate = reviewedDateObject.toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

  return (
    <Card className="pharos-card-shell">
      <CardHeader className="space-y-1">
        <p className="pharos-kicker text-muted-foreground">Where it goes</p>
        <CardTitle as="h2">Monthly costs</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {groups.map((group) => (
          <div key={group.category} className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {CATEGORY_LABELS[group.category] ?? group.category}
            </p>
            <ul className="space-y-0.5 text-sm">
              {group.items.map((item) => (
                <li key={item.label} className="flex justify-between gap-4">
                  <span className="flex-1 truncate">
                    {item.label}
                    {item.note ? <span className="ml-2 text-xs text-muted-foreground">— {item.note}</span> : null}
                  </span>
                  <span className="pharos-numeric text-muted-foreground">
                    {USD_COMPACT.format(item.usd_per_month)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <div className="flex justify-between border-t border-border/60 pt-2 text-sm font-medium">
          <span>Total / month</span>
          <span className="pharos-numeric">{USD_COMPACT.format(total)}</span>
        </div>
        <p className="rounded-lg border border-border/60 bg-muted/25 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
          TokenBrice also sponsored $5,800 in one-time design expenses for the full website redesign and logo.
          These exceptional expenses are not included in the monthly total above.
        </p>
        <div className="space-y-0.5 text-xs text-muted-foreground">
          <p>
            This month: {USD_COMPACT.format(currentCommunityUsd)} community ·{" "}
            {currentFundingGapUsd > 0 ? `${USD_COMPACT.format(currentFundingGapUsd)} still open.` : "costs covered."}
          </p>
          <p>
            Costs last reviewed: <time dateTime={reviewedDateTime}>{reviewedDate}</time>.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

/* --------------------------------------------------------------- Donor list */

export interface DonorListProps {
  donations: Donation[];
  lastUpdatedAt: number;
  /** Cap how many rows render. Default 20. */
  limit?: number;
}

export function DonorList({ donations, lastUpdatedAt, limit = 20 }: DonorListProps) {
  const community = donations.filter((d) => d.kind !== "founder").sort((a, b) => b.block_timestamp - a.block_timestamp);
  const visible = community.slice(0, limit);
  const lastUpdatedLabel =
    lastUpdatedAt > 0
      ? formatEventDate(lastUpdatedAt)
      : null;

  return (
    <Card className="pharos-card-shell">
      <CardHeader className="space-y-1">
        <p className="pharos-kicker text-muted-foreground">Supporters</p>
        <CardTitle as="h2">Recent supporters</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {visible.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No community donations yet. {lastUpdatedLabel ? `Last checked ${lastUpdatedLabel}.` : ""}
          </p>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {visible.map((d) => {
              const explorerUrl = buildExplorerUrl({ chainKey: d.chain, entityType: "tx", value: d.tx_hash });
              const displayText = d.display || formatAddress(d.from_address);
              return (
                <li key={`${d.chain}-${d.tx_hash}`} className="flex items-baseline justify-between gap-3">
                  <span className="flex-1 truncate font-mono text-xs">{displayText}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    <span className="pharos-numeric">{USD_COMPACT.format(d.usd_at_receipt)}</span>{" "}
                    {explorerUrl ? (
                      <a
                        href={explorerUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline underline-offset-2 hover:text-foreground"
                      >
                        ↗
                      </a>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {community.length > limit ? (
          <p className="text-xs text-muted-foreground">
            Showing most recent {limit} of {community.length} supporters.
          </p>
        ) : null}
        {lastUpdatedLabel ? <p className="text-xs text-muted-foreground">Last refresh: {lastUpdatedLabel}.</p> : null}
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------- Support CTAs */

export function SupportCtas() {
  return (
    <section id="how-to-support">
      <Card className="pharos-card-shell">
        <CardHeader className="space-y-1">
          <p className="pharos-kicker text-muted-foreground">Get involved</p>
          <CardTitle as="h2">How to support</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-3 lg:grid-cols-3">
            <PrimaryGivethTile />
            <WalletTile />
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Best for long-term sustainability: a recurring Giveth stream on Optimism or Base. Direct wallet support
            works on every supported chain; Base and Gnosis are usually the cheapest gas paths. Giveth donations
            arrive at the wallet and appear on the wall as a single &ldquo;via Giveth&rdquo; entry.
          </p>
          <div className="space-y-2">
            <p className="pharos-kicker text-muted-foreground">Other ways to help</p>
            <div className="flex flex-wrap gap-2">
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

function PrimaryGivethTile() {
  return (
    <div className="flex h-full flex-col gap-3 rounded-lg border border-border/60 bg-background/40 p-5 lg:col-span-2">
      <div className="flex items-center gap-2">
        <Heart className="h-4 w-4 text-foreground" />
        <p className="pharos-kicker text-muted-foreground">Recommended</p>
      </div>
      <p className="text-base font-semibold text-foreground">Recurring via Giveth</p>
      <p className="text-sm text-muted-foreground leading-relaxed">
        The strongest long-term signal: set a recurring donation so Pharos has predictable runway while the website
        stays free for everyone. Recurring streams run on Optimism or Base only.
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
    <div className="flex h-full flex-col gap-2 rounded-lg border border-border/60 bg-background/40 p-4 lg:col-span-1">
      <div className="flex items-center gap-2">
        <Wallet className="h-4 w-4 text-foreground" />
        <p className="text-sm font-medium text-foreground">Direct wallet</p>
      </div>
      <p className="text-xs text-muted-foreground">
        {PHAROS_FUNDING_ENS} resolves to the same address on every supported chain. ETH, stablecoins, and other
        ERC-20s accepted.
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
                className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[10px]"
              >
                {meta?.logoPath ? <Image src={meta.logoPath} alt="" width={12} height={12} /> : null}
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

/* ----------------------------------------------------------- Year-end + FAQ */

export function YearEndHorizon() {
  const shareUrl = "https://x.com/intent/tweet?text=" + encodeURIComponent(PHAROS_SHARE_MESSAGE);
  return (
    <Card className="pharos-card-shell">
      <CardHeader className="space-y-1">
        <p className="pharos-kicker text-muted-foreground">Where we&apos;re going</p>
        <CardTitle as="h2">Path to sustainability</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm leading-relaxed text-muted-foreground">
        <p>
          The dashboard stays free for everyone, forever. Sustainability comes from two streams: community donations
          today, and &mdash; once mature &mdash; paid API access for institutional users with heavy programmatic needs.
          Target: self-sustaining by Q4 2026, public dashboard untouched.
        </p>
        <p className="text-xs">
          If you can&apos;t support financially,{" "}
          <a
            href={shareUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-foreground"
          >
            sharing Pharos
          </a>{" "}
          helps stablecoin users find open risk data before they need it.
        </p>
      </CardContent>
    </Card>
  );
}

export function FundingFaq() {
  const qa: Array<{ q: string; a: string }> = [
    {
      q: "Why does Pharos ask for support?",
      a: "Independent stablecoin analytics has real data, infrastructure, and research costs. Support keeps the website free for everyone instead of making risk analysis available only through private terminals.",
    },
    {
      q: "Why recurring Giveth donations?",
      a: "Recurring support is the clearest long-term signal. It smooths one-off donation spikes and lets Pharos plan coverage, alerting, and data-review work without guessing month to month.",
    },
    {
      q: "Is my donation tax-deductible?",
      a: "No. Pharos is not a registered charity. Giveth donations may qualify in some jurisdictions; check Giveth's documentation.",
    },
    {
      q: "What do supporters get?",
      a: "Public recognition on the wall unless you ask for a custom label. The public website stays fully free; any future paid surface would be for high-frequency or heavy API usage, not the core dashboards.",
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
    <Card className="pharos-card-shell">
      <CardHeader className="space-y-1">
        <p className="pharos-kicker text-muted-foreground">Questions</p>
        <CardTitle as="h2">FAQ</CardTitle>
      </CardHeader>
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
