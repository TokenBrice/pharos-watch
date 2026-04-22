"use client";

import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { ChartSkeleton } from "@/components/chart-skeleton";
import { MethodologyLabel } from "@/components/methodology-hint";
import { PsiLighthouse } from "@/components/stability-index";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { buildStablecoinUrl } from "@/lib/urls";
import type { MethodologyContextKey } from "@/lib/methodology-context";
import { formatCurrency, formatScore } from "@shared/lib/format";
import {
  PSI_BAND_CLASSES,
  PSI_BG_OVERLAY_CLASSES,
  PSI_BORDER_CLASSES,
  PSI_HEX_COLORS,
  type ConditionBand,
} from "@shared/lib/psi-colors";
import type { HistoryStatItem, PsiContributorRow, PsiEventTimelineRow } from "./view-model";

export interface StabilityComponentScores {
  severity: number;
  breadth: number;
  stressBreadth: number;
  trend: number;
}

export const STABILITY_COMPONENT_COLORS = {
  severity: "var(--chart-2)",
  breadth: "var(--chart-1)",
  stressBreadth: "var(--chart-4)",
  trend: "var(--chart-3)",
} as const;

export const STABILITY_COMPONENT_DETAIL: Array<{
  key: keyof StabilityComponentScores;
  label: string;
  topic: MethodologyContextKey;
  sign: string;
  color: string;
}> = [
  {
    key: "severity",
    label: "Severity",
    topic: "psiSeverity",
    sign: "\u2212",
    color: STABILITY_COMPONENT_COLORS.severity,
  },
  {
    key: "breadth",
    label: "Breadth",
    topic: "psiBreadth",
    sign: "\u2212",
    color: STABILITY_COMPONENT_COLORS.breadth,
  },
  {
    key: "stressBreadth",
    label: "Stress Breadth",
    topic: "psiStressBreadth",
    sign: "\u2212",
    color: STABILITY_COMPONENT_COLORS.stressBreadth,
  },
  {
    key: "trend",
    label: "Trend",
    topic: "psiTrend",
    sign: "+",
    color: STABILITY_COMPONENT_COLORS.trend,
  },
];

const ARC_BANDS = [
  { min: 0, max: 20, color: PSI_HEX_COLORS.MELTDOWN },
  { min: 20, max: 40, color: PSI_HEX_COLORS.CRISIS },
  { min: 40, max: 60, color: PSI_HEX_COLORS.FRACTURE },
  { min: 60, max: 75, color: PSI_HEX_COLORS.TREMOR },
  { min: 75, max: 90, color: PSI_HEX_COLORS.STEADY },
  { min: 90, max: 100, color: PSI_HEX_COLORS.BEDROCK },
];

