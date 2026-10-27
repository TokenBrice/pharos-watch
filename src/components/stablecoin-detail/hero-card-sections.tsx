"use client";

import type { ReactNode } from "react";
import { IntentLink } from "@/components/intent-link";
import { BadgeCheck, Rocket } from "lucide-react";
import type { StablecoinMeta } from "@shared/types";
import type { DetailQuote } from "@/lib/stablecoin-detail-view-model-types";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import type { StablecoinVerdict } from "@shared/lib/stablecoin-verdict";
import type { HeroCardViewModel } from "@/lib/stablecoin-detail-view-model";
import { buildPegLandingUrl } from "@/lib/peg-landing";
import { buildBackingTaxonomyUrl, buildGovernanceTaxonomyUrl } from "@/lib/stablecoin-taxonomy-urls";
import { isHeroVerdictEnabled } from "@/lib/feature-flags";
import {
  HERO_CHIP_BACKING_LABELS,
  HERO_CHIP_GOVERNANCE_LABELS,
  HERO_CHIP_PEG_LABELS,
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
  return date.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
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

export function HeroChipRail({ coin, verdict }: { coin: StablecoinMeta; verdict: StablecoinVerdict }) {
  const showVerdict = isHeroVerdictShown(verdict);
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
    <div className="flex flex-col gap-2 border-b border-border/40 px-4 py-2 sm:px-5">
      {showVerdict ? (
        <div className="flex min-h-5 items-center" data-hero-verdict-lane>
          <span
            id={`hero-verdict-${coin.id}`}
            data-archetype={verdict.archetype}
            className="inline-flex min-h-5 items-center gap-1 rounded-full bg-state-info-solid/15 px-2.5 text-xs font-medium leading-snug text-state-info-bright"
          >
            <BadgeCheck aria-hidden="true" className="h-3 w-3 shrink-0" />
            {verdict.label}
          </span>
        </div>
      ) : null}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <HeroCompactChip href={buildPegLandingUrl(coin.flags.pegCurrency)}>{pegLabel}</HeroCompactChip>
          <HeroCompactChip href={buildBackingTaxonomyUrl(coin.flags.backing)}>{backingLabel}</HeroCompactChip>
          <HeroCompactChip href={buildGovernanceTaxonomyUrl(coin.flags.governance)}>{governanceLabel}</HeroCompactChip>
          {(coin.infrastructures ?? []).map((value) => (
            <InfrastructureBadge key={value} value={value} />
          ))}
        </div>
        {launchDate ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Rocket aria-hidden="true" className="h-3.5 w-3.5" />
            {launchDate}
          </span>
        ) : null}
      </div>
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
  peg,
  tertiaryMetrics,
}: HeroSectionBaseProps & {
  tertiaryMetrics: HeroTertiaryMetricConfig[];
}) {
  return (
    <div className="px-4 py-4 sm:px-5 lg:hidden">
      <HeroMarketMetricGrid variant="card" coin={coin} coinData={coinData} price={price} market={market} />

      <HeroTertiaryMetrics metrics={tertiaryMetrics} activeDepeg={peg.activeDepeg} />
    </div>
  );
}

export function HeroCardDesktopSection({
  coin,
  coinData,
  price,
  market,
  tertiaryMetrics,
}: HeroSectionBaseProps & {
  tertiaryMetrics: HeroTertiaryMetricConfig[];
}) {
  // The fourth slot preserves the live 30d excess-vs-T-bill metric even though
  // the visual chrome now matches the compact reference dossier.
  const excessMetric = tertiaryMetrics.find((metric) => metric.key === "excess-yield");


  return (
    <div className="hidden lg:block">
      <HeroMarketMetricGrid
        variant="cell"
        coin={coin}
        coinData={coinData}
        price={price}
        market={market}
        tertiaryMetric={excessMetric}
      />
    </div>
  );
}
