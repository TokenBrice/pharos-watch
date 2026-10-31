"use client";

import { FeatureHeroSplit, HeroMetricRow } from "@/components/feature-hero-split";
import { OpsStatusChip } from "@/components/ops-status-chip";
import { UniverseChip } from "@/components/universe-chip";
import { UNIVERSES } from "@/lib/universe-vocabulary";
import type { AltPegDistributionRow, AltPegSnapshot, AltPegTrendStats } from "@/lib/alt-peg-market";
import { formatNonUsdShare } from "@shared/lib/alt-peg-snapshot";
import { formatChartDate, formatCurrency, formatPercent, formatSignedPercent } from "@shared/lib/format";

/** Segments narrower than this carry no inline name; the ranking below names every peg. */
const MIX_LABEL_MIN_SHARE = 6;
/** Currency pegs under this share fold into one neutral "smaller pegs" segment. */
const MIX_TAIL_SHARE = 0.5;

interface MixSegment {
  key: string;
  label: string;
  sharePct: number;
  /** `null`: the neutral merged tail. */
  colorHex: string | null;
}

function formatCap(value: number | null): string {
  return value === null ? "—" : formatCurrency(value, 1);
}

function MixBracket({ label, marketCap, sharePct, partial }: {
  label: string;
  marketCap: number | null;
  sharePct: number | null;
  partial: boolean;
}) {
  return (
    <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">{label}</span>
      <span className="pharos-numeric text-foreground">
        {partial && marketCap !== null ? "known " : ""}{formatCap(marketCap)}
      </span>
      {sharePct !== null ? <span className="pharos-numeric">{formatNonUsdShare(sharePct)}</span> : null}
    </p>
  );
}

/**
 * The cohort mix as one 100% bar: commodity pegs, then currency and index pegs,
 * each in rank order and its peg hue. Shares exist only when every non-USD coin
 * reports complete supply; otherwise the bar is hatched and says why, never empty.
 */
function CohortMixBar({ snapshot }: { snapshot: AltPegSnapshot }) {
  const partial = snapshot.altSupplyUnavailableCount > 0 || snapshot.altSupplyPartialCount > 0;
  const commodityRows = snapshot.distributionRows.filter((row) => row.group === "Commodity");
  const otherRows = snapshot.distributionRows.filter((row) => row.group !== "Commodity");
  const ordered: AltPegDistributionRow[] = [...commodityRows, ...otherRows];
  const complete = !partial && ordered.every((row) => row.sharePct !== null);
  // The long currency tail merges into one neutral segment, so slivers never read as the withheld hatch.
  const tail = otherRows.filter((row) => (row.sharePct ?? 0) < MIX_TAIL_SHARE);
  const segments: MixSegment[] = [
    ...[...commodityRows, ...otherRows.filter((row) => (row.sharePct ?? 0) >= MIX_TAIL_SHARE)].map((row) => ({
      key: row.peg, label: row.label, sharePct: row.sharePct ?? 0, colorHex: row.colorHex as string | null,
    })),
    ...(tail.length > 0
      ? [{ key: "tail", label: `${tail.length} smaller pegs`, sharePct: tail.reduce((sum, row) => sum + (row.sharePct ?? 0), 0), colorHex: null }]
      : []),
  ];
  const commodityShare = snapshot.commoditySharePct ?? 0;

  return (
    <div className="space-y-3 px-5 py-5 sm:px-6 lg:px-7" data-testid="cohort-mix">
      <p className="pharos-label">Cohort mix</p>
      {complete ? (
        <div className="space-y-1.5">
          <div className="relative h-4 text-2xs text-muted-foreground" aria-hidden="true">
            {segments.reduce<{ offset: number; labels: React.ReactNode[] }>((acc, segment) => {
              const share = segment.sharePct;
              if (share >= MIX_LABEL_MIN_SHARE) {
                acc.labels.push(
                  <span key={segment.key} className="absolute top-0 truncate pl-0.5" style={{ left: `${acc.offset}%`, maxWidth: `${share}%` }}>
                    {segment.label}
                  </span>,
                );
              }
              acc.offset += share;
              return acc;
            }, { offset: 0, labels: [] }).labels}
          </div>
          <div
            className="flex h-3.5 w-full gap-px overflow-hidden rounded-sm"
            role="img"
            aria-label={`Non-USD market cap by peg: ${segments.map((segment) => `${segment.label} ${formatNonUsdShare(segment.sharePct)}`).join(", ")}`}
          >
            {segments.map((segment) => (
              <span
                key={segment.key}
                className={segment.colorHex ? "h-full min-w-px" : "h-full min-w-px bg-muted-foreground/45"}
                style={{ width: `${segment.sharePct}%`, backgroundColor: segment.colorHex ?? undefined }}
                title={`${segment.label} ${formatNonUsdShare(segment.sharePct)}`}
              />
            ))}
          </div>
          {/* Brackets under the bar span the commodity and currency/index runs. */}
          <div className="grid gap-2 pt-1" style={{ gridTemplateColumns: `minmax(0, ${commodityShare}fr) minmax(0, ${100 - commodityShare}fr)` }}>
            <div className="min-w-max border-t border-foreground/25 pt-1.5">
              <MixBracket label="Commodities" marketCap={snapshot.commodityMarketCap} sharePct={snapshot.commoditySharePct} partial={false} />
            </div>
            <div className="border-t border-foreground/25 pt-1.5">
              <MixBracket label="Currencies and indexes" marketCap={snapshot.nonCommodityMarketCap} sharePct={snapshot.nonCommoditySharePct} partial={false} />
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <div
            className="flex h-3.5 w-full items-center justify-center rounded-sm border border-border bg-muted-foreground/25 bg-[image:repeating-linear-gradient(135deg,var(--color-card)_0_2px,transparent_2px_6px)]"
            role="img"
            aria-label={`Cohort mix withheld: ${snapshot.altSupplyUnavailableCount} of ${snapshot.altCoinCount} non-USD coins have no supply observation${snapshot.altSupplyPartialCount > 0 ? ` and ${snapshot.altSupplyPartialCount} report only a partial-chain remainder` : ""}`}
          />
          <p className="text-xs text-muted-foreground">
            Mix withheld: <span className="pharos-numeric">{snapshot.altSupplyUnavailableCount}</span> of{" "}
            <span className="pharos-numeric">{snapshot.altCoinCount}</span> coins have no supply observation
            {snapshot.altSupplyPartialCount > 0 ? (
              <>, and <span className="pharos-numeric">{snapshot.altSupplyPartialCount}</span> report only a partial-chain remainder</>
            ) : null}
            , so no share is exact.
          </p>
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            <MixBracket label="Commodities" marketCap={snapshot.commodityMarketCap} sharePct={null} partial />
            <MixBracket label="Currencies and indexes" marketCap={snapshot.nonCommodityMarketCap} sharePct={null} partial />
          </div>
        </div>
      )}
    </div>
  );
}

