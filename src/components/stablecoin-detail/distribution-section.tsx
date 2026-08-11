"use client";

import { useMemo, type ReactNode } from "react";
import { PieChart, Pie, Cell, Tooltip, Sector } from "recharts";
import type { PieSectorDataItem } from "recharts";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import {
  DETAIL_MODULE_BODY_CLASS,
  DETAIL_MODULE_HEADER_CLASS,
  DETAIL_MODULE_SHELL_CLASS,
  DETAIL_MODULE_TITLE_CLASS,
} from "@/components/stablecoin-detail/section-title-class";
import { MethodologyLabel } from "@/components/methodology-hint";
import { PharosChartTooltip, TooltipRow } from "@/components/pharos-chart-tooltip";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useDexLiquidity } from "@/hooks/api-hooks";
import { hasMeaningfulDexData } from "@/components/dex-liquidity-card";
import { canonicalizeChainCirculating } from "@shared/lib/chain-circulating";
import { formatCurrency } from "@shared/lib/format";
import { CHAIN_META } from "@shared/lib/chains";
import { CHART_PALETTE, CHART_SLATE } from "@/lib/chart-colors";
import { CHAIN_HEX, PROTOCOL_HEX, normalizeChain, prettifyProtocol, protocolLogo } from "@/lib/dex-display-constants";
import { cn } from "@/lib/utils";
import { QueryStateNotice } from "@/components/query-state-notice";
import { FreshnessIndicator } from "@/components/status/freshness-indicator";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";

/* ── Types ── */

interface DonutDatum {
  name: string;
  value: number;
  hex: string;
  logoPath?: string;
  darkInvert?: boolean;
}

/* ── Data preparation ── */

const OTHER_THRESHOLD = 0.02;

function buildDonutData(
  raw: Record<string, number>,
  opts: {
    labelForKey: (key: string) => string;
    hexForKey: (key: string) => string | undefined;
    logoForKey?: (key: string) => { path: string; darkInvert?: boolean } | null;
  },
): { data: DonutDatum[]; total: number } {
  const entries = Object.entries(raw)
    .map(([key, value]) => ({ key, value }))
    .filter((e) => e.value > 0)
    .sort((a, b) => b.value - a.value);

  const total = entries.reduce((sum, e) => sum + e.value, 0);
  if (total === 0) return { data: [], total: 0 };

  const data: DonutDatum[] = [];
  let otherValue = 0;

  for (const e of entries) {
    if (e.value / total < OTHER_THRESHOLD) {
      otherValue += e.value;
    } else {
      const logo = opts.logoForKey?.(e.key);
      data.push({
        name: opts.labelForKey(e.key),
        value: e.value,
        hex: opts.hexForKey(e.key) ?? CHART_PALETTE[data.length % CHART_PALETTE.length],
        logoPath: logo?.path,
        darkInvert: logo?.darkInvert,
      });
    }
  }

  if (otherValue > 0) {
    data.push({ name: "Other", value: otherValue, hex: CHART_SLATE });
  }

  return { data, total };
}

/* ── Donut card ── */

function CenterOverlay({ total, subtitle }: { total: number; subtitle: string }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none animate-in fade-in duration-[220ms] motion-reduce:animate-none">
      {/* Semibold, not medium: at 11px with 0.08em tracking the eyebrow reads
          far lighter than its measured contrast against the donut hole. */}
      <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{subtitle}</span>
      <span className="text-base font-semibold font-mono tabular-nums text-foreground">{formatCurrency(total)}</span>
    </div>
  );
}

function DonutSwatch({ datum }: { datum: DonutDatum }) {
  if (datum.logoPath) {
    return (
      <img
        src={datum.logoPath}
        alt=""
        width={14}
        height={14}
        className={`h-3.5 w-3.5 rounded-full object-contain shrink-0${datum.darkInvert ? " dark:invert" : ""}`}
      />
    );
  }
  return <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: datum.hex }} />;
}

/* A ring of one segment encodes nothing the number does not already say, so a
 * concentrated distribution states the figure instead of drawing a circle. */
function SingleCategoryFigure({
  datum,
  total,
  subtitle,
  ariaLabel,
}: {
  datum: DonutDatum;
  total: number;
  subtitle: string;
  ariaLabel: string;
}) {
  return (
    <div className="flex flex-col gap-1.5 py-1" role="figure" aria-label={ariaLabel}>
      <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{subtitle}</span>
      <span className="font-mono text-2xl font-semibold tabular-nums leading-none text-foreground">
        {formatCurrency(total)}
      </span>
      <span className="mt-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <DonutSwatch datum={datum} />
        <span className="text-foreground">{datum.name}</span>
        <span className="font-mono tabular-nums">100%</span>
      </span>
    </div>
  );
}

