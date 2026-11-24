"use client";

import type { ReactNode } from "react";
import { IntentLink } from "@/components/intent-link";
import { AlertTriangle, Archive, BadgeCheck, CircleDashed, Info, Rocket, ShieldAlert, type LucideIcon } from "lucide-react";
import { CoinStateChip } from "@/components/coin-state-chip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import type { DetailQuote } from "@/lib/stablecoin-detail-view-model-types";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { isTokenizedFundListingClass } from "@shared/lib/stablecoins/listing-class";
import { formatShortDate } from "@shared/lib/format";
import type { CoinState } from "@shared/lib/coin-state";
import type { StablecoinVerdict, StablecoinVerdictArchetype } from "@shared/lib/stablecoin-verdict";
import type { HeroCardViewModel } from "@/lib/stablecoin-detail-view-model";
import { buildPegLandingUrl } from "@/lib/peg-landing";
import { buildBackingTaxonomyUrl, buildGovernanceTaxonomyUrl } from "@/lib/stablecoin-taxonomy-urls";
import { isHeroVerdictEnabled } from "@/lib/feature-flags";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import { cn } from "@/lib/utils";
import {
  HERO_CHIP_BACKING_LABELS,
  HERO_CHIP_GOVERNANCE_LABELS,
  HERO_CHIP_PEG_LABELS,
  TOKENIZED_FUND_BADGE,
  VERDICT_TONES,
  getHeroPegLabel,
} from "@shared/lib/classification";
import { InfrastructureBadge } from "./hero-card-identity";
import { HeroMarketMetricGrid, HeroTertiaryMetrics } from "./hero-card-metrics";
import type { HeroTertiaryMetricConfig } from "./hero-card-metrics";
export type { HeroTertiaryMetricConfig } from "./hero-card-metrics";

function formatChipLaunchDate(value: string | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return formatShortDate(date, { utc: true });
}

function HeroCompactChip({ href, children }: { href?: string | null; children: ReactNode }) {
  const className =
    "pharos-focus-ring inline-flex h-5 items-center rounded-full bg-muted/70 px-2.5 text-xs font-medium leading-none text-foreground/80 transition-colors hover:bg-muted";
  if (!href) return <span className={className}>{children}</span>;
  return (
    <IntentLink href={href} className={className}>
      {children}
    </IntentLink>
  );
}

// The institutional-default archetype stays internal: as a reader chip it said nothing.
export function isHeroVerdictShown(verdict: StablecoinVerdict): boolean {
  return isHeroVerdictEnabled() && verdict.archetype !== "uncategorized" && verdict.archetype !== "institutional-default";
}

/** One icon per verdict archetype; the "verified" check is for identity labels only. */
const VERDICT_ICONS: Record<StablecoinVerdictArchetype, LucideIcon> = {
  "pre-launch": Rocket,
  "quarantined-record": Archive,
  "delisted-record": Archive,
  "frozen-archive": Archive,
  distressed: AlertTriangle,
  "low-safety-score": ShieldAlert,
  "yield-bearing-hybrid": BadgeCheck,
  "decentralized-benchmark": BadgeCheck,
  "institutional-default": BadgeCheck,
  uncategorized: CircleDashed,
};

