"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EvidenceFooter } from "@/components/stablecoin-detail/evidence-footer";
import { FactGrid, type FactGridItem } from "@/components/stablecoin-detail/fact-grid";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
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
 * Renders nothing while the review query is in flight and for coins the feed
 * carries no reviewed publication for.
 */
export function DdrTrackRecordSection({ stablecoinId }: { stablecoinId: string }) {
  const enabled = isDepegResolverEnabled() && isDepegResolverReviewerEnabled();
  const { data } = useDepegResolverReview({ enabled });
  const record = enabled ? projectDdrTrackRecordSummary(data, stablecoinId) : null;
  if (!record) return null;

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
        <DetailSectionTitle className={DETAIL_MODULE_TITLE_CLASS}>DDR track record</DetailSectionTitle>
        <Badge variant="outline" className={cn("text-[11px] font-medium", record.chipToneClass)}>
          {record.chipLabel}
        </Badge>
      </CardHeader>
      <CardContent className={cn(DETAIL_MODULE_BODY_CLASS, "space-y-4")}>
        <p className="text-sm leading-relaxed text-muted-foreground">{record.lede}</p>
        <FactGrid aria-label="DDR track record facts" items={facts} />
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
        <EvidenceFooter trailing={record.reviewedAt ? `Reviewed ${record.reviewedAt}` : undefined}>
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
