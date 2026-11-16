"use client";

import { useMemo, type ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { DetailModuleCard } from "@/components/stablecoin-detail/module-title";
import { MethodologyLabel } from "@/components/methodology-hint";
import { ShareMeter } from "@/components/stablecoin-detail/threshold-gauge";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useDexLiquidityCoin } from "@/hooks/api-hooks";
import { hasMeaningfulDexData } from "@/components/liquidity/dex-liquidity-card";
import { canonicalizeChainCirculating, chainCirculatingForDisplay } from "@shared/lib/chains/circulating";
import { formatCurrency } from "@shared/lib/format";
import { CHAIN_META } from "@shared/types/chain-identity";
import { normalizeChain, prettifyProtocol, protocolLogo } from "@/lib/dex-display-constants";
import { resolveCompactLogoSrc } from "@/lib/logo-variants";
import { QueryStateNotice } from "@/components/query-state-notice";
import { FreshnessIndicator } from "@/components/status/freshness-indicator";
import { DataHealthBanner } from "@/components/data-health-banner";
import { useFreshnessBoundary } from "@/hooks/use-freshness-boundary";
import { deriveDataHealth } from "@/lib/data-health";
import { DATA_HEALTH_PRESETS } from "@/lib/data-health-config";

interface DistributionRow {
  key: string;
  name: string;
  value: number;
  logoPath?: string;
  darkInvert?: boolean;
  /** Set on the folded "Other" row: how many categories it holds. */
  foldedCount?: number;
}

interface DistributionUnits {
  /** Headline label for the total ("Circulating", "DEX TVL"). */
  totalLabel: string;
  singular: string;
  plural: string;
}

/** Named rows before the rest folds into Other; a lone remainder stays named. */
const TOP_ROWS = 6;
/** At or above this share one chain is the story, so untracked deployments get a caveat. */
const CONCENTRATED_SHARE = 0.95;

function buildDistribution(
  raw: Record<string, number>,
  opts: {
    labelForKey: (key: string) => string;
    logoForKey?: (key: string) => { path: string; darkInvert?: boolean } | null;
    ungroupedKey?: string;
  },
): { rows: DistributionRow[]; total: number; categoryCount: number } {
  const entries = Object.entries(raw)
    .filter(([, value]) => Number.isFinite(value) && value > 0)
    .sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  const named = entries.filter(([key]) => key !== opts.ungroupedKey);
  const ungrouped = entries.find(([key]) => key === opts.ungroupedKey);
  const shown = named.length === TOP_ROWS + 1 ? named : named.slice(0, TOP_ROWS);
  const folded = named.slice(shown.length);
  const toRow = ([key, value]: [string, number]): DistributionRow => {
    const logo = opts.logoForKey?.(key);
    return { key, name: opts.labelForKey(key), value, logoPath: logo?.path, darkInvert: logo?.darkInvert };
  };

  const rows = shown.map(toRow);
  // Unattributed supply is never folded into Other: it is not a known category.
  if (ungrouped) rows.push(toRow(ungrouped));
  if (folded.length > 0) {
    rows.push({ key: "other", name: "Other", value: folded.reduce((sum, [, value]) => sum + value, 0), foldedCount: folded.length });
  }
  return { rows, total, categoryCount: named.length };
}

function formatShare(share: number): string {
  const pct = share * 100;
  if (pct === 100) return "100%";
  if (pct > 0 && pct < 0.1) return "<0.1%";
  // A near-total share never rounds up to a claim of all of it.
  if (pct < 100 && pct >= 99.95) return ">99.9%";
  return `${pct.toFixed(1)}%`;
}

function RowMark({ row }: { row: DistributionRow }) {
  if (row.logoPath) {
    return (
      <img
        src={resolveCompactLogoSrc(row.logoPath, 16)}
        alt=""
        width={16}
        height={16}
        className={`h-4 w-4 shrink-0 rounded-full object-contain${row.darkInvert ? " dark:invert" : ""}`}
      />
    );
  }
  // A logo-sized slot, so a row without a logo keeps its name on the shared text edge.
  return (
    <span aria-hidden="true" className="flex h-4 w-4 shrink-0 items-center justify-center">
      <span className="h-2 w-2 rounded-full bg-muted-foreground/40" />
    </span>
  );
}

function rowName(row: DistributionRow, units: DistributionUnits): string {
  return row.foldedCount ? `Other (${row.foldedCount} ${units.plural})` : row.name;
}

/**
 * Ranked share list: the total first, then each category's share as a
 * neutral bar (a composition, not a graded level), top six + Other. A dominant
 * category keeps the same list (its full bar says it), so the chain and
 * protocol cards always read, and balance, as the same figure.
 */