export function NonUsdHero({
  snapshot,
  trendStats,
  supplyAsOfSec,
}: {
  snapshot: AltPegSnapshot;
  trendStats: AltPegTrendStats | null;
  /** Generation of the stablecoins list the beam was read from. */
  supplyAsOfSec: number | null;
}) {
  const partial = snapshot.altSupplyUnavailableCount > 0 || snapshot.altSupplyPartialCount > 0;
  const coreCount = UNIVERSES.core.count;
  const shareDetail = trendStats
    ? `as of ${formatChartDate(trendStats.latestDate * 1000, "short-year")}${trendStats.latestCoverageIncomplete ? " · partial coverage" : ""}`
    : undefined;

  return (
    <FeatureHeroSplit
      layout="stacked"
      ariaLabel="Non-USD stablecoin market"
      beamLabel={partial ? "Non-USD stablecoin market cap · known subtotal, partial" : "Non-USD stablecoin market cap"}
      beamValue={formatCap(snapshot.altMarketCap)}
      status={partial ? (
        <OpsStatusChip
          label="Partial supply"
          reasonCodes={[
            ...(snapshot.altSupplyUnavailableCount > 0 ? ["supply-unavailable"] : []),
            ...(snapshot.altSupplyPartialCount > 0 ? ["supply-partial"] : []),
          ]}
        >
          <p>
            {snapshot.altSupplyUnavailableCount > 0 ? (
              <>
                <span className="pharos-numeric">{snapshot.altSupplyUnavailableCount}</span> of{" "}
                <span className="pharos-numeric">{snapshot.altCoinCount}</span> core non-USD coins have no current supply observation.
              </>
            ) : null}
            {snapshot.altSupplyPartialCount > 0 ? (
              <>
                {" "}<span className="pharos-numeric">{snapshot.altSupplyPartialCount}</span> report only a partial-chain remainder.
              </>
            ) : null}
            {" "}The figure sums the <span className="pharos-numeric">{snapshot.altSupplyObservedCount}</span> with a reported supply; shares and the cohort mix are withheld.
          </p>
          {supplyAsOfSec != null ? (
            <p className="text-muted-foreground">Stablecoin list as of {formatChartDate(supplyAsOfSec * 1000, "full")} UTC.</p>
          ) : null}
        </OpsStatusChip>
      ) : null}
      universe={<UniverseChip universe="core" value={`${snapshot.altCoinCount} non-USD of ${coreCount}`} />}
      sub={
        <div className="divide-y divide-border/50">
          <HeroMetricRow
            label="Share of all stablecoins"
            value={trendStats ? formatPercent(trendStats.latestSharePct, 2) : "—"}
            detail={shareDetail}
          />
          <HeroMetricRow
            label="1-year change"
            value={formatSignedPercent(trendStats?.yearlyMarketCapChangePct, 1, "—")}
            detail={trendStats?.valueCoverageIncomplete ? "provider history · partial coverage" : "provider history"}
          />
          <HeroMetricRow label="Non-USD pegs" value={snapshot.altPegCount} detail="with core coins" />
        </div>
      }
    >
      <CohortMixBar snapshot={snapshot} />
    </FeatureHeroSplit>
  );
}
