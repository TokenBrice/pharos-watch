"use client";

import { useMemo } from "react";
import { PieChart, Pie, Cell, Tooltip, Label } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { DETAIL_SECTION_TITLE_CLASS } from "@/components/stablecoin-detail/section-title";
import { PharosChartTooltip, TooltipRow } from "@/components/pharos-chart-tooltip";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useDexLiquidity } from "@/hooks/api-hooks";
import { formatCurrency } from "@shared/lib/format";
import { CHAIN_META } from "@shared/lib/chains";
import { CHART_PALETTE, CHART_SLATE } from "@/lib/chart-colors";
import {
  CHAIN_HEX,
  PROTOCOL_HEX,
  PROTOCOL_LOGOS,
  normalizeChain,
  prettifyProtocol,
} from "@/lib/dex-constants";

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

function CenterLabel({ cx, cy, text }: { cx: number; cy: number; text: string }) {
  return (
    <text
      x={cx}
      y={cy}
      textAnchor="middle"
      dominantBaseline="central"
      className="fill-foreground"
      style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}
    >
      {text}
    </text>
  );
}

function DonutCard({
  title,
  ariaLabel,
  data,
  total,
}: {
  title: string;
  ariaLabel: string;
  data: DonutDatum[];
  total: number;
}) {
  const { ref, ready, width, height } = useChartContainerReady<HTMLDivElement>();

  return (
    <Card className="rounded-xl">
      <CardHeader className="pb-2">
        <CardTitle as="h2" className={DETAIL_SECTION_TITLE_CLASS}>{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div
          ref={ref}
          className="pharos-chart-stage h-[200px] sm:h-[250px]"
          role="figure"
          aria-label={ariaLabel}
        >
          {ready ? (
            <PieChart width={width} height={height}>
              <Pie
                data={data}
                cx="50%"
                cy="50%"
                innerRadius={50}
                outerRadius={85}
                dataKey="value"
                nameKey="name"
                paddingAngle={3}
                strokeWidth={0}
              >
                {data.map((d, i) => (
                  <Cell key={i} fill={d.hex} />
                ))}
                <Label
                  content={(props) => {
                    const vb = props.viewBox;
                    if (!vb || !("cx" in vb)) return null;
                    return <CenterLabel cx={vb.cx} cy={vb.cy} text={formatCurrency(total)} />;
                  }}
                  position="center"
                />
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
          ) : null}
        </div>

        {/* Legend */}
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
          {data.map((d) => (
            <span key={d.name} className="flex items-center gap-1.5">
              {d.logoPath ? (
                <img
                  src={d.logoPath}
                  alt=""
                  width={14}
                  height={14}
                  className={`h-3.5 w-3.5 rounded-full object-contain shrink-0${d.darkInvert ? " dark:invert" : ""}`}
                />
              ) : (
                <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: d.hex }} />
              )}
              <span>{d.name}</span>
              <span className="font-mono tabular-nums">
                {total > 0 ? `${((d.value / total) * 100).toFixed(0)}%` : "—"}
              </span>
            </span>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/* ── Main section ── */

function ChainDistributionCard({ stablecoinId }: { stablecoinId: string }) {
  const { data: listData, isLoading } = useStablecoins();

  const { data, total } = useMemo(() => {
    const coin = listData?.peggedAssets.find((a) => a.id === stablecoinId);
    if (!coin?.chainCirculating) return { data: [], total: 0 };

    const raw: Record<string, number> = {};
    for (const [chain, info] of Object.entries(coin.chainCirculating)) {
      if (info.current > 0) raw[chain] = info.current;
    }

    return buildDonutData(raw, {
      labelForKey: normalizeChain,
      hexForKey: (key) => CHAIN_HEX[key.toLowerCase()],
      logoForKey: (key) => {
        const meta = CHAIN_META[key.toLowerCase()];
        return meta?.logoPath ? { path: meta.logoPath, darkInvert: meta.darkInvert } : null;
      },
    });
  }, [listData, stablecoinId]);

  if (isLoading) {
    return (
      <Card className="rounded-xl">
        <CardHeader className="pb-2">
          <CardTitle as="h2" className={DETAIL_SECTION_TITLE_CLASS}>Chain Distribution</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-[200px] sm:h-[250px] rounded-xl" />
        </CardContent>
      </Card>
    );
  }

  if (data.length === 0) return null;

  return (
    <DonutCard
      title="Chain Distribution"
      ariaLabel={`Supply distribution across ${data.length} chains`}
      data={data}
      total={total}
    />
  );
}

function DexDistributionCard({ stablecoinId }: { stablecoinId: string }) {
  const { data: liquidityMap, isLoading } = useDexLiquidity();

  const { data, total } = useMemo(() => {
    const liq = liquidityMap?.[stablecoinId];
    if (!liq?.protocolTvl) return { data: [], total: 0 };

    return buildDonutData(liq.protocolTvl, {
      labelForKey: prettifyProtocol,
      hexForKey: (key) => PROTOCOL_HEX[key],
      logoForKey: (key) => {
        const path = PROTOCOL_LOGOS[key];
        return path ? { path } : null;
      },
    });
  }, [liquidityMap, stablecoinId]);

  if (isLoading) {
    return (
      <Card className="rounded-xl">
        <CardHeader className="pb-2">
          <CardTitle as="h2" className={DETAIL_SECTION_TITLE_CLASS}>DEX Liquidity Distribution</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-[200px] sm:h-[250px] rounded-xl" />
        </CardContent>
      </Card>
    );
  }

  if (data.length === 0) {
    return (
      <Card className="rounded-xl">
        <CardHeader className="pb-2">
          <CardTitle as="h2" className={DETAIL_SECTION_TITLE_CLASS}>DEX Liquidity Distribution</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border px-4 py-2.5 text-sm border-border/60 bg-muted/40 text-muted-foreground">
            No DEX liquidity data available
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <DonutCard
      title="DEX Liquidity Distribution"
      ariaLabel={`DEX liquidity distribution across ${data.length} protocols`}
      data={data}
      total={total}
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