function TokenizedFundHeroBadge() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-tokenized-fund-badge
          title={TOKENIZED_FUND_BADGE.notice}
          className={cn(
            "pharos-focus-ring inline-flex h-5 items-center gap-1 rounded-full border px-2.5 text-xs font-semibold leading-none transition-colors hover:brightness-105",
            TOKENIZED_FUND_BADGE.cls,
          )}
        >
          <Info aria-hidden="true" className="h-3 w-3 shrink-0" />
          <span>{TOKENIZED_FUND_BADGE.label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 space-y-2 p-3 text-xs leading-relaxed">
        <p className="font-semibold text-foreground">{TOKENIZED_FUND_BADGE.label}</p>
        <p className="text-muted-foreground">{TOKENIZED_FUND_BADGE.notice}</p>
        <p>
          <IntentLink
            href="/docs/listing-policy/"
            className="pharos-focus-ring rounded-sm font-medium text-brand-accent-text underline-offset-2 hover:underline"
          >
            Read the listing policy
          </IntentLink>
        </p>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The hero's lead chip: the coin's highest exceptional state when one exists
 * (the shared `CoinStateChip`), else its verdict in the verdict's own tone.
 */
export function HeroChipRail({ coin, verdict, state = null }: { coin: StablecoinMeta; verdict: StablecoinVerdict; state?: CoinState | null }) {
  const showVerdict = isHeroVerdictShown(verdict);
  const VerdictIcon = VERDICT_ICONS[verdict.archetype];
  const isTokenizedFund = isTokenizedFundListingClass(CLIENT_TRACKED_META_BY_ID.get(coin.id)?.listingClass);
  const launchDate = formatChipLaunchDate(coin.launchDate);
  const pegLabel = coin.flags.navToken
    ? getHeroPegLabel(
        coin.flags,
        coin.pegReferenceId ? CLIENT_TRACKED_META_BY_ID.get(coin.pegReferenceId)?.symbol : undefined,
      )
    : HERO_CHIP_PEG_LABELS[coin.flags.pegCurrency];
  const backingLabel = HERO_CHIP_BACKING_LABELS[coin.flags.backing];
  const governanceLabel = HERO_CHIP_GOVERNANCE_LABELS[coin.flags.governance];

  return (
    <div className="border-b border-border/40 px-4 py-2 sm:px-5">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {/* The state, else the verdict, leads the chip row instead of taking a line of its own. */}
        {state ? (
          <span id={`hero-verdict-${coin.id}`} data-hero-verdict-lane className="inline-flex max-w-full">
            <CoinStateChip state={state} className="h-5 px-2.5 py-0 text-xs" />
          </span>
        ) : showVerdict ? (
          <span
            id={`hero-verdict-${coin.id}`}
            data-archetype={verdict.archetype}
            data-hero-verdict-lane
            className={cn(
              "inline-flex h-5 items-center gap-1 rounded-full border px-2.5 text-xs font-medium leading-none",
              SEVERITY_TONE_CLASS[VERDICT_TONES[verdict.archetype]].pill,
            )}
          >
            <VerdictIcon aria-hidden="true" className="h-3 w-3 shrink-0" />
            {verdict.label}
          </span>
        ) : null}
        {isTokenizedFund ? <TokenizedFundHeroBadge /> : null}
        <HeroCompactChip href={buildPegLandingUrl(coin.flags.pegCurrency)}>{pegLabel}</HeroCompactChip>
        <HeroCompactChip href={buildBackingTaxonomyUrl(coin.flags.backing)}>{backingLabel}</HeroCompactChip>
        <HeroCompactChip href={buildGovernanceTaxonomyUrl(coin.flags.governance)}>{governanceLabel}</HeroCompactChip>
        {(coin.infrastructures ?? []).map((value) => (
          <InfrastructureBadge key={value} value={value} />
        ))}
        {/* The last chip of the row: inline wherever the row has room,
            pushed to the far end from sm. */}
        {launchDate ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground sm:ml-auto">
            <Rocket aria-hidden="true" className="h-3.5 w-3.5" />
            {launchDate}
          </span>
        ) : null}
      </div>
      {isTokenizedFund ? (
        <p data-tokenized-fund-notice className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          {TOKENIZED_FUND_BADGE.notice}
        </p>
      ) : null}
    </div>
  );
}

export interface HeroSectionBaseProps {
  coin: StablecoinMeta;
  coinData: DetailQuote;
  price: HeroCardViewModel["price"];
  market: HeroCardViewModel["market"];
  peg: HeroCardViewModel["peg"];
}

// The identity, actions and mobile grade live in `HeroIdentityHeader` above
// the card at every width; the card opens with the shared chip rail, then the
// metrics in their mobile (stacked cards + signal chips) or desktop (cell grid)
// form.
export function HeroCardMobileSection({
  coin,
  coinData,
  price,
  market,
  tertiaryMetrics,
}: HeroSectionBaseProps & {
  tertiaryMetrics: HeroTertiaryMetricConfig[];
}) {
  return (
    <div className="px-3 py-3 sm:px-5 sm:py-4 lg:hidden">
      <HeroMarketMetricGrid
        variant="card"
        coin={coin}
        coinData={coinData}
        price={price}
        market={market}
        tertiaryCount={tertiaryMetrics.length}
      />

      <HeroTertiaryMetrics metrics={tertiaryMetrics} />
    </div>
  );
}

export function HeroCardDesktopSection({
  coin,
  coinData,
  price,
  market,
  fourthMetric,
}: HeroSectionBaseProps & {
  /** The coin-specific fourth figure (see `resolveFourthMetric`); null leaves three cells. */
  fourthMetric: HeroTertiaryMetricConfig | null;
}) {

  return (
    <div className="hidden lg:block">
      <HeroMarketMetricGrid
        variant="cell"
        coin={coin}
        coinData={coinData}
        price={price}
        market={market}
        tertiaryMetric={fourthMetric ?? undefined}
      />
    </div>
  );
}
