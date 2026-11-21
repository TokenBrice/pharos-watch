"use client";

import Link from "next/link";
import { BookOpen, ExternalLink } from "lucide-react";
import { ChartSkeleton } from "@/components/chart-skeleton";
import { FeatureHeroSplit } from "@/components/feature-hero-split";
import { PageLoadingSplitHero } from "@/components/page-loading-skeleton";
import { RailHeroFigureTransition } from "@/components/view-transitions";
import { MethodologyLabel } from "@/components/methodology-hint";
import { ShowYourWorkToggle } from "@/components/show-your-work-toggle";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { UniverseChip } from "@/components/universe-chip";
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
import { clampScore } from "@shared/lib/math";
import { PSI_CONDITION_BANDS } from "@shared/lib/psi-policy";
import {
  type ConditionBand,
  DEPEG_DIRECTION_CLASSES,
  DIRECTION_TONE_CLASSES,
  PSI_BAND_CLASSES,
  PSI_HEX_COLORS,
} from "@shared/lib/classification";
import { PsiBeamDimmers } from "./psi-beam-dimmers";
import { PsiBeacon } from "@/components/psi-beacon/psi-beacon";
import type { PsiBeaconState } from "@shared/lib/psi-beacon";
import type {
  HistoryStatItem,
  PsiBeamDimmerLane,
  PsiComponentPoint,
  PsiContributorRow,
  PsiEventTimelineRow,
} from "./view-model";

const CONTRIBUTOR_HEAD_CLASS = "h-auto px-0 pb-2 pr-4 text-xs";
const CONTRIBUTOR_CELL_CLASS = "px-0 py-2.5 pr-4";

const REGIME_SCALE_BANDS = [...PSI_CONDITION_BANDS]
  .reverse()
  .map((entry, index, list) => {
    const nextMin = index < list.length - 1 ? list[index + 1]!.min : 100;
    const maxDisplay = index === list.length - 1 ? 100 : nextMin - 1;
    const span = (index === list.length - 1 ? 100 : nextMin) - entry.min;
    return {
      band: entry.band as ConditionBand,
      min: entry.min,
      maxDisplay,
      span,
      rangeLabel: `${entry.min}–${maxDisplay}`,
      color: PSI_HEX_COLORS[entry.band as ConditionBand],
    };
  });

function PsiHistoryStatsGrid({
  items,
  className,
}: {
  items: HistoryStatItem[];
  className?: string;
}) {
  if (items.length === 0) {
    return (
      <div className="py-4 text-center text-sm text-muted-foreground">
        PSI has not computed yet. Check back in 30 minutes.
      </div>
    );
  }

  // The three 30d stats normally share one coverage caption ("29/30 observed
  // days"); print it once under the row instead of three nowrap copies.
  const sharedSub = items.every((item) => item.sub === items[0]?.sub) ? items[0]?.sub ?? null : undefined;

  return (
    <div className={cn("grid grid-cols-3 gap-x-4 gap-y-1.5", className)}>
      {items.map((item) => {
        const color = PSI_BAND_CLASSES[item.band as ConditionBand] ?? "text-foreground";
        return (
          <div key={item.label} className="flex min-w-0 flex-col gap-0.5">
            <span className="pharos-label whitespace-nowrap">{item.label}</span>
            <span className={cn("pharos-numeric text-xl font-bold leading-none sm:text-2xl", color)}>
              {item.value}
            </span>
            {sharedSub === undefined && item.sub ? (
              <span className="whitespace-nowrap text-xs leading-tight text-muted-foreground">{item.sub}</span>
            ) : null}
          </div>
        );
      })}
      {sharedSub ? (
        <span className="col-span-full text-xs leading-tight text-muted-foreground">{sharedSub}</span>
      ) : null}
    </div>
  );
}