function DistributionFigure({
  ariaLabel,
  rows,
  total,
  categoryCount,
  units,
  note,
}: {
  ariaLabel: string;
  rows: DistributionRow[];
  total: number;
  categoryCount: number;
  units: DistributionUnits;
  note?: ReactNode;
}) {
  return (
    <figure aria-label={ariaLabel} className="@container space-y-3">
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="pharos-label">{units.totalLabel}</span>
        <span className="pharos-numeric text-xl font-semibold text-foreground">{formatCurrency(total)}</span>
        {categoryCount > 0 ? (
          <span className="text-sm text-muted-foreground">
            across {categoryCount} {categoryCount === 1 ? units.singular : units.plural}
          </span>
        ) : null}
      </p>
      <ol className="@3xl:columns-2 @3xl:gap-x-10">
        {rows.map((row) => {
          const share = row.value / total;
          return (
            <li key={row.key} className="break-inside-avoid pb-2.5">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="flex min-w-0 items-center gap-2 self-center">
                  <RowMark row={row} />
                  <span className={row.foldedCount ? "text-muted-foreground" : "text-foreground"}>{rowName(row, units)}</span>
                </span>
                <span className="pharos-numeric shrink-0 text-xs">
                  <span className="text-foreground">{formatShare(share)}</span>
                  <span className="ml-2 text-muted-foreground">{formatCurrency(row.value)}</span>
                </span>
              </div>
              <div aria-hidden="true" className="mt-1.5">
                <ShareMeter valuePct={share * 100} ariaLabel={rowName(row, units)} />
              </div>
            </li>
          );
        })}
      </ol>
      {note}
    </figure>
  );
}

function DistributionUnavailableCard({
  title,
  label,
  onRetry,
}: {
  title: ReactNode;
  label: string;
  onRetry: () => void;
}) {
  return (
    <DetailModuleCard title={title}>
        <QueryStateNotice state="unavailable" label={label} onRetry={onRetry} />
    </DetailModuleCard>
  );
}

function DistributionCardSkeleton({ title }: { title: ReactNode }) {
  return (
    <DetailModuleCard title={title}>
        <Skeleton className="h-[180px] rounded-xl" />
    </DetailModuleCard>
  );
}

const CHAIN_UNITS: DistributionUnits = { totalLabel: "Circulating", singular: "chain", plural: "chains" };
const PROTOCOL_UNITS: DistributionUnits = { totalLabel: "DEX TVL", singular: "protocol", plural: "protocols" };

function ChainDistributionCard({ stablecoinId }: { stablecoinId: string }) {
  const query = useStablecoins();
  const { data: listData, isLoading } = query;
  const healthInput = {
    ...DATA_HEALTH_PRESETS.stablecoins,
    label: "Chain distribution data",
    dataUpdatedAt: query.dataUpdatedAt,
    meta: query.meta,
    error: query.error,
    isLoading,
    hasData: !!listData,
  };
  const nowMs = useFreshnessBoundary([healthInput]);
  const health = deriveDataHealth(healthInput, nowMs ?? query.dataUpdatedAt);

  const { rows, total, categoryCount, unattributed, unavailable, deployedChainCount } = useMemo(() => {
    const coin = listData?.peggedAssets.find((a) => a.id === stablecoinId);
    // A chain-dropout carry shows each carried chain at its baseline when the rows then sum to the headline.
    const chainCirculating = coin && chainCirculatingForDisplay(coin);
    const deployedChainCount = new Set(coin?.contracts?.map((contract) => contract.chain)).size;
    const empty = { rows: [], total: 0, categoryCount: 0, unattributed: 0, deployedChainCount };
    if (!chainCirculating) return { ...empty, unavailable: false };

    const raw: Record<string, number> = {};
    // Check before canonicalization: unregistered labels are dropped there, not proven zero.
    let unavailable = Object.values(chainCirculating).some(
      (point) => typeof point?.current !== "number" || !Number.isFinite(point.current) || point.current < 0,
    );
    const diagnostics = { droppedRows: 0, droppedChainIds: [] as string[] };
    for (const [chainId, info] of canonicalizeChainCirculating(chainCirculating, diagnostics)) {
      // An unknown balance also makes the full distribution denominator unknown.
      if (info.current == null) unavailable = true;
      else if (info.current > 0) raw[chainId] = info.current;
    }
    for (const label of diagnostics.droppedChainIds) {
      const remainder = chainCirculating[label]?.current;
      if (typeof remainder === "number" && Number.isFinite(remainder) && remainder > 0) {
        raw.unattributed = (raw.unattributed ?? 0) + remainder;
      }
    }
    if (unavailable) return { ...empty, unavailable: true };

    return { ...buildDistribution(raw, {
      ungroupedKey: "unattributed",
      labelForKey: (key) => key === "unattributed" ? "Unattributed" : normalizeChain(key),
      logoForKey: (key) => {
        const meta = CHAIN_META[key];
        return meta?.logoPath ? { path: meta.logoPath, darkInvert: meta.darkInvert } : null;
      },
    }), unattributed: raw.unattributed ?? 0, unavailable: false, deployedChainCount };
  }, [listData, stablecoinId]);
  const title = <MethodologyLabel topic="supplyByChain">Supply by chain</MethodologyLabel>;

  if (isLoading && !listData) {
    return <DistributionCardSkeleton title={title} />;
  }

  if ((query.error && !listData) || unavailable) {
    return (
      <DistributionUnavailableCard
        title={title}
        label="Chain distribution data"
        onRetry={() => void query.refetch()}
      />
    );
  }

  if (rows.length === 0) return null;
  const untrackedChainCount = deployedChainCount - categoryCount;

  return (
    <DetailModuleCard
      title={title}
      headerRight={
        <FreshnessIndicator
          compact
          updatedAtMs={health.dataUpdatedAt}
          staleAfterMs={health.staleTime}
          health={health}
          labelPrefix="Updated"
        />
      }
      bodyClassName="space-y-3"
    >
      <DataHealthBanner entries={[health]} />
      <DistributionFigure
        ariaLabel={`Circulating supply distribution across ${categoryCount} ${categoryCount === 1 ? "chain" : "chains"}${unattributed > 0 ? `, plus ${formatCurrency(unattributed)} Unattributed supply` : ""}`}
        rows={rows}
        total={total}
        categoryCount={categoryCount}
        units={CHAIN_UNITS}
        note={untrackedChainCount > 0 && rows.some((row) => row.value / total >= CONCENTRATED_SHARE) ? (
          <p className="text-xs text-muted-foreground">
            Deployed on {deployedChainCount} chains; supply is tracked on {categoryCount}. Supply bridged to the other{" "}
            {untrackedChainCount} may be missing.
          </p>
        ) : null}
      />
    </DetailModuleCard>
  );
}