function renderActiveShape(props: PieSectorDataItem) {
  return (
    <Sector
      cx={props.cx}
      cy={props.cy}
      innerRadius={props.innerRadius}
      outerRadius={(props.outerRadius ?? 0) + 4}
      startAngle={props.startAngle}
      endAngle={props.endAngle}
      fill={props.fill}
      cornerRadius={props.cornerRadius}
      opacity={1}
    />
  );
}

const DONUT_INNER = 55;
const DONUT_OUTER = 95;

function DonutCard({
  title,
  subtitle,
  ariaLabel,
  data,
  total,
  notice,
  headerEnd,
}: {
  title: ReactNode;
  subtitle: string;
  ariaLabel: string;
  data: DonutDatum[];
  total: number;
  notice?: ReactNode;
  headerEnd?: ReactNode;
}) {
  const { ref, ready, width, height } = useChartContainerReady<HTMLDivElement>();

  return (
    <Card className={DETAIL_MODULE_SHELL_CLASS}>
      <CardHeader className={DETAIL_MODULE_HEADER_CLASS}>
        <DetailSectionTitle className={DETAIL_MODULE_TITLE_CLASS}>{title}</DetailSectionTitle>
        {headerEnd}
      </CardHeader>
      <CardContent className={cn(DETAIL_MODULE_BODY_CLASS, "space-y-3")}>
        {notice}
        {data.length === 1 ? (
          <SingleCategoryFigure datum={data[0]!} total={total} subtitle={subtitle} ariaLabel={ariaLabel} />
        ) : (
          <>
            <div ref={ref} className="relative h-[200px] sm:h-[250px]" role="figure" aria-label={ariaLabel}>
              {ready ? (
                <>
                  <PieChart width={width} height={height} className="cursor-pointer">
                    <Pie
                      data={data}
                      cx="50%"
                      cy="50%"
                      innerRadius={DONUT_INNER}
                      outerRadius={DONUT_OUTER}
                      dataKey="value"
                      nameKey="name"
                      paddingAngle={3}
                      strokeWidth={0}
                      activeShape={renderActiveShape}
                      isAnimationActive={false}
                    >
                      {data.map((d) => (
                        <Cell key={d.name} fill={d.hex} />
                      ))}
                    </Pie>
                    <Tooltip
                      content={({ active, payload }) => {
                        if (!active || !payload?.[0]) return null;
                        const d = payload[0].payload as DonutDatum;
                        const pct = total > 0 ? ((d.value / total) * 100).toFixed(1) : "0";
                        return (
                          <PharosChartTooltip active={active}>
                            <TooltipRow color={d.hex} label={d.name} value={`${formatCurrency(d.value)} (${pct}%)`} />
                          </PharosChartTooltip>
                        );
                      }}
                    />
                  </PieChart>
                  <CenterOverlay total={total} subtitle={subtitle} />
                </>
              ) : null}
            </div>

            {/* Legend */}
            <div className="flex flex-wrap gap-x-3.5 gap-y-1.5 text-xs text-muted-foreground">
              {data.map((d) => {
                const pct = total > 0 ? ((d.value / total) * 100).toFixed(0) : "0";
                return (
                  <span key={d.name} className="inline-flex items-center gap-1.5">
                    <DonutSwatch datum={d} />
                    <span>{d.name}</span>
                    <span className="font-mono tabular-nums">{pct}%</span>
                  </span>
                );
              })}
            </div>
          </>
        )}
      </CardContent>
    </Card>
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
    <Card className={DETAIL_MODULE_SHELL_CLASS}>
      <CardHeader className={DETAIL_MODULE_HEADER_CLASS}>
        <DetailSectionTitle className={DETAIL_MODULE_TITLE_CLASS}>{title}</DetailSectionTitle>
      </CardHeader>
      <CardContent className={DETAIL_MODULE_BODY_CLASS}>
        <QueryStateNotice state="unavailable" label={label} onRetry={onRetry} />
      </CardContent>
    </Card>
  );
}

function DonutCardSkeleton({ title }: { title: ReactNode }) {
  return (
    <Card className={DETAIL_MODULE_SHELL_CLASS}>
      <CardHeader className={DETAIL_MODULE_HEADER_CLASS}>
        <DetailSectionTitle className={DETAIL_MODULE_TITLE_CLASS}>{title}</DetailSectionTitle>
      </CardHeader>
      <CardContent className={DETAIL_MODULE_BODY_CLASS}>
        <Skeleton className="h-[200px] sm:h-[250px] rounded-xl" />
      </CardContent>
    </Card>
  );
}

/* ── Main section ── */

