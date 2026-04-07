"use client";

import { useMemo, useState, useCallback } from "react";
import Link from "next/link";
import {
  AreaChart,
  Area,
  ResponsiveContainer,
} from "recharts";
import { ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ChartSkeleton } from "@/components/chart-skeleton";
import { TimeRangeButtons } from "@/components/time-range-buttons";
import { useTimeRangeFilter } from "@/hooks/use-time-range-filter";
import { CHART_ORANGE, CHART_BLUE, CHART_CYAN, CHART_GREEN } from "@/lib/chart-colors";
import { CHART_DRAW_IN, CHART_NO_ANIM } from "@/lib/chart-animation";
import { DateTooltip, MonoYAxis, TimeGrid, TimeXAxis } from "@/components/chart-primitives";
import { formatChartDate, formatCurrency, formatScore } from "@shared/lib/format";
import { useStabilityIndexDetail, type StabilityContributor } from "@/hooks/api-hooks";
import { PsiLighthouse } from "@/components/stability-index";
import { PSI_BAND_CLASSES, PSI_BG_OVERLAY_CLASSES, PSI_BORDER_CLASSES, PSI_HEX_COLORS, type ConditionBand } from "@shared/lib/psi-colors";
import {
  buildPsiChartData,
  getDisplayedPsi,
  getPsiBandStreak,
  getPsiCompletedDayPoint,
} from "@shared/lib/psi-view-model";
import { trackEvent } from "@/lib/analytics";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { useLogos } from "@/hooks/use-logos";
import { ScoreChart, BAND_ZONES, PSI_EVENTS } from "@/components/psi-history-chart";
import { buildStablecoinUrl } from "@/lib/urls";
import { THREE_DAYS_MS } from "@/lib/constants";
import { MethodologyLabel } from "@/components/methodology-hint";
import type { MethodologyContextKey } from "@/lib/methodology-context";

/* ─── Constants ─────────────────────────────────────────────────── */

const HISTORY_WINDOW_DAYS = 30;
const SCORE_DECIMAL_PLACES = 1;

const COMPONENT_COLORS = {
  severity: CHART_ORANGE,
  breadth: CHART_BLUE,
  stressBreadth: CHART_CYAN,
  trend: CHART_GREEN,
};

const COMPONENT_DETAIL: Array<{
  key: "severity" | "breadth" | "stressBreadth" | "trend";
  label: string;
  topic: MethodologyContextKey;
  sign: string;
  color: string;
}> = [
  { key: "severity", label: "Severity", topic: "psiSeverity", sign: "−", color: COMPONENT_COLORS.severity },
  { key: "breadth", label: "Breadth", topic: "psiBreadth", sign: "−", color: COMPONENT_COLORS.breadth },
  { key: "stressBreadth", label: "Stress Breadth", topic: "psiStressBreadth", sign: "−", color: COMPONENT_COLORS.stressBreadth },
  { key: "trend", label: "Trend", topic: "psiTrend", sign: "+", color: COMPONENT_COLORS.trend },
];

/* ─── ScoreArc — 240° gauge showing score position across bands ── */

const ARC_BANDS = [
  { min: 0, max: 20, color: PSI_HEX_COLORS.MELTDOWN },
  { min: 20, max: 40, color: PSI_HEX_COLORS.CRISIS },
  { min: 40, max: 60, color: PSI_HEX_COLORS.FRACTURE },
  { min: 60, max: 75, color: PSI_HEX_COLORS.TREMOR },
  { min: 75, max: 90, color: PSI_HEX_COLORS.STEADY },
  { min: 90, max: 100, color: PSI_HEX_COLORS.BEDROCK },
];

