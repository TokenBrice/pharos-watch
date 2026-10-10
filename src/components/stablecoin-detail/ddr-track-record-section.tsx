"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { QueryStateNotice } from "@/components/query-state-notice";
import { EvidenceFooter } from "@/components/stablecoin-detail/evidence-footer";
import { FactGrid, type FactGridItem } from "@/components/stablecoin-detail/fact-grid";
import { StablecoinModuleTitle } from "@/components/stablecoin-detail/module-title";
import {
  DETAIL_MODULE_BODY_CLASS,
  DETAIL_MODULE_HEADER_CLASS,
  DETAIL_MODULE_SHELL_CLASS,
  DETAIL_MODULE_TITLE_CLASS,
  SECTION_SCROLL_MT,
} from "@/components/stablecoin-detail/section-title-class";
import { useDepegResolverReview } from "@/hooks/api-hooks";
import { isDepegResolverEnabled, isDepegResolverReviewerEnabled } from "@/lib/feature-flags";
import {
  projectDdrTrackRecordSummary,
  type DdrTrackRecordIncidentRow,
} from "@/lib/stablecoin-detail-ddr-track-record-client";
import { cn } from "@/lib/utils";

function IncidentRow({ incident }: { incident: DdrTrackRecordIncidentRow }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border/50 bg-background/40 px-3 py-2.5">
      <span className="font-mono text-[11px] tabular-nums text-foreground">{incident.dateLabel}</span>
      <Badge variant="outline" className={cn("text-[11px]", incident.outcomeToneClass)}>
        {incident.outcomeLabel}
      </Badge>
      <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
        {incident.actualOutcomeLabel}
      </span>
      {incident.erratumLabel ? (
        <span className="font-mono text-[10px] uppercase tracking-wide text-amber-700 dark:text-amber-400">
          {incident.erratumLabel}
        </span>
      ) : null}
      <span className="ml-auto font-mono text-[11px] tabular-nums text-muted-foreground">
        {incident.durationLabel}
      </span>
    </li>
  );
}

/**
 * The accountability trail for this coin's depeg forecasts: every frozen,
 * first-published DDR prediction graded by DDRR against what actually happened,
 * plus the incidents that carried no published call.
 *
 * Deliberately a ledger, not a forecast timeline — the detail page's DDR card
 * owns the forward-looking language; this module is the track record behind it.
 * Healthy empty feeds and in-flight reads are omitted; unavailable or retained
 * stale evidence remains visibly qualified.
 */
export function DdrTrackRecordSection({ stablecoinId }: { stablecoinId: string }) {
  const enabled = isDepegResolverEnabled() && isDepegResolverReviewerEnabled();
  const query = useDepegResolverReview({ enabled });
  const { data } = query;
  const record = enabled ? projectDdrTrackRecordSummary(data, stablecoinId) : null;
  if (!enabled) return null;
  const degraded = data?._meta?.degraded === true;
  const summaryUnavailable = data != null && data.summary.byStablecoin == null;
  const unavailable = query.error != null || degraded || summaryUnavailable;
  if (!record) {
    if (!unavailable) return null;
    return (
      <section id="ddr-track-record" aria-label="DDR track record" className={SECTION_SCROLL_MT}>
        <QueryStateNotice state="unavailable" label="DDR track record" onRetry={() => void query.refetch()} />
        {degraded || summaryUnavailable ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Snapshot reason: {data?._meta?.degradedReason ?? "coin-summary-unavailable"}
          </p>
        ) : null}
      </section>
    );
  }
  const limitedPopulation = data?._meta?.incidentRowsTruncated === true;

  const facts: FactGridItem[] = [
    { key: "forecasts", label: "Forecasts", value: String(record.reviewedForecastCount) },
    ...(record.scoredCount > 0
      ? [{ key: "correct", label: "Correct", value: `${record.correctCount}/${record.scoredCount}` }]
      : []),
    ...(record.medianAbsoluteDurationErrorLabel != null
      ? [
          {
            key: "median-miss",
            label: "Median miss",
            value: record.medianAbsoluteDurationErrorLabel,
            title: `Median absolute duration error across ${record.durationScoredCount} scored duration calls`,
          },
        ]
      : []),
    ...(record.pendingCount > 0
      ? [{ key: "pending", label: "Maturing", value: String(record.pendingCount) }]
      : []),
    ...(record.noCallCount > 0
      ? [{ key: "no-calls", label: "No-calls", value: String(record.noCallCount) }]
      : []),
    ...(record.notCalledCount > 0
      ? [{ key: "not-called", label: "Not called", value: String(record.notCalledCount) }]
      : []),
    ...(record.invalidatedCount > 0
      ? [{ key: "invalidated", label: "Invalidated", value: String(record.invalidatedCount) }]
      : []),
  ];

  return (
    <Card id="ddr-track-record" className={cn(DETAIL_MODULE_SHELL_CLASS, SECTION_SCROLL_MT)}>
      <CardHeader className={DETAIL_MODULE_HEADER_CLASS}>
        <StablecoinModuleTitle className={DETAIL_MODULE_TITLE_CLASS}>DDR track record</StablecoinModuleTitle>
        <Badge variant="outline" className={cn("text-[11px] font-medium", limitedPopulation ? "text-muted-foreground" : record.chipToneClass)}>
          {limitedPopulation ? "Partial coverage" : record.chipLabel}
        </Badge>
      </CardHeader>
      <CardContent className={cn(DETAIL_MODULE_BODY_CLASS, "space-y-4")}>
        {unavailable ? (
          <QueryStateNotice
            state="stale-with-data"
            label="DDR track record"
            dataUpdatedAt={(data?._meta?.computedAt ?? 0) * 1000}
            onRetry={() => void query.refetch()}
          />
        ) : null}
        {degraded ? (
          <p className="text-xs text-muted-foreground">Snapshot reason: {data?._meta?.degradedReason ?? "degraded"}</p>
        ) : null}
        <p className="text-sm leading-relaxed text-muted-foreground">
          {limitedPopulation ? "The reviewed incident cohort is incomplete; track-record aggregates are withheld." : record.lede}
        </p>
        {!limitedPopulation ? <FactGrid aria-label="DDR track record facts" items={facts} /> : null}
        {record.incidentSampleIncomplete ? (
          <p className="text-xs text-muted-foreground">
            The public incident sample is incomplete; forecast statistics use the producer&apos;s full reviewed cohort.
          </p>
        ) : null}
        <ul aria-label="Reviewed depeg incidents" className="space-y-2">
          {record.incidents.map((incident) => (
            <IncidentRow key={incident.key} incident={incident} />
          ))}
        </ul>
        {record.hiddenIncidentCount > 0 ? (
          <p className="px-1 font-mono text-[11px] text-muted-foreground">
            +{record.hiddenIncidentCount} more reviewed incidents
          </p>
        ) : null}
        <p className="text-xs leading-relaxed text-muted-foreground">{record.publicWarning}</p>
        <EvidenceFooter reviewed={record.reviewedAt ?? undefined}>
          <Link
            href="/depeg"
            className="pharos-focus-ring rounded-sm underline decoration-dashed underline-offset-2 hover:text-foreground"
          >
            Full DDRR review
          </Link>
        </EvidenceFooter>
      </CardContent>
    </Card>
  );
}