function ScoreArc({ score, color, size = 140 }: { score: number; color: string; size?: number }) {
  const r = 44;
  const cx = 50;
  const cy = 54;
  const startAngle = 150;
  const sweep = 240;
  const gap = 1.2;

  function polarToXY(angleDeg: number) {
    const rad = (angleDeg * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }

  function arcPath(a1: number, a2: number) {
    const start = polarToXY(a1);
    const end = polarToXY(a2);
    const large = a2 - a1 > 180 ? 1 : 0;
    return `M ${start.x} ${start.y} A ${r} ${r} 0 ${large} 1 ${end.x} ${end.y}`;
  }

  const clamped = Math.max(0, Math.min(100, score));
  const needleAngle = startAngle + (clamped / 100) * sweep;
  const needleTip = polarToXY(needleAngle);
  const needleBase1Angle = needleAngle + 90;
  const needleBase2Angle = needleAngle - 90;
  const baseR = 3;
  const base1 = {
    x: cx + baseR * Math.cos((needleBase1Angle * Math.PI) / 180),
    y: cy + baseR * Math.sin((needleBase1Angle * Math.PI) / 180),
  };
  const base2 = {
    x: cx + baseR * Math.cos((needleBase2Angle * Math.PI) / 180),
    y: cy + baseR * Math.sin((needleBase2Angle * Math.PI) / 180),
  };

  return (
    <svg width={size} height={size * 0.72} viewBox="0 0 100 72" fill="none" className="shrink-0">
      {ARC_BANDS.map((band) => {
        const segmentStart = startAngle + (band.min / 100) * sweep + gap / 2;
        const segmentEnd = startAngle + (band.max / 100) * sweep - gap / 2;
        return (
          <path
            key={band.min}
            d={arcPath(segmentStart, segmentEnd)}
            stroke={band.color}
            strokeWidth={5}
            strokeLinecap="round"
            fill="none"
            opacity={0.35}
          />
        );
      })}

      {ARC_BANDS.map((band) => {
        const bandStart = startAngle + (band.min / 100) * sweep + gap / 2;
        const bandEnd = startAngle + (band.max / 100) * sweep - gap / 2;
        if (clamped <= band.min) return null;
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

      <polygon
        points={`${needleTip.x},${needleTip.y} ${base1.x},${base1.y} ${base2.x},${base2.y}`}
        fill={color}
        opacity={0.9}
      />
      <circle cx={cx} cy={cy} r={3.5} fill="var(--surface-overlay, #1a1a2e)" stroke={color} strokeWidth={1.5} />
    </svg>
  );
}

function PsiHistoryStatsGrid({
  items,
  compact = false,
  className,
}: {
  items: HistoryStatItem[];
  compact?: boolean;
  className?: string;
}) {
  if (items.length === 0) {
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
            <span className={compact ? "text-xs text-muted-foreground whitespace-nowrap" : "pharos-kicker"}>
              {item.label}
            </span>
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

export function StabilityIndexLoadingState() {
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

export function StabilityIndexEmptyState() {
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

export function StabilityIndexHero({
  band,
  score,
  delta,
  daysInBand,
  components,
  historyStats,
}: {
  band: string;
  score: number;
  delta: number | null;
  daysInBand: number;
  components: StabilityComponentScores;
  historyStats: HistoryStatItem[];
}) {
  const conditionBand = band as ConditionBand;
  const colorClass = PSI_BAND_CLASSES[conditionBand] ?? "text-foreground";
  const hexColor = PSI_HEX_COLORS[conditionBand] ?? "#888";
  const deltaClass = delta != null && delta >= 0
    ? "text-green-700 dark:text-green-400"
    : "text-red-700 dark:text-red-400";

  return (
    <Card
      className={cn(
        "rounded-xl py-0 border-l-4 transition-colors duration-500",
        PSI_BORDER_CLASSES[conditionBand] ?? "",
        PSI_BG_OVERLAY_CLASSES[conditionBand] ?? "",
      )}
    >
      <CardContent
        className="grid gap-4 py-5 sm:gap-5 sm:py-6 lg:grid-cols-[auto_minmax(0,1fr)_auto] lg:items-center lg:gap-6"
        aria-live="polite"
      >
        <div className="flex items-center justify-center lg:justify-start">
          <div className="flex items-center gap-4 lg:gap-5">
            <PsiLighthouse band={band} color={hexColor} size={96} />
            <ScoreArc score={score} color={hexColor} size={160} />
          </div>
          <div className="hidden shrink-0 flex-col gap-1 pl-3 lg:flex">
            <div className="flex items-baseline gap-2">
              <span className="text-xs text-muted-foreground">
                <MethodologyLabel topic="psi">PSI</MethodologyLabel>
              </span>
              <span className={`text-4xl font-extrabold font-mono tabular-nums leading-none ${colorClass}`}>
                {formatScore(score)}
              </span>
              <span className={`text-base font-bold uppercase tracking-wide ${colorClass}`}>
                {band}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              {delta !== null && (
                <span className={`font-medium tabular-nums ${deltaClass}`}>
                  {delta >= 0 ? "+" : ""}
                  {delta.toFixed(1)} vs yesterday
                </span>
              )}
              <span>{daysInBand} day{daysInBand !== 1 ? "s" : ""} in {band}</span>
            </div>
          </div>
        </div>

        <div className="flex flex-col items-center gap-1 lg:hidden">
          <div className="flex items-baseline gap-2">
            <span className="text-xs text-muted-foreground">
              <MethodologyLabel topic="psi">PSI</MethodologyLabel>
            </span>
            <span className={`text-4xl font-extrabold font-mono tabular-nums leading-none ${colorClass}`}>
              {formatScore(score)}
            </span>
            <span className={`text-base font-bold uppercase tracking-wide ${colorClass}`}>
              {band}
            </span>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            {delta !== null && (
              <span className={`font-medium tabular-nums ${deltaClass}`}>
                {delta >= 0 ? "+" : ""}
                {delta.toFixed(1)} vs yesterday
              </span>
            )}
            <span>{daysInBand} day{daysInBand !== 1 ? "s" : ""} in {band}</span>
          </div>
        </div>

        <div className="hidden lg:grid lg:min-w-0 lg:grid-cols-4 lg:gap-x-5 lg:border-l lg:border-border/60 lg:pl-5">
          {STABILITY_COMPONENT_DETAIL.map((component) => (
            <div key={component.label} className="flex min-w-0 flex-col items-center gap-0.5 text-center">
              <span className="text-xs text-muted-foreground">
                <MethodologyLabel topic={component.topic}>{component.label}</MethodologyLabel>
              </span>
              <span className="text-lg font-extrabold tabular-nums leading-none" style={{ color: component.color }}>
                {component.sign}
                {formatScore(components[component.key] ?? 0)}
              </span>
            </div>
          ))}
        </div>

        <div className="hidden lg:block lg:min-w-[18rem] lg:border-l lg:border-border/60 lg:pl-5">
          <PsiHistoryStatsGrid items={historyStats} />
        </div>

        <PsiHistoryStatsGrid items={historyStats} compact />
      </CardContent>
    </Card>
  );
}

export function PsiEventTimelineCard({ rows }: { rows: PsiEventTimelineRow[] }) {
  return (
    <Card className="rounded-xl animate-in fade-in duration-300">
      <CardHeader className="pb-2">
        <CardTitle as="h2" className="pharos-kicker">Notable Events</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="relative ml-3 border-l border-border/50 pl-5 space-y-5">
          {rows.map((event) => (
            <div key={event.label} className="relative min-w-0">
              <span
                className="absolute -left-[calc(1.25rem+3.5px)] top-[5px] h-[7px] w-[7px] rounded-full ring-2 ring-background"
                style={{ backgroundColor: event.dotHex }}
                aria-hidden="true"
              />
              <div className="flex flex-col gap-0.5">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                  <span className="text-sm tabular-nums text-muted-foreground shrink-0">{event.dateStr}</span>
                  <span className="text-sm font-semibold shrink-0">{event.label}</span>
                  {event.psi !== null && (
                    <span className={`text-sm tabular-nums font-medium shrink-0 ${event.psiColor}`}>
                      PSI {formatScore(event.psi)}
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-x-4 min-w-0 overflow-hidden">
                  {event.links.map((link) => (
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
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export function PsiMethodologyCard({
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
          A single 0-100 score reflecting overall stablecoin market health, updated every 30 minutes.
        </p>
        <code className="block rounded-lg bg-muted px-4 py-3 text-sm font-mono">
          Score = 100 &minus; severity &minus; breadth &minus; stressBreadth + trend
        </code>
        <p className="text-sm text-muted-foreground">
          Chronically depegged coins decay linearly from full impact at 30 days to a 25% floor at 150 days.{" "}
          <Link
            href="/methodology/#stability-index-methodology"
            className="pharos-focus-ring text-foreground underline underline-offset-4 hover:text-amber-700 dark:text-amber-400 transition-colors rounded-sm"
          >
            Full methodology &rarr;
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}

export function PsiContributorsTableCard({
  rows,
  logos,
}: {
  rows: PsiContributorRow[];
  logos?: Record<string, string>;
}) {
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
              Long-lasting depegs (over 30 days) receive a scoring depreciation - the percentage in parentheses next to the age shows the remaining impact weight.
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
                  {rows.map((row, index) => (
                    <tr
                      key={row.id}
                      className={cn(
                        "border-b last:border-0 transition-colors hover:bg-muted/30",
                        index === 0 && "bg-amber-500/5",
                      )}
                    >
                      <td className="py-2.5 pr-4">
                        <Link
                          href={buildStablecoinUrl(row.id)}
                          className="pharos-focus-ring flex items-center gap-2 font-medium text-foreground hover:text-blue-700 dark:hover:text-blue-400 transition-colors rounded-sm"
                        >
                          <StablecoinLogo src={logos?.[row.id]} name={row.symbol} size={22} />
                          <span className={cn(index === 0 && "font-semibold")}>{row.symbol}</span>
                          {index === 0 && (
                            <span className="ml-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-xs font-semibold text-amber-700 dark:text-amber-400">
                              Top
                            </span>
                          )}
                        </Link>
                      </td>
                      <td className={cn("py-2.5 pr-4 text-right tabular-nums", row.bps < 0 ? "text-red-700 dark:text-red-400" : "text-amber-700 dark:text-amber-400")}>
                        {row.bps > 0 ? "+" : ""}
                        {(row.bps / 100).toFixed(2)}%
                      </td>
                      <td className="py-2.5 pr-4 text-right tabular-nums hidden sm:table-cell font-mono text-xs">
                        {formatCurrency(row.mcapUsd)}
                      </td>
                      <td className="py-2.5 pr-4 text-right tabular-nums hidden sm:table-cell font-mono">{row.severity.toFixed(2)}</td>
                      <td className="py-2.5 pr-4 text-right tabular-nums hidden sm:table-cell font-mono">{row.breadth.toFixed(2)}</td>
                      <td className="py-2.5 pr-4 text-right tabular-nums">
                        <div className="flex items-center justify-end gap-2">
                          <div className="h-1.5 w-12 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                            <div
                              className="h-full rounded-full bg-foreground/60"
                              style={{ width: `${Math.min(100, (row.total / (rows[0]?.total ?? 1)) * 100)}%` }}
                            />
                          </div>
                          <span className={cn("font-mono font-medium", index === 0 ? "text-foreground" : "text-foreground/70")}>
                            {row.total.toFixed(2)}
                          </span>
                        </div>
                      </td>
                      <td className="py-2.5 text-right tabular-nums">
                        <span className="font-mono text-xs">{row.ageDays < 1 ? "<1d" : `${Math.round(row.ageDays)}d`}</span>
                        {row.factor < 1 && (
                          <span className="ml-1 text-xs text-muted-foreground/60">({Math.round(row.factor * 100)}%)</span>
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