/** 240° arc gauge — the needle shows where the score sits across all six bands. */
function ScoreArc({ score, color, size = 140 }: { score: number; color: string; size?: number }) {
  const r = 44; // radius within 100×100 viewBox
  const cx = 50;
  const cy = 54; // shift center down slightly so arc sits above
  const startAngle = 150; // degrees — 240° sweep from 150° to 390° (=30°)
  const sweep = 240;
  const gap = 1.2; // degrees gap between segments

  function polarToXY(angleDeg: number) {
    const rad = (angleDeg * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }

  function arcPath(a1: number, a2: number) {
    const s = polarToXY(a1);
    const e = polarToXY(a2);
    const large = a2 - a1 > 180 ? 1 : 0;
    return `M ${s.x} ${s.y} A ${r} ${r} 0 ${large} 1 ${e.x} ${e.y}`;
  }

  // Needle position
  const clamped = Math.max(0, Math.min(100, score));
  const needleAngle = startAngle + (clamped / 100) * sweep;
  const needleTip = polarToXY(needleAngle);
  // Small offset back from tip for the needle base
  const needleBase1Angle = needleAngle + 90;
  const needleBase2Angle = needleAngle - 90;
  const baseR = 3;
  const b1 = { x: cx + baseR * Math.cos((needleBase1Angle * Math.PI) / 180), y: cy + baseR * Math.sin((needleBase1Angle * Math.PI) / 180) };
  const b2 = { x: cx + baseR * Math.cos((needleBase2Angle * Math.PI) / 180), y: cy + baseR * Math.sin((needleBase2Angle * Math.PI) / 180) };

  return (
    <svg width={size} height={size * 0.72} viewBox="0 0 100 72" fill="none" className="shrink-0">
      {/* Band segments */}
      {ARC_BANDS.map((band) => {
        const segStart = startAngle + (band.min / 100) * sweep + gap / 2;
        const segEnd = startAngle + (band.max / 100) * sweep - gap / 2;
        return (
          <path
            key={band.min}
            d={arcPath(segStart, segEnd)}
            stroke={band.color}
            strokeWidth={5}
            strokeLinecap="round"
            fill="none"
            opacity={0.35}
          />
        );
      })}

      {/* Active arc — filled portion up to the score */}
      {ARC_BANDS.map((band) => {
        const bandStart = startAngle + (band.min / 100) * sweep + gap / 2;
        const bandEnd = startAngle + (band.max / 100) * sweep - gap / 2;
        if (clamped <= band.min) return null; // score hasn't reached this band
        const fillEnd = Math.min(bandEnd, startAngle + (clamped / 100) * sweep);
        if (fillEnd <= bandStart) return null;
        return (
          <path
            key={`fill-${band.min}`}
            d={arcPath(bandStart, fillEnd)}
            stroke={band.color}
            strokeWidth={5}
            strokeLinecap="round"
            fill="none"
            opacity={0.85}
          />
        );
      })}

      {/* Needle */}
      <polygon
        points={`${needleTip.x},${needleTip.y} ${b1.x},${b1.y} ${b2.x},${b2.y}`}
        fill={color}
        opacity={0.9}
      />
      <circle cx={cx} cy={cy} r={3.5} fill="var(--surface-overlay, #1a1a2e)" stroke={color} strokeWidth={1.5} />
    </svg>
  );
}

/* ─── EventTimeline ─────────────────────────────────────────────── */

function EventTimeline({ data }: { data: { ts: number; score: number }[] }) {
  return (
    <Card className="rounded-xl animate-in fade-in duration-300">
      <CardHeader className="pb-2">
        <CardTitle as="h2" className="pharos-kicker">Notable Events</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="relative ml-3 border-l border-border/50 pl-5 space-y-5">
          {PSI_EVENTS.map((evt) => {
            const d = new Date(evt.date);
            const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" };
            const dateStr = evt.dateEnd
              ? (() => {
                  const dEnd = new Date(evt.dateEnd);
                  const sameYear = d.getFullYear() === dEnd.getFullYear();
                  const start = d.toLocaleDateString("en-US", sameYear ? { month: "short", day: "numeric" } : opts);
                  const end = dEnd.toLocaleDateString("en-US", opts);
                  return `${start} – ${end}`;
                })()
              : d.toLocaleDateString("en-US", opts);
            // Find the worst (lowest) score within the event window
            const rangeEnd = evt.dateEnd ?? evt.date + THREE_DAYS_MS;
            const SLACK = THREE_DAYS_MS;
            const nearby = data.filter((p) => p.ts >= evt.date - SLACK && p.ts <= rangeEnd + SLACK);
            const worst = nearby.length > 0
              ? nearby.reduce((w, p) => (p.score < w.score ? p : w))
              : null;
            const psi = worst ? worst.score : null;
            const psiBand = psi !== null ? BAND_ZONES.find((z) => psi >= z.y1)?.label ?? "" : "";
            const psiColor = psiBand ? PSI_BAND_CLASSES[psiBand as ConditionBand] ?? "text-muted-foreground" : "text-muted-foreground";
            const dotHex = psiBand ? PSI_HEX_COLORS[psiBand as ConditionBand] ?? "var(--muted-foreground)" : "var(--muted-foreground)";
            return (
              <div key={evt.label} className="relative min-w-0">
                {/* Timeline dot — colored by the band during the event */}
                <span
                  className="absolute -left-[calc(1.25rem+3.5px)] top-[5px] h-[7px] w-[7px] rounded-full ring-2 ring-background"
                  style={{ backgroundColor: dotHex }}
                  aria-hidden="true"
                />
                <div className="flex flex-col gap-0.5">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                    <span className="text-sm tabular-nums text-muted-foreground shrink-0">{dateStr}</span>
                    <span className="text-sm font-semibold shrink-0">{evt.label}</span>
                    {psi !== null && (
                      <span className={`text-sm tabular-nums font-medium shrink-0 ${psiColor}`}>
                        PSI {formatScore(psi)}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-x-4 min-w-0 overflow-hidden">
                    {evt.links.map((link) => (
                      <a
                        key={link.url}
                        href={link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="pharos-focus-ring text-sm text-blue-700 dark:text-blue-400 hover:underline inline-flex items-center gap-1 min-w-0 shrink rounded-sm"
                      >
                        <span className="truncate" title={link.title}>{link.title}</span>
                        <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
                      </a>
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

/* ─── ComponentChart ────────────────────────────────────────────── */

function ComponentChart({
  data,
}: {
  data: { ts: number; severity: number; breadth: number; stressBreadth: number; trend: number }[];
}) {
  const { range, setRange, filteredData, options } = useTimeRangeFilter(data, "ts");
  const [shouldAnimate, setShouldAnimate] = useState(true);
  const animProps = shouldAnimate ? CHART_DRAW_IN : CHART_NO_ANIM;
  const handleAnimationEnd = useCallback(() => {
    setShouldAnimate(false);
  }, []);

  return (
    <Card className="rounded-xl animate-in fade-in duration-300">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle as="h2" className="pharos-kicker">Component Breakdown</CardTitle>
        <TimeRangeButtons options={options} value={range} onChange={(r) => { trackEvent("time_range_changed", { page: "stability-index-components", range: r }); setRange(r); }} />
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-4 mb-4">
          {COMPONENT_DETAIL.map((item) => (
            <div key={item.label} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.color }} />
              <MethodologyLabel topic={item.topic}>{item.label}</MethodologyLabel>
            </div>
          ))}
        </div>
        {filteredData.length > 0 ? (
          <div
            className="h-[250px] sm:h-[350px]"
            role="figure"
            aria-label={`PSI component breakdown chart showing ${filteredData.length} data points`}
          >
            <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
              <AreaChart data={filteredData} margin={{ top: 5, right: 5, bottom: 20, left: 5 }}>
                <defs>
                  <linearGradient id="psiSeverityGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={COMPONENT_COLORS.severity} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={COMPONENT_COLORS.severity} stopOpacity={0.05} />
                  </linearGradient>
                  <linearGradient id="psiBreadthGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={COMPONENT_COLORS.breadth} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={COMPONENT_COLORS.breadth} stopOpacity={0.05} />
                  </linearGradient>
                  <linearGradient id="psiStressBreadthGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={COMPONENT_COLORS.stressBreadth} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={COMPONENT_COLORS.stressBreadth} stopOpacity={0.05} />
                  </linearGradient>
                  <linearGradient id="psiTrendGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={COMPONENT_COLORS.trend} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={COMPONENT_COLORS.trend} stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <TimeGrid />
                <TimeXAxis dataKey="ts" minTickGap={72} />
                <MonoYAxis />
                <DateTooltip
                  formatter={(value, name) => [formatScore(Number(value)), String(name)]}
                />
                <Area
                  type="monotone"
                  dataKey="severity"
                  name="Severity"
                  stackId="penalties"
                  stroke={COMPONENT_COLORS.severity}
                  fill="url(#psiSeverityGrad)"
                  strokeWidth={1.5}
                  onAnimationEnd={handleAnimationEnd}
                  {...animProps}
                />
                <Area
                  type="monotone"
                  dataKey="breadth"
                  name="Breadth"
                  stackId="penalties"
                  stroke={COMPONENT_COLORS.breadth}
                  fill="url(#psiBreadthGrad)"
                  strokeWidth={1.5}
                  {...animProps}
                />
                <Area
                  type="monotone"
                  dataKey="stressBreadth"
                  name="Stress Breadth"
                  stackId="penalties"
                  stroke={COMPONENT_COLORS.stressBreadth}
                  fill="url(#psiStressBreadthGrad)"
                  strokeWidth={1.5}
                  {...animProps}
                />
                <Area
                  type="monotone"
                  dataKey="trend"
                  name="Trend"
                  stroke={COMPONENT_COLORS.trend}
                  fill="none"
                  strokeWidth={2}
                  {...animProps}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="flex h-[250px] sm:h-[350px] items-center justify-center text-muted-foreground">
            No component data available
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ─── HistoryStats ──────────────────────────────────────────────── */

type HistoryPoint = { date: number; score: number; band: string };
type HistoryStatItem = { label: string; value: string; band: string; sub: string | null };

function useHistoryStats(history: HistoryPoint[]): HistoryStatItem[] {
  return useMemo(() => {
    if (!history.length) return [];
    const last30 = history.slice(0, HISTORY_WINDOW_DAYS);
    const scores = last30.map((p) => p.score);
    const high30 = scores.reduce((m, s) => Math.max(m, s), -Infinity);
    const low30 = scores.reduce((m, s) => Math.min(m, s), Infinity);
    const factor = 10 ** SCORE_DECIMAL_PLACES;
    const avg30 = Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * factor) / factor;
    const avg30Band = BAND_ZONES.find((z) => avg30 >= z.y1)?.label ?? "";
    const high30Band = last30.find((p) => p.score === high30)?.band ?? "";
    const low30Band = last30.find((p) => p.score === low30)?.band ?? "";
    const worst = history.reduce((w, p) => (p.score < w.score ? p : w), history[0]);
    return [
      { label: "30d High", value: formatScore(high30), band: high30Band, sub: null },
      { label: "30d Low", value: formatScore(low30), band: low30Band, sub: null },
      { label: "30d Avg", value: formatScore(avg30), band: avg30Band, sub: null },
      {
        label: "ATL",
        value: formatScore(worst.score),
        band: worst.band,
        sub: formatChartDate(worst.date * 1000, "month-year"),
      },
    ];
  }, [history]);
}

function HistoryStats({
  history,
  compact = false,
  className,
}: {
  history: HistoryPoint[];
  compact?: boolean;
  className?: string;
}) {
  const items = useHistoryStats(history);
  if (!items.length) {
    return (
      <div className="text-center py-8 text-muted-foreground text-sm">
        No data available
      </div>
    );
  }

  return (
    <div
      className={cn(
        compact
          ? "grid w-full grid-cols-4 gap-x-3 gap-y-2 border-t border-border/60 pt-3 lg:hidden"
          : "grid grid-cols-4 gap-x-4 gap-y-2",
        className,
      )}
    >
      {items.map((item) => {
        const color = PSI_BAND_CLASSES[item.band as ConditionBand] ?? "text-foreground";
        return (
          <div key={item.label} className="flex min-w-0 flex-col items-center gap-0.5 text-center">
            <span className={compact ? "text-xs text-muted-foreground whitespace-nowrap" : "pharos-kicker"}>{item.label}</span>
            <span className={cn(compact ? "text-base font-bold" : "text-lg font-extrabold", "tabular-nums leading-none", color)}>
              {item.value}
            </span>
            {item.sub ? <span className="text-xs leading-tight text-muted-foreground">{item.sub}</span> : null}
          </div>
        );
      })}
    </div>
  );
}

/* ─── Methodology ───────────────────────────────────────────────── */

function Methodology({
  methodology,
}: {
  methodology: {
    versionLabel: string;
    currentVersionLabel: string;
    changelogPath: string;
    isCurrent: boolean;
  };
}) {
  return (
    <Card className="rounded-xl animate-in fade-in duration-300">
      <CardHeader className="space-y-2 pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle as="h2" className="pharos-kicker">Methodology</CardTitle>
          <Badge variant="outline" className="bg-muted/50 text-muted-foreground border-border/60">
            {methodology.versionLabel}
          </Badge>
          {!methodology.isCurrent && (
            <Badge variant="outline" className="bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30">
              latest {methodology.currentVersionLabel}
            </Badge>
          )}
          <Link
            href={methodology.changelogPath}
            className="pharos-focus-ring text-xs text-foreground underline underline-offset-4 hover:text-amber-700 dark:text-amber-400 transition-colors rounded-sm"
          >
            Version history &rarr;
          </Link>
        </div>
        <p className="text-xs text-muted-foreground">
          Version increments when formula, caps, or component definitions change.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          A single 0–100 score reflecting overall stablecoin market health, updated every 30 minutes.
        </p>
        <code className="block rounded-lg bg-muted px-4 py-3 text-sm font-mono">
          Score = 100 &minus; severity &minus; breadth &minus; stressBreadth + trend
        </code>
        <p className="text-sm text-muted-foreground">
          Chronically depegged coins decay linearly from full impact at 30 days to a 25% floor at 150 days.{" "}
          <Link
            href="/methodology/#stability-index"
            className="pharos-focus-ring text-foreground underline underline-offset-4 hover:text-amber-700 dark:text-amber-400 transition-colors rounded-sm"
          >
            Full methodology &rarr;
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}

/* ─── Contributors Table ───────────────────────────────────────── */

function ContributorsTable({
  contributors,
  totalMcapUsd,
}: {
  contributors: StabilityContributor[];
  totalMcapUsd: number;
}) {
  const { data: logos } = useLogos();

  const rows = useMemo(() => {
    if (!contributors.length) return [];
    return contributors
      .map((c) => {
        const share = totalMcapUsd > 0 ? c.mcapUsd / totalMcapUsd : 0;
        const amplifier = Math.log2(1 + c.mcapUsd / 1e9);
        const severity = (Math.abs(c.bps) / 100) * share * amplifier * 60 * c.factor;
        const breadth = Math.sqrt(c.mcapUsd / 1e9) * 3 * c.factor;
        return { ...c, severity, breadth, total: severity + breadth };
      })
      .sort((a, b) => b.total - a.total);
  }, [contributors, totalMcapUsd]);

  return (
    <Card className="rounded-xl animate-in fade-in duration-300">
      <CardHeader className="pb-2">
        <CardTitle as="h2" className="pharos-kicker">Top Contributors</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
            <div className="rounded-full bg-muted/50 p-3">
              <svg className="h-6 w-6 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
            </div>
            <p className="text-sm text-muted-foreground">No contributor data available</p>
            <p className="text-xs text-muted-foreground">Data appears when stablecoins are actively depegged</p>
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground mb-4">
              Which stablecoins are currently pushing the score below 100, ranked by total impact.
              Long-lasting depegs (over 30 days) receive a scoring depreciation — the percentage in parentheses next to the age shows the remaining impact weight.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm" aria-label="Stablecoins currently contributing to PSI score reduction">
                <thead>
                  <tr className="border-b text-left">
                    <th className="pb-2 pr-4 font-medium text-muted-foreground text-xs uppercase tracking-wider">Coin</th>
                    <th className="pb-2 pr-4 font-medium text-muted-foreground text-xs uppercase tracking-wider text-right">Deviation</th>
                    <th className="pb-2 pr-4 font-medium text-muted-foreground text-xs uppercase tracking-wider text-right hidden sm:table-cell">MCap</th>
                    <th className="pb-2 pr-4 font-medium text-muted-foreground text-xs uppercase tracking-wider text-right hidden sm:table-cell">Severity</th>
                    <th className="pb-2 pr-4 font-medium text-muted-foreground text-xs uppercase tracking-wider text-right hidden sm:table-cell">Breadth</th>
                    <th className="pb-2 pr-4 font-medium text-muted-foreground text-xs uppercase tracking-wider text-right">Total</th>
                    <th className="pb-2 font-medium text-muted-foreground text-xs uppercase tracking-wider text-right">Age</th>
                  </tr>
                </thead>
                <tbody className="text-muted-foreground">
                  {rows.map((r, idx) => (
                    <tr
                      key={r.id}
                      className={cn(
                        "border-b last:border-0 transition-colors hover:bg-muted/30",
                        idx === 0 && "bg-amber-500/5"
                      )}
                    >
                      <td className="py-2.5 pr-4">
                        <Link
                          href={buildStablecoinUrl(r.id)}
                          className="pharos-focus-ring flex items-center gap-2 font-medium text-foreground hover:text-blue-700 dark:hover:text-blue-400 transition-colors rounded-sm"
                        >
                          <StablecoinLogo src={logos[r.id]} name={r.symbol} size={22} />
                          <span className={cn(idx === 0 && "font-semibold")}>{r.symbol}</span>
                          {idx === 0 && (
                            <span className="ml-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-xs font-semibold text-amber-700 dark:text-amber-400">
                              Top
                            </span>
                          )}
                        </Link>
                      </td>
                      <td className={cn("py-2.5 pr-4 text-right tabular-nums", r.bps < 0 ? "text-red-700 dark:text-red-400" : "text-amber-700 dark:text-amber-400")}>
                        {r.bps > 0 ? "+" : ""}{(r.bps / 100).toFixed(2)}%
                      </td>
                      <td className="py-2.5 pr-4 text-right tabular-nums hidden sm:table-cell font-mono text-xs">
                        {formatCurrency(r.mcapUsd)}
                      </td>
                      <td className="py-2.5 pr-4 text-right tabular-nums hidden sm:table-cell font-mono">{r.severity.toFixed(2)}</td>
                      <td className="py-2.5 pr-4 text-right tabular-nums hidden sm:table-cell font-mono">{r.breadth.toFixed(2)}</td>
                      <td className="py-2.5 pr-4 text-right tabular-nums">
                        <div className="flex items-center justify-end gap-2">
                          <div className="h-1.5 w-12 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                            <div
                              className="h-full rounded-full bg-foreground/60"
                              style={{ width: `${Math.min(100, (r.total / (rows[0]?.total ?? 1)) * 100)}%` }}
                            />
                          </div>
                          <span className={cn("font-mono font-medium", idx === 0 ? "text-foreground" : "text-foreground/70")}>
                            {r.total.toFixed(2)}
                          </span>
                        </div>
                      </td>
                      <td className="py-2.5 text-right tabular-nums">
                        <span className="font-mono text-xs">{r.ageDays < 1 ? "<1d" : `${Math.round(r.ageDays)}d`}</span>
                        {r.factor < 1 && (
                          <span className="ml-1 text-xs text-muted-foreground/60">({Math.round(r.factor * 100)}%)</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/* ─── Main Client Component ─────────────────────────────────────── */

export function StabilityIndexClient() {
  const { data, isLoading, isError, error, dataUpdatedAt, refetch, meta } = useStabilityIndexDetail();
  const history = data?.history;
  const current = data?.current;

  const daysInBand = useMemo(() => {
    if (!current || !history?.length) return 0;
    return getPsiBandStreak(history, current.computedAt, getDisplayedPsi(current).band);
  }, [current, history]);

  const chartData = useMemo(() => {
    return buildPsiChartData(history, current);
  }, [current, history]);

  const componentData = useMemo(() => {
    if (!current || !history) return [];
    const reversed = [...history].filter((p) => p.components).reverse();
    return [
      ...reversed.map((p) => ({
        ts: p.date * 1000,
        severity: p.components?.severity ?? 0,
        breadth: p.components?.breadth ?? 0,
        stressBreadth: p.components?.stressBreadth ?? 0,
        trend: p.components?.trend ?? 0,
      })),
      {
        ts: current.computedAt * 1000,
        severity: current.components.severity,
        breadth: current.components.breadth,
        stressBreadth: current.components.stressBreadth ?? 0,
        trend: current.components.trend,
      },
    ];
  }, [current, history]);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Card className="rounded-xl">
          <CardContent className="flex items-center gap-6 py-8">
            <Skeleton className="h-20 w-20 rounded-full" />
            <div className="space-y-3">
              <Skeleton className="h-10 w-32" />
              <Skeleton className="h-6 w-48" />
            </div>
          </CardContent>
        </Card>
        <Card className="rounded-xl">
          <CardHeader>
            <Skeleton className="h-6 w-40" />
          </CardHeader>
          <CardContent>
            <ChartSkeleton className="h-[250px] sm:h-[350px] w-full" />
          </CardContent>
        </Card>
        <Card className="rounded-xl">
          <CardHeader>
            <Skeleton className="h-6 w-48" />
          </CardHeader>
          <CardContent>
            <ChartSkeleton className="h-[250px] sm:h-[350px] w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isError || (!isLoading && !data?.current)) {
    const uiError = error ?? new Error("Stability Index data is temporarily unavailable.");
    return (
      <QueryErrorNotice
        error={uiError}
        hasData={false}
        onRetry={() => {
          void refetch();
        }}
      />
    );
  }

  if (!data?.current) {
    return (
      <div className="space-y-6 animate-in fade-in duration-300">
        <Card className="rounded-xl">
          <CardContent>
            <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
              <div className="rounded-full bg-muted/50 p-4">
                <svg className="h-8 w-8 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
              </div>
              <p className="font-medium">No stability data available</p>
              <p className="text-sm text-muted-foreground">PSI scores are computed every 30 minutes. Check back soon.</p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { components } = data.current;
  const { score: displayScore, band: displayBand } = getDisplayedPsi(data.current);
  const yesterday = getPsiCompletedDayPoint(data.history, data.current.computedAt, 1);
  const delta = yesterday ? Math.round((displayScore - yesterday.score) * 10) / 10 : null;
  const colorClass = PSI_BAND_CLASSES[displayBand as ConditionBand] ?? "text-foreground";
  const hexColor = PSI_HEX_COLORS[displayBand as ConditionBand] ?? "#888";

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      <StaleDataBanner
        queries={[{ preset: "stabilityIndex", dataUpdatedAt, error, hasData: !!data?.current, meta }]}
      />
      {/* Hero — instrument panel with arc gauge */}
      <Card
        className={cn(
          "rounded-xl py-0 border-l-4 transition-colors duration-500",
          PSI_BORDER_CLASSES[displayBand as ConditionBand] ?? "",
          PSI_BG_OVERLAY_CLASSES[displayBand as ConditionBand] ?? "",
        )}
      >
        <CardContent
          className="grid gap-4 py-5 sm:gap-5 sm:py-6 lg:grid-cols-[auto_minmax(0,1fr)_auto] lg:items-center lg:gap-6"
          aria-live="polite"
        >
          {/* Score + gauge — the instrument */}
          <div className="flex flex-col items-center gap-1 lg:flex-row lg:gap-5">
            {/* Lighthouse — larger on desktop */}
            <PsiLighthouse band={displayBand} color={hexColor} size={96} />
            {/* Score cluster */}
            <div className="flex min-w-0 flex-col items-center lg:items-start">
              {/* Arc gauge */}
              <ScoreArc score={displayScore} color={hexColor} size={160} />
              {/* Score + band overlaid below the arc */}
              <div className="flex flex-wrap items-baseline justify-center gap-x-2.5 gap-y-1 -mt-1 lg:justify-start">
                <span className="text-xs text-muted-foreground mr-1">
                  <MethodologyLabel topic="psi">PSI</MethodologyLabel>
                </span>
                <span className={`text-4xl font-extrabold font-mono tabular-nums leading-none ${colorClass}`}>
                  {formatScore(displayScore)}
                </span>
                <span className={`text-base font-bold uppercase tracking-wide sm:text-lg ${colorClass}`}>
                  {displayBand}
                </span>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 mt-1.5 text-sm text-muted-foreground lg:justify-start">
                {delta !== null && (
                  <span className={`font-medium tabular-nums ${delta >= 0 ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}`}>
                    {delta >= 0 ? "+" : ""}{delta.toFixed(1)} vs yesterday
                  </span>
                )}
                <span>{daysInBand} day{daysInBand !== 1 ? "s" : ""} in {displayBand}</span>
              </div>
            </div>
          </div>
          {/* Component breakdown — fills the middle */}
          <div className="hidden lg:grid lg:min-w-0 lg:grid-cols-4 lg:gap-x-5 lg:border-l lg:border-border/60 lg:pl-5">
            {COMPONENT_DETAIL.map((c) => (
              <div key={c.label} className="flex min-w-0 flex-col items-center gap-0.5 text-center">
                <span className="text-xs text-muted-foreground">
                  <MethodologyLabel topic={c.topic}>{c.label}</MethodologyLabel>
                </span>
                <span className="text-lg font-extrabold tabular-nums leading-none" style={{ color: c.color }}>
                  {c.sign}{formatScore(components[c.key] ?? 0)}
                </span>
              </div>
            ))}
          </div>
          {/* History stats — right edge */}
          <div className="hidden lg:block lg:min-w-[18rem] lg:border-l lg:border-border/60 lg:pl-5">
            <HistoryStats history={data.history} />
          </div>
          {/* History stats — mobile only */}
          <HistoryStats history={data.history} compact />
        </CardContent>
      </Card>

      {/* Score History */}
      <ScoreChart data={chartData} />

      {/* ── Supporting detail zone ── */}
      <div className="border-t border-border/40 pt-2" />

      {/* Notable Events */}
      <EventTimeline data={chartData} />

      {/* Top Contributors */}
      {data.current.contributors && data.current.contributors.length > 0 && (
        <ContributorsTable
          contributors={data.current.contributors}
          totalMcapUsd={data.current.totalMcapUsd ?? 0}
        />
      )}

      {/* Component Breakdown */}
      <ComponentChart data={componentData} />

      {/* Methodology */}
      <Methodology methodology={data.methodology} />
    </div>
  );
}
