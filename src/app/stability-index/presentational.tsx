"use client";

import Link from "next/link";
import { Compass, ExternalLink } from "lucide-react";
import { ChartSkeleton } from "@/components/chart-skeleton";
import { MethodologyLabel } from "@/components/methodology-hint";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import {
  TableBody,
  TableCell,
  TableFrame,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/table";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { formatCurrency, formatScore } from "@shared/lib/format";
import { PSI_BAND_CLASSES, type ConditionBand } from "@shared/lib/psi-colors";
import { PsiBeamDimmers } from "./psi-beam-dimmers";
import { PsiLighthouseScene } from "./psi-lighthouse-scene";
import type {
  HistoryStatItem,
  PsiBeamDimmerLane,
  PsiComponentPoint,
  PsiContributorRow,
  PsiEventTimelineRow,
} from "./view-model";

const CONTRIBUTOR_HEAD_CLASS =
  "h-auto px-0 pb-2 pr-4 text-xs uppercase tracking-wider";
const CONTRIBUTOR_CELL_CLASS = "px-0 py-2.5 pr-4";

type PsiHistoryStatsLayout = "grid" | "row" | "compact";

function PsiHistoryStatsGrid({
  items,
  compact = false,
  layout,
  className,
}: {
  items: HistoryStatItem[];
  compact?: boolean;
  layout?: PsiHistoryStatsLayout;
  className?: string;
}) {
  if (items.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground text-sm">
        PSI hasn&apos;t computed yet — check back in 30 minutes.
      </div>
    );
  }

  const resolved: PsiHistoryStatsLayout = layout ?? (compact ? "compact" : "grid");
  const isCompact = resolved === "compact";

  const wrapperClass =
    resolved === "compact"
      ? "grid w-full grid-cols-3 gap-x-3 gap-y-2 border-t border-border/60 pt-3 xl:hidden"
      : resolved === "row"
        ? "flex items-end gap-8"
        : "grid grid-cols-3 gap-3";

  return (
    <div className={cn(wrapperClass, className)}>
      {items.map((item) => {
        const color = PSI_BAND_CLASSES[item.band as ConditionBand] ?? "text-foreground";
        return (
          <div key={item.label} className="flex min-w-0 flex-col items-center gap-0.5 text-center">
            <span
              className={cn(
                "whitespace-nowrap",
                isCompact
                  ? "text-xs text-muted-foreground"
                  : "text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground",
              )}
            >
              {item.label}
            </span>
            <span
              className={cn(
                "pharos-numeric leading-none",
                isCompact ? "text-base font-bold" : "text-2xl font-extrabold",
                color,
              )}
            >
              {item.value}
            </span>
            {item.sub ? (
              <span className="whitespace-nowrap text-xs leading-tight text-muted-foreground">{item.sub}</span>
            ) : null}
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

export function StabilityIndexPanel({
  band,
  score,
  scoreBasis,
  delta,
  daysInBand,
  historyStats,
  lanes,
  componentData,
}: {
  band: string;
  score: number;
  scoreBasis: string;
  delta: number | null;
  daysInBand: number;
  historyStats: HistoryStatItem[];
  lanes: PsiBeamDimmerLane[];
  componentData: PsiComponentPoint[];
}) {
  const conditionBand = band as ConditionBand;
  const colorClass = PSI_BAND_CLASSES[conditionBand] ?? "text-foreground";
  const deltaClass = delta != null && delta >= 0
    ? "text-green-700 dark:text-green-400"
    : "text-red-700 dark:text-red-400";

  return (
    <Card className="rounded-xl py-0">
      <CardContent className="py-6 sm:py-7" aria-live="polite">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="pharos-kicker">The Beacon</p>
            <h2 className="pharos-section-title mt-1 flex items-center gap-2">
              <Compass className="h-4 w-4 text-sky-700 dark:text-sky-300" aria-hidden />
              Market regime, drift, and 30-day range
            </h2>
          </div>
          <p className="text-xs text-muted-foreground">Updated every 30 min</p>
        </div>

        <div className="flex flex-col gap-5 xl:flex-row xl:items-stretch xl:gap-7">
          <div className="mx-auto aspect-[376/288] w-full max-w-sm overflow-hidden rounded-lg xl:mx-0 xl:aspect-auto xl:w-[min(37vw,31rem)] xl:max-w-none xl:shrink-0">
            <PsiLighthouseScene band={band} score={score} fill />
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-4 xl:pt-1">
            <div className="flex min-w-0 flex-col gap-4 xl:flex-row xl:items-center xl:justify-between xl:gap-5">
              <div className="flex min-w-0 flex-col items-center gap-1 text-center xl:shrink-0 xl:items-start xl:text-left">
                <div className="flex flex-wrap items-baseline justify-center gap-x-2 gap-y-0.5 xl:justify-start">
                  <span className="text-xs text-muted-foreground">
                    <MethodologyLabel topic="psi">PSI</MethodologyLabel>
                  </span>
                  <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    {scoreBasis}
                  </span>
                  <span className={`pharos-numeric text-6xl font-extrabold leading-none xl:text-[4.15rem] ${colorClass}`}>
                    {formatScore(score)}
                  </span>
                  <span className={`text-lg font-bold uppercase tracking-wide ${colorClass}`}>
                    {band}
                  </span>
                </div>
                <div className="flex flex-wrap items-baseline justify-center gap-x-3 gap-y-1 text-sm text-muted-foreground xl:justify-start">
                  {delta !== null && (
                    <span className={`font-medium pharos-numeric ${deltaClass}`}>
                      {delta >= 0 ? "+" : ""}
                      {delta.toFixed(1)} vs yesterday
                    </span>
                  )}
                  <span>{daysInBand} day{daysInBand !== 1 ? "s" : ""} in {band}</span>
                </div>
              </div>

              <div className="hidden xl:flex xl:items-center xl:justify-end">
                <PsiHistoryStatsGrid items={historyStats} layout="row" />
              </div>
            </div>

            <PsiHistoryStatsGrid items={historyStats} layout="compact" />

            <div className="border-t border-border/60 pt-4">
              <PsiBeamDimmers lanes={lanes} series={componentData} columns={2} density="compact" />
            </div>
          </div>
        </div>
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
                  <span className="text-sm pharos-numeric text-muted-foreground shrink-0">{event.dateStr}</span>
                  <span className="text-sm font-semibold shrink-0">{event.label}</span>
                  {event.psi !== null && (
                    <span className={`text-sm pharos-numeric font-medium shrink-0 ${event.psiColor}`}>
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
            <TableFrame
              tableId="stability-index-top-contributors"
              testId="stability-index-top-contributors-table"
              chrome="bare"
              density="compact"
              tableProps={{
                "aria-label": "Stablecoins currently contributing to PSI score reduction",
              }}
              viewportProps={{
                compactBottomPadding: false,
                mobileScrollHint: false,
                scrollShadow: false,
              }}
            >
              <TableHeader>
                <TableRow className="text-left hover:bg-transparent">
                  <TableHead scope="col" className={CONTRIBUTOR_HEAD_CLASS}>
                    Coin
                  </TableHead>
                  <TableHead scope="col" className={cn(CONTRIBUTOR_HEAD_CLASS, "text-right")}>
                    Deviation
                  </TableHead>
                  <TableHead
                    scope="col"
                    className={cn(CONTRIBUTOR_HEAD_CLASS, "hidden text-right sm:table-cell")}
                  >
                    MCap
                  </TableHead>
                  <TableHead
                    scope="col"
                    className={cn(CONTRIBUTOR_HEAD_CLASS, "hidden text-right sm:table-cell")}
                  >
                    Severity
                  </TableHead>
                  <TableHead
                    scope="col"
                    className={cn(CONTRIBUTOR_HEAD_CLASS, "hidden text-right sm:table-cell")}
                  >
                    Breadth
                  </TableHead>
                  <TableHead scope="col" className={cn(CONTRIBUTOR_HEAD_CLASS, "text-right")}>
                    Total
                  </TableHead>
                  <TableHead scope="col" className="h-auto px-0 pb-2 text-right text-xs uppercase tracking-wider">
                    Age
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="text-muted-foreground">
                {rows.map((row, index) => (
                  <TableRow
                    key={row.id}
                    className={cn("hover:bg-muted/30", index === 0 && "bg-amber-500/5")}
                  >
                    <TableCell className={CONTRIBUTOR_CELL_CLASS}>
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
                    </TableCell>
                    <TableCell
                      className={cn(
                        CONTRIBUTOR_CELL_CLASS,
                        "text-right pharos-numeric",
                        row.bps < 0
                          ? "text-red-700 dark:text-red-400"
                          : "text-amber-700 dark:text-amber-400",
                      )}
                    >
                      {row.bps > 0 ? "+" : ""}
                      {(row.bps / 100).toFixed(2)}%
                    </TableCell>
                    <TableCell
                      className={cn(
                        CONTRIBUTOR_CELL_CLASS,
                        "hidden text-right pharos-numeric text-xs sm:table-cell",
                      )}
                    >
                      {formatCurrency(row.mcapUsd)}
                    </TableCell>
                    <TableCell
                      className={cn(
                        CONTRIBUTOR_CELL_CLASS,
                        "hidden text-right pharos-numeric sm:table-cell",
                      )}
                    >
                      {row.severity.toFixed(2)}
                    </TableCell>
                    <TableCell
                      className={cn(
                        CONTRIBUTOR_CELL_CLASS,
                        "hidden text-right pharos-numeric sm:table-cell",
                      )}
                    >
                      {row.breadth.toFixed(2)}
                    </TableCell>
                    <TableCell className={cn(CONTRIBUTOR_CELL_CLASS, "text-right pharos-numeric")}>
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
                    </TableCell>
                    <TableCell className="px-0 py-2.5 text-right pharos-numeric">
                      <span className="font-mono text-xs">
                        {row.ageDays < 1 ? "<1d" : `${Math.round(row.ageDays)}d`}
                      </span>
                      {row.factor < 1 && (
                        <span className="ml-1 text-xs text-muted-foreground/70">
                          ({Math.round(row.factor * 100)}%)
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </TableFrame>
          </>
        )}
      </CardContent>
    </Card>
  );
}
