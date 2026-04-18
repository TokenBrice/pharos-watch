import Image from "next/image";
import { ExternalLink, Heart, Star, Wallet, Wrench } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/copy-button";
import { cn } from "@/lib/utils";
import { buildExplorerUrl } from "@shared/lib/explorer";
import { formatAddress } from "@shared/lib/format";
import { CHAIN_META } from "@shared/lib/chains";
import type { CostLineItem, Donation, FundingChain } from "@shared/lib/funding/types";
import type { DonationSummary } from "@shared/lib/funding/helpers";
import { groupCostsByCategory } from "@shared/lib/funding/helpers";

const PHAROS_FUNDING_WALLET_DISPLAY = "0x5d698362EDb8AEa1C2b2483096BDeE3265D860DB";
const PHAROS_FUNDING_ENS = "pharos-watch.eth";
const GIVETH_URL = "https://giveth.io/project/pharos-watch:-transparent-stablecoins-analytics";
const GITHUB_URL = "https://github.com/TokenBrice/stablecoin-dashboard";
const TWITTER_URL = "https://x.com/PharosWatch";
const TELEGRAM_GROUP_URL = "https://t.me/pharoswatchers";
const SUPPORTED_CHAINS: FundingChain[] = ["ethereum", "base", "optimism", "arbitrum", "polygon", "gnosis"];

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

// Local tone map — intentionally duplicated from /about (Card component
// + tone entries). Extraction into a shared primitive deferred until a
// third page wants the same pattern.
type Tone = "brand" | "data" | "insight" | "neutral";
function toneBorder(tone: Tone): string {
  switch (tone) {
    case "brand": return "border-l-frost-blue";
    case "data": return "border-l-amber-500";
    case "insight": return "border-l-emerald-500";
    default: return "border-l-zinc-500";
  }
}
function toneKicker(tone: Tone): string {
  switch (tone) {
    case "brand": return "text-sky-700 dark:text-frost-blue/82";
    case "data": return "text-amber-700 dark:text-amber-400";
    case "insight": return "text-emerald-700 dark:text-emerald-400";
    default: return "text-muted-foreground";
  }
}

/* ------------------------------------------------------------------ KPI row */

export interface FundingKpiRowProps {
  summary: DonationSummary;
  monthlyTargetUsd: number;
}

export function FundingKpiRow({ summary, monthlyTargetUsd }: FundingKpiRowProps) {
  const coveragePct = monthlyTargetUsd > 0
    ? Math.round((summary.currentMonthCommunityUsd / monthlyTargetUsd) * 100)
    : 0;

  const thisMonth = summary.lifetimeCommunityUsd === 0
    ? { primary: "Tracking begins", secondary: "first community donations will appear here" }
    : {
        primary: `${coveragePct}%`,
        secondary: `${USD_COMPACT.format(summary.currentMonthCommunityUsd)} of ${USD_COMPACT.format(monthlyTargetUsd)} covered`,
      };

  const community = summary.lifetimeCommunityDonorCount === 0
    ? { primary: "Be the first", secondary: "community support starts here" }
    : {
        primary: USD_COMPACT.format(summary.lifetimeCommunityUsd),
        secondary: `from ${summary.lifetimeCommunityDonorCount} supporters since launch`,
      };

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <KpiCard kicker="This month coverage" primary={thisMonth.primary} secondary={thisMonth.secondary} tone="brand" />
      <KpiCard kicker="Community support" primary={community.primary} secondary={community.secondary} tone="insight" />
    </div>
  );
}

function KpiCard({
  kicker,
  primary,
  secondary,
  tone,
}: {
  kicker: string;
  primary: string;
  secondary: string;
  tone: Tone;
}) {
  return (
    <Card className={cn("rounded-xl border-l-[3px]", toneBorder(tone))}>
      <CardContent className="space-y-1 p-4">
        <p className={cn("pharos-kicker", toneKicker(tone))}>{kicker}</p>
        <p className="text-2xl font-semibold tracking-tight text-foreground font-mono tabular-nums">{primary}</p>
        <p className="text-xs text-muted-foreground">{secondary}</p>
      </CardContent>
    </Card>
  );
}