function DexDistributionCard({ stablecoinId }: { stablecoinId: string }) {
  const query = useDexLiquidityCoin(stablecoinId);
  const { data: liquidityMap, isLoading } = query;
  const healthInput = {
    ...DATA_HEALTH_PRESETS.dexLiquidity,
    label: "DEX distribution data",
    dataUpdatedAt: query.dataUpdatedAt,
    meta: query.meta,
    error: query.error,
    isLoading,
    hasData: !!liquidityMap,
  };
  const nowMs = useFreshnessBoundary([healthInput]);
  const health = deriveDataHealth(healthInput, nowMs ?? query.dataUpdatedAt);

  const liq = liquidityMap?.[stablecoinId];
  const isEmpty = !isLoading && !hasMeaningfulDexData(liq);

  const { rows, total, categoryCount } = useMemo(() => {
    if (!liq?.protocolTvl) return { rows: [], total: 0, categoryCount: 0 };

    return buildDistribution(liq.protocolTvl, {
      labelForKey: prettifyProtocol,
      logoForKey: protocolLogo,
    });
  }, [liq]);

  if (isLoading && !liquidityMap) {
    return <DistributionCardSkeleton title="Liquidity by protocol" />;
  }

  if (query.error && !liquidityMap) {
    return (
      <DistributionUnavailableCard
        title="Liquidity by protocol"
        label="DEX distribution data"
        onRetry={() => void query.refetch()}
      />
    );
  }

  if (isEmpty) return null;

  if (rows.length === 0) {
    return (
      <DistributionUnavailableCard
        title="Liquidity by protocol"
        label="DEX protocol breakdown"
        onRetry={() => void query.refetch()}
      />
    );
  }

  return (
    <DetailModuleCard
      title="Liquidity by protocol"
      headerRight={
        <FreshnessIndicator
          compact
          updatedAtMs={health.dataUpdatedAt}
          staleAfterMs={health.staleTime}
          health={health}
          labelPrefix="Updated"
        />
      }
      bodyClassName="space-y-3"
    >
      <DataHealthBanner entries={[health]} />
      <DistributionFigure
        ariaLabel={`DEX liquidity TVL distribution across ${categoryCount} ${categoryCount === 1 ? "protocol" : "protocols"}`}
        rows={rows}
        total={total}
        categoryCount={categoryCount}
        units={PROTOCOL_UNITS}
      />
    </DetailModuleCard>
  );
}

/** A frozen archive keeps its chain context but never reads current DEX liquidity. */
export function DistributionSection({ stablecoinId, frozen = false }: { stablecoinId: string; frozen?: boolean }) {
  if (frozen) {
    return (
      <div className="grid grid-cols-1 gap-3 md:gap-4">
        <ChainDistributionCard stablecoinId={stablecoinId} />
      </div>
    );
  }
  // Column flow sizes tracks to the cards that render: two sit side by side,
  // a lone card (no tracked chains, or no DEX pools) spans the full width.
  return (
    <div className="grid gap-3 md:grid-flow-col md:auto-cols-fr md:gap-4">
      <ChainDistributionCard stablecoinId={stablecoinId} />
      <DexDistributionCard stablecoinId={stablecoinId} />
    </div>
  );
}