function PsiRegimeScaleBar({
  score,
  band,
  scoreBasis,
  instantScore,
  instantBand,
  isCurrent,
}: {
  score: number;
  band: string;
  scoreBasis: string;
  instantScore?: number | null;
  instantBand?: string | null;
  isCurrent: boolean;
}) {
  const markerPct = clampScore(score);
  const instantMarkerPct = instantScore != null ? clampScore(instantScore) : null;
  const bandsDiffer = Boolean(instantBand && instantScore != null && instantBand !== band);

  return (
    <div className="space-y-3" data-testid="psi-regime-scale">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="pharos-label">Regime scale (0–100)</p>
        <p className="text-xs text-muted-foreground">
          {band} ({REGIME_SCALE_BANDS.find((entry) => entry.band === band)?.rangeLabel ?? "0–100"})
        </p>
      </div>

      <div className="relative pt-2">
        <div
          className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted"
          role="img"
          aria-label={`Regime scale from Meltdown (0 to 19) to Bedrock (90 to 100). Current score ${formatScore(score)} (${band}).`}
        >
          {REGIME_SCALE_BANDS.map((segment) => {
            const active = segment.band === band;
            return (
              <div
                key={segment.band}
                className="h-full border-r border-background/80 last:border-r-0"
                style={{
                  width: `${segment.span}%`,
                  backgroundColor: segment.color,
                  opacity: !isCurrent ? 0.35 : active ? 1 : 0.42,
                }}
              />
            );
          })}
        </div>

        {instantMarkerPct != null && Math.abs(instantMarkerPct - markerPct) >= 0.8 ? (
          <span
            aria-hidden="true"
            title={`Instant sample: ${formatScore(instantScore!)}`}
            className="pointer-events-none absolute top-1.5 h-3.5 w-0.5 -translate-x-1/2 rounded-full bg-muted-foreground/80"
            style={{ left: `${instantMarkerPct}%` }}
          />
        ) : null}

        <span
          aria-hidden="true"
          data-testid="psi-regime-scale-marker"
          className="pointer-events-none absolute top-0.5 h-5 w-1 -translate-x-1/2 rounded-full bg-foreground ring-2 ring-background"
          style={{ left: `${markerPct}%` }}
        />
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 sm:grid-cols-3 lg:grid-cols-6">
        {REGIME_SCALE_BANDS.map((segment) => {
          const active = segment.band === band;
          return (
            <div
              key={segment.band}
              className={cn(
                "flex items-center gap-1.5 text-2xs",
                active ? "font-semibold text-foreground" : "text-muted-foreground",
              )}
            >
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: segment.color, opacity: !isCurrent ? 0.45 : active ? 1 : 0.65 }}
                aria-hidden="true"
              />
              <span className="truncate">{segment.band}</span>
              <span className="ml-auto pharos-numeric text-3xs text-muted-foreground">{segment.rangeLabel}</span>
            </div>
          );
        })}
      </div>

      {bandsDiffer && instantScore != null && instantBand ? (
        <p className="text-xs text-muted-foreground" data-testid="psi-band-divergence-note">
          Instant reading is{" "}
          <span className="pharos-numeric font-medium text-foreground">
            {formatScore(instantScore)} ({instantBand})
          </span>
          ; headline tracks the {scoreBasis} ({formatScore(score)}, {band}) to smooth single-sample noise.
        </p>
      ) : null}
    </div>
  );
}

export function StabilityIndexLoadingState() {
  return (
    <div className="space-y-6">
      <PageLoadingSplitHero visualClassName="min-h-[260px]" visualVariant="area" />
      <Card className="rounded-xl">
        <CardHeader>
          <Skeleton className="h-6 w-40" />
        </CardHeader>
        <CardContent>
          <ChartSkeleton variant="area" className="h-[250px] w-full sm:h-[350px]" />
        </CardContent>
      </Card>
      <Card className="rounded-xl">
        <CardHeader>
          <Skeleton className="h-6 w-48" />
        </CardHeader>
        <CardContent>
          <ChartSkeleton variant="area" className="h-[250px] w-full sm:h-[350px]" />
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
  instantScore,
  instantBand,
  delta,
  daysInBand,
  historyStats,
  lanes,
  componentData,
  beaconState,
}: {
  band: string;
  score: number;
  scoreBasis: string;
  instantScore?: number | null;
  instantBand?: string | null;
  delta: number | null;
  daysInBand: number;
  historyStats: HistoryStatItem[];
  lanes: PsiBeamDimmerLane[];
  componentData: PsiComponentPoint[];
  beaconState: PsiBeaconState;
}) {
  const conditionBand = band as ConditionBand;
  // Retained data keeps its number but loses its band hue, matching the beacon and regime bar (R3).
  const isCurrent = beaconState.kind === "current";
  const colorClass = isCurrent ? (PSI_BAND_CLASSES[conditionBand] ?? "text-foreground") : "text-foreground";
  const deltaClass = delta != null && delta >= 0
    ? DIRECTION_TONE_CLASSES.up
    : DIRECTION_TONE_CLASSES.down;

  return (
    <div className="space-y-4" aria-live="polite">
      <FeatureHeroSplit
        ariaLabel="Pharos Stability Index overview"
        mobileSubBeforeVisual
        beamLabel={
          <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <MethodologyLabel topic="psi">PSI</MethodologyLabel>
            <span className="pharos-label">{scoreBasis}</span>
          </span>
        }
        beamValueClassName="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5"
        beamValue={
          <>
            <RailHeroFigureTransition rail="psi">
              <span className={cn("pharos-hero-kpi", colorClass)}>
                {formatScore(score)}
              </span>
            </RailHeroFigureTransition>
            <span className={cn("text-lg font-bold uppercase", colorClass)}>
              {band}
            </span>
          </>
        }
        universe={
          <div className="space-y-2">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-muted-foreground">
              {delta !== null ? (
                <span className={cn("font-medium pharos-numeric", deltaClass)}>
                  {delta >= 0 ? "+" : ""}
                  {delta.toFixed(1)} vs yesterday
                </span>
              ) : null}
              <span>{daysInBand} day{daysInBand !== 1 ? "s" : ""} in {band}</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <UniverseChip universe="psi" />
              <ShowYourWorkToggle />
            </div>
          </div>
        }
        subKicker="30-day range"
        sub={<PsiHistoryStatsGrid items={historyStats} />}
        footer={
          <PsiRegimeScaleBar
            score={score}
            band={band}
            scoreBasis={scoreBasis}
            instantScore={instantScore}
            instantBand={instantBand}
            isCurrent={isCurrent}
          />
        }
      >
        <div className="flex h-full flex-col justify-between gap-3 p-5 sm:p-6 lg:p-7">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="pharos-label">The Beacon</p>
            <span className="pharos-meta">Updated every 30 min</span>
          </div>
          <div className="mx-auto w-full max-w-2xl">
            <PsiBeacon state={beaconState} showComponents={false} />
          </div>
        </div>
      </FeatureHeroSplit>

      <PsiBeamDimmers lanes={lanes} series={componentData} columns={4} density="default" />
    </div>
  );
}