/* ---------------------------------------------------------- Cost breakdown */

const CATEGORY_LABELS: Record<string, string> = { team: "Team", infra: "Infrastructure" };

export interface CostBreakdownProps {
  items: CostLineItem[];
  currentCommunityUsd: number;
  lastReviewedAt: number;
}

export function CostBreakdown({
  items,
  currentCommunityUsd,
  lastReviewedAt,
}: CostBreakdownProps) {
  const groups = groupCostsByCategory(items);
  const total = groups.reduce((s, g) => s + g.subtotal, 0);
  // Founder subsidy is derived from the gap between total monthly costs and
  // what the community has covered this month — Brice implicitly absorbs
  // whatever isn't covered. "Fully subsidized" when community contributions
  // are zero.
  const currentFounderUsd = Math.max(0, total - currentCommunityUsd);
  const reviewedDate = new Date(lastReviewedAt * 1000).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
  });

  return (
    <Card className={cn("rounded-xl border-l-[3px]", toneBorder("data"))}>
      <CardHeader className="space-y-1">
        <p className={cn("pharos-kicker", toneKicker("data"))}>Where it goes</p>
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
                  <span className="font-mono tabular-nums text-muted-foreground">
                    {USD_COMPACT.format(item.usd_per_month)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <div className="flex justify-between border-t border-border/60 pt-2 text-sm font-medium">
          <span>Total / month</span>
          <span className="font-mono tabular-nums">{USD_COMPACT.format(total)}</span>
        </div>
        <div className="space-y-0.5 text-xs text-muted-foreground">
          <p>
            This month: {USD_COMPACT.format(currentCommunityUsd)} community ·{" "}
            {USD_COMPACT.format(currentFounderUsd)} founder subsidy.
          </p>
          <p>Costs last reviewed: {reviewedDate}.</p>
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
  const community = donations
    .filter((d) => d.kind !== "founder")
    .sort((a, b) => b.block_timestamp - a.block_timestamp);
  const visible = community.slice(0, limit);
  const lastUpdatedLabel = lastUpdatedAt > 0
    ? new Date(lastUpdatedAt * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : null;

  return (
    <Card className={cn("rounded-xl border-l-[3px]", toneBorder("insight"))}>
      <CardHeader className="space-y-1">
        <p className={cn("pharos-kicker", toneKicker("insight"))}>Supporters</p>
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
                    {USD_COMPACT.format(d.usd_at_receipt)}{" "}
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
        {lastUpdatedLabel ? (
          <p className="text-xs text-muted-foreground">Last refresh: {lastUpdatedLabel}.</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------- Support CTAs */

export function SupportCtas() {
  return (
    <section id="how-to-support">
      <Card className={cn("rounded-xl border-l-[3px]", toneBorder("brand"))}>
        <CardHeader className="space-y-1">
          <p className={cn("pharos-kicker", toneKicker("brand"))}>Get involved</p>
          <CardTitle as="h2">How to support</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-2">
            <CtaCard
              icon={Wallet}
              title="Wallet"
              description={`${PHAROS_FUNDING_ENS} resolves to the same address on every supported chain. ETH, stablecoins, and other ERC-20s accepted.`}
              emphasized
              action={
                <div className="space-y-2">
                  <div className="flex items-center gap-2 rounded-md border border-border/60 bg-background px-3 py-1.5">
                    <span className="flex-1 truncate font-mono text-xs">
                      {formatAddress(PHAROS_FUNDING_WALLET_DISPLAY)}
                    </span>
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
              }
            />
            <CtaCard
              icon={Heart}
              title="Giveth"
              description="A public-goods funding platform. Donations route to the same wallet and appear on the wall as a single 'via Giveth' entry."
              emphasized
              action={
                <Button asChild variant="outline" className="min-h-9 w-full justify-between">
                  <a href={GIVETH_URL} target="_blank" rel="noopener noreferrer">
                    Giveth
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </Button>
              }
            />
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Easiest: wallet — same address on every chain. Cheapest gas: Base or Gnosis.
            Via Giveth: supports their public-goods pool; donations arrive at the wallet and appear on the wall as a
            single &ldquo;via Giveth&rdquo; entry.
          </p>
          <div className="space-y-2">
            <p className="pharos-kicker text-muted-foreground">Other ways to help</p>
            <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
              <CtaCard
                icon={Star}
                title="Star on GitHub"
                description="A star helps others find Pharos when they search GitHub."
                action={
                  <Button asChild variant="outline" className="min-h-9 w-full justify-between">
                    <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
                      GitHub
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  </Button>
                }
              />
              <CtaCard
                icon={Wrench}
                title="Contribute"
                description="MIT-licensed. Issues and PRs welcome."
                action={
                  <Button asChild variant="outline" className="min-h-9 w-full justify-between">
                    <a href={`${GITHUB_URL}/issues`} target="_blank" rel="noopener noreferrer">
                      Issues
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  </Button>
                }
              />
              <CtaCard
                icon={XIcon}
                title="Follow on X"
                description="Peg alerts, new coverage, and occasional hot takes from @PharosWatch."
                action={
                  <Button asChild variant="outline" className="min-h-9 w-full justify-between">
                    <a href={TWITTER_URL} target="_blank" rel="noopener noreferrer">
                      @PharosWatch
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  </Button>
                }
              />
              <CtaCard
                icon={TelegramIcon}
                title="Join Telegram group"
                description="Stablecoin-watcher chat. Ask questions, share signals, meet the community."
                action={
                  <Button asChild variant="outline" className="min-h-9 w-full justify-between">
                    <a href={TELEGRAM_GROUP_URL} target="_blank" rel="noopener noreferrer">
                      @pharoswatchers
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  </Button>
                }
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Found bad data or a broken view? The feedback form on any stablecoin detail page goes straight to
            the maintainers.
          </p>
        </CardContent>
      </Card>
    </section>
  );
}

function CtaCard({
  icon: Icon,
  title,
  description,
  action,
  emphasized,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  action: React.ReactNode;
  emphasized?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex h-full flex-col gap-2 rounded-xl border bg-background/40 p-4",
        emphasized ? "border-l-[3px] border-l-frost-blue border-border/60" : "border-border/60",
      )}
    >
      <div className="flex items-center gap-2">
        <Icon className={cn("h-4 w-4", emphasized ? "text-sky-700 dark:text-frost-blue/82" : "text-foreground")} />
        <p className="text-sm font-medium text-foreground">{title}</p>
      </div>
      <p className="text-xs text-muted-foreground">{description}</p>
      <div className="mt-auto pt-2">{action}</div>
    </div>
  );
}

/* ----------------------------------------------------------- Year-end + FAQ */

export function YearEndHorizon() {
  const shareUrl =
    "https://x.com/intent/tweet?text=" +
    encodeURIComponent("Pharos — independent stablecoin analytics, MIT-licensed. https://pharos.watch");
  return (
    <Card className={cn("rounded-xl border-l-[3px]", toneBorder("brand"))}>
      <CardHeader className="space-y-1">
        <p className={cn("pharos-kicker", toneKicker("brand"))}>Where we&apos;re going</p>
        <CardTitle as="h2">Path to sustainability</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm leading-relaxed text-muted-foreground">
        <p>
          Pharos aims to fund itself by the end of 2026 without subsidy from Brice. Until then, he covers the gap
          directly. We review trajectory each quarter — if it is clearly behind, this paragraph will say so rather than
          leave the commitment stale.
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
          helps others find it.
        </p>
      </CardContent>
    </Card>
  );
}

export function FundingFaq() {
  const qa: Array<{ q: string; a: string }> = [
    {
      q: "Is my donation tax-deductible?",
      a: "No — Pharos is not a registered charity. Giveth donations may qualify in some jurisdictions; check Giveth's documentation.",
    },
    {
      q: "What do supporters get?",
      a: "Public recognition on the wall unless you ask for a custom label. All Pharos features stay free for everyone — there is no paid tier.",
    },
    {
      q: "What happens to donations if Pharos stops operating?",
      a: "The MIT-licensed code and the on-chain ledger remain available. Donations are non-refundable.",
    },
  ];
  return (
    <Card className="rounded-xl border-l-[3px] border-l-zinc-500">
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