function ChainDistributionCard({ stablecoinId }: { stablecoinId: string }) {
  const query = useStablecoins();
  const { data: listData, isLoading } = query;

  const { data, total } = useMemo(() => {
    const coin = listData?.peggedAssets.find((a) => a.id === stablecoinId);
    if (!coin?.chainCirculating) return { data: [], total: 0 };

    const raw: Record<string, number> = {};
    for (const [chainId, info] of canonicalizeChainCirculating(coin.chainCirculating)) {
      if (info.current > 0) raw[chainId] = info.current;
    }

    return buildDonutData(raw, {
      labelForKey: normalizeChain,
      hexForKey: (key) => CHAIN_HEX[key],
      logoForKey: (key) => {
        const meta = CHAIN_META[key];
        return meta?.logoPath ? { path: meta.logoPath, darkInvert: meta.darkInvert } : null;
      },
    });
  }, [listData, stablecoinId]);

  if (isLoading && !listData) {
    return (
      <DonutCardSkeleton
        title={<MethodologyLabel topic="chainHealthConcentration">Supply by Chain</MethodologyLabel>}
      />
    );
  }

  if (query.error && !listData) {
    return (
      <DistributionUnavailableCard
        title={<MethodologyLabel topic="chainHealthConcentration">Supply by Chain</MethodologyLabel>}
        label="Chain distribution data"
        onRetry={() => void query.refetch()}
      />
    );
  }

  if (data.length === 0) return null;

  return (
    <DonutCard
      title={<MethodologyLabel topic="chainHealthConcentration">Supply by Chain</MethodologyLabel>}
      headerEnd={
        <FreshnessIndicator
          compact
          updatedAtMs={query.dataUpdatedAt}
          staleAfterMs={API_FRESHNESS_MAX_AGE_SEC.stablecoins * 1000}
          labelPrefix="Updated"
        />
      }
      subtitle="Circulating"
      ariaLabel={`Circulating supply distribution across ${data.length} ${data.length === 1 ? "chain" : "chains"}`}
      data={data}
      total={total}
      notice={
        query.error ? (
          <QueryStateNotice
            state="stale-with-data"
            label="Chain distribution data"
            dataUpdatedAt={query.dataUpdatedAt}
            onRetry={() => void query.refetch()}
            compact
          />
        ) : null
      }
    />
  );
}

function DexDistributionCard({ stablecoinId }: { stablecoinId: string }) {
  const query = useDexLiquidity();
  const { data: liquidityMap, isLoading } = query;

  const liq = liquidityMap?.[stablecoinId];
  const isEmpty = !isLoading && !hasMeaningfulDexData(liq);

  const { data, total } = useMemo(() => {
    if (!liq?.protocolTvl) return { data: [], total: 0 };

    return buildDonutData(liq.protocolTvl, {
      labelForKey: prettifyProtocol,
      hexForKey: (key) => PROTOCOL_HEX[key],
      logoForKey: protocolLogo,
    });
  }, [liq]);

  if (isLoading && !liquidityMap) {
    return <DonutCardSkeleton title="Liquidity by Protocol" />;
  }

  if (query.error && !liquidityMap) {
    return (
      <DistributionUnavailableCard
        title="Liquidity by Protocol"
        label="DEX distribution data"
        onRetry={() => void query.refetch()}
      />
    );
  }

  if (isEmpty) return null;

  if (data.length === 0) {
    return (
      <Card className={DETAIL_MODULE_SHELL_CLASS}>
        <CardHeader className={DETAIL_MODULE_HEADER_CLASS}>
          <DetailSectionTitle className={DETAIL_MODULE_TITLE_CLASS}>Liquidity by Protocol</DetailSectionTitle>
        </CardHeader>
        <CardContent className={DETAIL_MODULE_BODY_CLASS}>
          <div className="rounded-md border px-4 py-2.5 text-sm border-border/60 bg-muted/40 text-muted-foreground">
            No observed DEX liquidity pools for this stablecoin
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <DonutCard
      title="Liquidity by Protocol"
      headerEnd={
        <FreshnessIndicator
          compact
          updatedAtMs={query.dataUpdatedAt}
          staleAfterMs={API_FRESHNESS_MAX_AGE_SEC.dexLiquidity * 1000}
          labelPrefix="Updated"
        />
      }
      subtitle="DEX TVL"
      ariaLabel={`DEX liquidity TVL distribution across ${data.length} ${data.length === 1 ? "protocol" : "protocols"}`}
      data={data}
      total={total}
      notice={
        query.error ? (
          <QueryStateNotice
            state="stale-with-data"
            label="DEX distribution data"
            dataUpdatedAt={query.dataUpdatedAt}
            onRetry={() => void query.refetch()}
            compact
          />
        ) : null
      }
    />
  );
}

export function DistributionSection({ stablecoinId }: { stablecoinId: string }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4">
      <ChainDistributionCard stablecoinId={stablecoinId} />
      <DexDistributionCard stablecoinId={stablecoinId} />
    </div>
  );
}
