"use client";

import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { MethodologyHint, MethodologyLabel } from "@/components/methodology-hint";
import { Badge } from "@/components/ui/badge";
import { DepegResolverRowCard } from "@/components/depeg/depeg-resolver-row-card-parts";
import { getTierMeta } from "@/components/depeg/depeg-resolver-row-card-model";
import {
  compareResolverUrgency,
  isResolverBookAvailable,
  resolveResolverRowIncidentTier,
  summarizeResolverBook,
  type MarketCapById,
  type ResolverBookSummary,
} from "@/components/depeg/depeg-resolver-book-summary";
import { describePromotedAccuracy, formatPromotedAccuracyLines } from "@/lib/ddr-promoted-accuracy";
import { isDepegResolverEnabled } from "@/lib/feature-flags";
import { cn } from "@/lib/utils";
import { OPEN_INCIDENT_TIER_BADGES } from "@shared/lib/classification";
import { formatPercent } from "@shared/lib/format";
import { DDR_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/constants";
import {
  DDR_PUBLIC_WARNING,
  DDR_RESOLUTION_TIER_VALUES,
  type DdrResolutionTier,
  type DdrResponse,
} from "@shared/types/depeg-resolver";
import type { DdrrSummary } from "@shared/types/depeg-resolver-review";
import type { OpenIncidentSnapshot } from "@shared/types/peg";

interface DepegResolverModuleProps {
  data: DdrResponse | undefined;
  logos?: Record<string, string>;
  /** Circulating supply for exposure ranking and the card cap line; undefined while unread. */
  marketCaps?: MarketCapById;
  /** Open confirmed incidents from `/api/peg-summary` for eventId-matched horizon badges and urgency ordering. */
  openIncidents?: Readonly<Record<string, OpenIncidentSnapshot>> | null;
  /** Assessment clock (unix seconds) paired with `openIncidents`. */
  clockSec?: number;
  /** DDRR headline accuracy summary moved from the hero into the resolver header. */
  review?: DdrrSummary | null;
  /** True while the first DDR read is still pending after the route skeleton releases. */
  resolverPending?: boolean;
  /** True while the first DDRR read is still pending after the route skeleton releases. */
  reviewPending?: boolean;
}

/**
 * Forecast cards rendered before the disclosure. The worklist answers "what
 * needs attention now"; the full book is one click away and only mounts then.
 */
const DEFAULT_VISIBLE_ROWS = 4;

interface NormalizedTierSummary {
  tier: DdrResolutionTier;
  count: number;
  label: string;
  accent: string;
  breakdownTitle?: string;
}

/**
 * Collapse mixed v5 (`evidence_class`) and pre-v5 (`legacy`) counts for the
 * same underlying tier into one reader-facing aggregate pill, preserving exact
 * vocabulary counts in the title attribute when both exist. Individual cards
 * keep the exact vocabulary they were locked under.
 */
function normalizeResolverTierSummary(book: ResolverBookSummary): NormalizedTierSummary[] {
  const result: NormalizedTierSummary[] = [];
  for (const tier of DDR_RESOLUTION_TIER_VALUES) {
    const groups = book.tierGroups.filter((group) => group.tier === tier);
    if (groups.length === 0) continue;
    const total = groups.reduce((sum, group) => sum + group.count, 0);
    const hasEvidenceClass = groups.some((group) => group.vocabulary === "evidence_class");
    const primaryVocab = hasEvidenceClass ? "evidence_class" : "legacy";
    const meta = getTierMeta(tier, primaryVocab);
    const breakdownTitle = groups.length > 1
      ? groups
          .map((group) => `${group.count} ${getTierMeta(tier, group.vocabulary).label.toLowerCase()} (${group.vocabulary === "evidence_class" ? "current" : "pre-v5"})`)
          .join(" · ")
      : undefined;
    result.push({
      tier,
      count: total,
      label: meta.label.toLowerCase(),
      accent: meta.accent,
      breakdownTitle,
    });
  }
  return result;
}

function ResolverHeader({
  data,
  book,
  bookAvailable,
  review,
  resolverPending,
  reviewPending,
  summary,
}: {
  data: DdrResponse | undefined;
  book: ResolverBookSummary;
  bookAvailable: boolean;
  review?: DdrrSummary | null;
  resolverPending?: boolean;
  reviewPending?: boolean;
  summary: ReactNode;
}) {
  const lineage = data?._meta.lineage ?? null;
  const versionLabel = data?.methodology.currentVersionLabel ?? DDR_METHODOLOGY_VERSION_LABEL;
  const normalizedTiers = bookAvailable && book.total > 0 ? normalizeResolverTierSummary(book) : [];
  const headline = review?.headline;
  const accuracyPct = headline?.recoveryLikelihoodAccuracyPct ?? null;
  const accuracyLines = review ? formatPromotedAccuracyLines(describePromotedAccuracy(review)) : null;
  const showOutlookBlock = (bookAvailable && book.total > 0) || Boolean(resolverPending);
  const showTrackRecordBlock = Boolean(
    (headline && accuracyLines && headline.recoveryLikelihoodScoredCount > 0) || reviewPending,
  );

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="rounded-md bg-foreground px-1.5 py-0.5 font-mono text-2xs font-bold text-background">
              DDR
            </span>
            <h2 className="pharos-section-title">Depeg Duration Resolver</h2>
            {versionLabel ? (
              <Badge
                variant="outline"
                className="border-border/60 bg-muted/40 px-1.5 py-0 text-3xs font-mono uppercase text-muted-foreground"
              >
                {versionLabel}
              </Badge>
            ) : null}
            <Badge
              variant="outline"
              className="border-state-warn bg-state-warn-subtle px-1.5 py-0 text-3xs uppercase text-state-warn"
            >
              Beta
            </Badge>
            <MethodologyHint topic="ddr" />
          </div>
          {lineage ? (
            <p className="text-2xs text-muted-foreground">
              Calibrated on <span className="pharos-numeric">{lineage.incidentCount.toLocaleString()}</span> historical
              incidents · <span className="pharos-numeric">{lineage.coinCount}</span> coins
              {lineage.quarantinedCoins > 0 ? (
                <>
                  {" ("}
                  <span className="pharos-numeric">{lineage.quarantinedCoins}</span> excluded)
                </>
              ) : null}
            </p>
          ) : null}
        </div>
        <p className="text-pretty text-sm text-muted-foreground">
          Calls whether a live depeg recovers, and how long it takes,{" "}
          <span className="text-foreground">before the event resolves</span>.{" "}
          <span className="text-muted-foreground/70">{DDR_PUBLIC_WARNING}</span>
        </p>
        {summary}
      </div>

      {showOutlookBlock || showTrackRecordBlock ? (
        <div className="pharos-card-shell grid grid-cols-1 divide-y divide-border/60 sm:grid-cols-2 sm:divide-x sm:divide-y-0">
          {showOutlookBlock ? (
            <div className="px-4 py-3">
              <p className="pharos-label">
                <MethodologyLabel topic="ddr" compact>Recovery outlook · DDR</MethodologyLabel>
              </p>
              {bookAvailable && book.total > 0 ? (
                <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  {normalizedTiers.map(({ tier, count, label, accent, breakdownTitle }) => (
                    <span
                      key={tier}
                      title={breakdownTitle}
                      className="inline-flex items-baseline gap-1 text-xs"
                    >
                      <span className={cn("pharos-numeric text-sm font-semibold", accent)}>{count}</span>
                      <span className={accent}>{label}</span>
                    </span>
                  ))}
                </div>
              ) : (
                <p className="pharos-meta mt-1">Loading DDR…</p>
              )}
            </div>
          ) : null}

          {showTrackRecordBlock ? (
            <div className="px-4 py-3">
              <p className="pharos-label">
                <MethodologyLabel topic="ddrr" compact>Forecast track record · DDRR</MethodologyLabel>
              </p>
              {headline && accuracyLines && headline.recoveryLikelihoodScoredCount > 0 ? (
                <>
                  <p className="mt-1 flex flex-wrap items-baseline gap-x-2">
                    <span className="pharos-numeric text-lg font-semibold leading-tight text-foreground">
                      {accuracyPct != null ? formatPercent(accuracyPct * 100, 1) : "—"}
                    </span>
                    <span className="text-xs text-muted-foreground">{accuracyLines.calls}</span>
                  </p>
                  <p className="pharos-meta mt-0.5">
                    {review?.headlineLabel ?? headline.accuracyDenominatorLabel} ·{" "}
                    <a href="#forecast-grading" className="pharos-prose-link">
                      see the grading
                    </a>
                  </p>
                </>
              ) : (
                <p className="pharos-meta mt-1">Loading DDRR…</p>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function DepegResolverModule({
  data,
  logos,
  marketCaps,
  openIncidents,
  clockSec,
  review,
  resolverPending = false,
  reviewPending = false,
}: DepegResolverModuleProps) {
  const [showAll, setShowAll] = useState(false);
  const rows = useMemo(() => data?.rows ?? [], [data]);

  const ordered = useMemo(
    () => [...rows].sort((a, b) => compareResolverUrgency(a, b, marketCaps, { openIncidents, clockSec })),
    [rows, marketCaps, openIncidents, clockSec],
  );
  const book = useMemo(() => summarizeResolverBook(rows), [rows]);

  if (!isDepegResolverEnabled()) return null;

  const bookAvailable = isResolverBookAvailable(data);
  const visible = showAll ? ordered : ordered.slice(0, DEFAULT_VISIBLE_ROWS);
  const hiddenCount = ordered.length - visible.length;

  const summary =
    bookAvailable && rows.length > 0 ? (
      <p className="pharos-meta">
        Whole book · <span className="pharos-numeric text-foreground">{book.total}</span>{" "}
        {book.total === 1 ? "forecast" : "forecasts"} across {book.rowCount} incident rows ·{" "}
        {hiddenCount > 0 ? `showing the ${visible.length} most urgent` : `showing all ${visible.length}`}
        {book.pastPeakCount > 0 ? (
          <span className="text-state-warn">
            {" "}
            · {book.pastPeakCount} at a new worst
          </span>
        ) : null}
      </p>
    ) : null;

  return (
    <section id="recovery-forecast" aria-label="Depeg Duration Resolver" className="scroll-mt-24 space-y-4">
      <ResolverHeader
        data={data}
        book={book}
        bookAvailable={bookAvailable}
        review={review}
        resolverPending={resolverPending}
        reviewPending={reviewPending}
        summary={summary}
      />

      {!data ? (
        <div className="pharos-empty-note text-center">Resolver data is loading.</div>
      ) : !bookAvailable ? (
        <div className="pharos-empty-note text-center">Resolver data is temporarily unavailable.</div>
      ) : rows.length === 0 ? (
        <div className="pharos-empty-note">
          <p className="font-medium text-foreground">No active confirmed depegs.</p>
          <p className="mt-1">
            When Pharos confirms an open depeg, its recovery verdict and, if recovery looks likely, an
            expected-duration band appear here.
          </p>
        </div>
      ) : (
        <>
          <div className="pharos-stagger-entrance grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
            {visible.map((row, i) => {
              const incidentTier = resolveResolverRowIncidentTier(row, openIncidents, clockSec);
              const tierBadge =
                incidentTier === "escalating" || incidentTier === "long_running"
                  ? OPEN_INCIDENT_TIER_BADGES[incidentTier]
                  : null;
              return (
                <div
                  key={`${row.stablecoinId}:${row.eventId}`}
                  data-incident-tier={incidentTier ?? undefined}
                  style={{ "--stagger-index": i } as CSSProperties}
                  className="relative"
                >
                  {tierBadge ? (
                    <span className="pointer-events-auto absolute -top-2.5 right-4 z-10 inline-flex rounded-full bg-background">
                      <span
                        title={
                          incidentTier === "escalating"
                            ? "Re-escalated >30d incident (confirmed within 7d)"
                            : "Open incident older than 30 days"
                        }
                        className={cn(
                          "inline-flex items-center rounded-full border px-2 py-0.5 text-2xs font-semibold leading-none",
                          tierBadge.className,
                        )}
                      >
                        {tierBadge.short}
                      </span>
                    </span>
                  ) : null}
                  <DepegResolverRowCard
                    row={row}
                    logos={logos}
                    marketCapUsd={marketCaps ? marketCaps.get(row.stablecoinId) ?? null : undefined}
                  />
                </div>
              );
            })}
          </div>
          {hiddenCount > 0 || showAll ? (
            <button
              type="button"
              onClick={() => setShowAll((open) => !open)}
              aria-expanded={showAll}
              className="pharos-focus-ring pharos-control-pill"
            >
              {showAll ? `Show only the ${DEFAULT_VISIBLE_ROWS} most urgent` : `Show all ${ordered.length} incident rows`}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}