export function PsiEventTimelineCard({
  rows,
  selectedEventLabel = null,
  onSelectEvent,
}: {
  rows: PsiEventTimelineRow[];
  selectedEventLabel?: string | null;
  onSelectEvent?: (event: PsiEventTimelineRow) => void;
}) {
  return (
    <Card className="rounded-xl animate-in fade-in duration-300">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <CardTitle as="h2" className="pharos-label">Notable events</CardTitle>
          {onSelectEvent ? (
            <span className="text-2xs text-muted-foreground">Select an event to focus its window on the chart</span>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>
        <div className="relative ml-3 space-y-4 border-l border-border/50 pl-5">
          {rows.map((event) => {
            const isSelected = selectedEventLabel === event.label;
            return (
              <div
                key={event.label}
                className={cn(
                  "relative min-w-0 rounded-lg px-2.5 py-2 -mx-2.5 transition-colors",
                  isSelected && "bg-muted/60",
                )}
              >
                <span
                  className="absolute -left-[calc(1.25rem-0.625rem+3.5px)] top-[13px] h-[7px] w-[7px] rounded-full ring-2 ring-background"
                  style={{ backgroundColor: event.dotHex }}
                  aria-hidden="true"
                />
                <div className="flex flex-col gap-1">
                  {onSelectEvent ? (
                    <button
                      type="button"
                      onClick={() => onSelectEvent(event)}
                      aria-pressed={isSelected}
                      className="pharos-focus-ring flex w-full flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-sm text-left hover:text-brand-accent-text"
                    >
                      <span className="shrink-0 pharos-numeric text-sm text-muted-foreground">{event.dateStr}</span>
                      <span className="shrink-0 text-sm font-semibold">{event.label}</span>
                      {event.psi !== null ? (
                        <span className={cn("shrink-0 pharos-numeric text-sm font-medium", event.psiColor)}>
                          PSI {formatScore(event.psi)}
                        </span>
                      ) : null}
                      <span className="ml-auto text-2xs text-muted-foreground">
                        {isSelected ? "Focused on chart" : "Focus on chart"}
                      </span>
                    </button>
                  ) : (
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                      <span className="shrink-0 pharos-numeric text-sm text-muted-foreground">{event.dateStr}</span>
                      <span className="shrink-0 text-sm font-semibold">{event.label}</span>
                      {event.psi !== null ? (
                        <span className={cn("shrink-0 pharos-numeric text-sm font-medium", event.psiColor)}>
                          PSI {formatScore(event.psi)}
                        </span>
                      ) : null}
                    </div>
                  )}

                  {event.caseStudies.length > 0 ? (
                    <div className="flex flex-wrap gap-x-4 gap-y-1 min-w-0">
                      {event.caseStudies.map((study) => (
                        <Link
                          key={study.slug}
                          href={study.href}
                          className="pharos-focus-ring inline-flex min-w-0 items-center gap-1.5 rounded-sm text-xs font-medium text-brand-accent-text hover:underline"
                        >
                          <BookOpen className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          <span className="truncate">Case study: {study.title}</span>
                        </Link>
                      ))}
                    </div>
                  ) : null}

                  <div className="flex flex-wrap gap-x-4 min-w-0 overflow-hidden">
                    {event.links.map((link) => (
                      <a
                        key={link.url}
                        href={link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="pharos-focus-ring inline-flex min-w-0 shrink items-center gap-1 rounded-sm text-sm text-brand-accent-text hover:underline"
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
          <CardTitle as="h2" className="pharos-label">Methodology</CardTitle>
          <Badge variant="outline" className="bg-muted/50 text-muted-foreground border-border/60">
            {methodology.versionLabel}
          </Badge>
          {!methodology.isCurrent && (
            <Badge variant="outline" className="bg-state-warn-subtle text-state-warn border-state-warn">
              latest {methodology.currentVersionLabel}
            </Badge>
          )}
          <Link
            href={methodology.changelogPath}
            className="pharos-focus-ring rounded-sm text-xs text-foreground underline underline-offset-4 transition-colors hover:text-brand-accent-text"
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
            className="pharos-focus-ring rounded-sm text-foreground underline underline-offset-4 transition-colors hover:text-brand-accent-text"
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
        <CardTitle as="h2" className="pharos-label">Top contributors</CardTitle>
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
            <p className="mb-4 text-sm text-muted-foreground">
              Stablecoins currently pulling PSI below 100, ranked by total impact. Breadth weights each open incident
              by coin size even when price sits near peg awaiting recovery confirmation; severity weights deviation
              depth. Depegs older than 30 days decay linearly toward a 25% floor (shown in parentheses beside age).
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
                <TableRow rowIntent="static" className="text-left">
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
                  <TableHead scope="col" className="h-auto px-0 pb-2 text-right text-xs">
                    Age
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="text-muted-foreground">
                {rows.map((row, index) => {
                  const recoveryPending = row.driver === "breadth" && Math.abs(row.bps) < 100;
                  return (
                    <TableRow
                      key={row.id}
                      className={cn("hover:bg-muted/30", index === 0 && "bg-state-warn-solid/5")}
                    >
                      <TableCell className={CONTRIBUTOR_CELL_CLASS}>
                        <Link
                          href={buildStablecoinUrl(row.id)}
                          className="pharos-focus-ring flex items-center gap-2 rounded-sm font-medium text-foreground transition-colors hover:text-brand-accent-text"
                        >
                          <StablecoinLogo src={logos?.[row.id]} name={row.symbol} size={22} />
                          <span className="min-w-0 space-y-0.5">
                            <span className="flex flex-wrap items-center gap-1.5">
                              <span className={cn(index === 0 && "font-semibold")}>{row.symbol}</span>
                              {index === 0 ? (
                                <span className="rounded-full bg-state-warn-solid/15 px-1.5 py-0.5 text-3xs font-semibold text-state-warn">
                                  Top
                                </span>
                              ) : null}
                            </span>
                            <span className="flex flex-wrap items-center gap-1.5">
                              <Badge
                                variant="outline"
                                title={
                                  row.driver === "breadth"
                                    ? "Breadth driver: open incident weighted by coin market cap"
                                    : "Severity driver: weighted by current price deviation depth"
                                }
                                className={cn(
                                  "px-1.5 py-0 text-3xs font-medium",
                                  row.driver === "breadth"
                                    ? "border-state-warn/40 bg-state-warn-subtle text-state-warn"
                                    : "border-state-danger/40 bg-state-danger-subtle text-state-danger",
                                )}
                              >
                                {row.driver === "breadth" ? "Breadth" : "Severity"}
                              </Badge>
                              {recoveryPending ? (
                                <span className="text-3xs font-normal text-muted-foreground">
                                  Recovery pending
                                </span>
                              ) : null}
                            </span>
                          </span>
                        </Link>
                      </TableCell>
                      <TableCell
                        className={cn(
                          CONTRIBUTOR_CELL_CLASS,
                          "text-right pharos-numeric",
                          row.bps < 0
                            ? DEPEG_DIRECTION_CLASSES.below.text
                            : DEPEG_DIRECTION_CLASSES.above.text,
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
                        {/* Small-coin severities run ~1e-6–1e-3; a bare 0.00 reads as "no severity". */}
                        {row.severity > 0 && row.severity < 0.005 ? "<0.01" : row.severity.toFixed(2)}
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
                        {row.factor < 1 ? (
                          <span className="ml-1 text-xs text-muted-foreground/70">
                            ({Math.round(row.factor * 100)}%)
                          </span>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </TableFrame>
          </>
        )}
      </CardContent>
    </Card>
  );
}
