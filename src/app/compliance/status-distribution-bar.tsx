"use client";

import Link from "next/link";
import type { MouseEvent } from "react";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { cn } from "@/lib/utils";
import { GENIUS_AUTHORIZATION_STATUS_BADGE_STYLES, GENIUS_STATUS_SEGMENT_CLASSES } from "@shared/lib/genius";
import { MICA_STATUS_BADGE_STYLES, MICA_STATUS_SEGMENT_CLASSES } from "@shared/lib/mica";
import type { GeniusAuthorizationStatus, MicaStatus } from "@shared/types/compliance-vocabulary";
import {
  isGeniusAuthorizationStatus,
  isMicaStatus,
  normalizeComplianceRegimeFilter,
  normalizeMicaTokenTypeFilter,
  type ComplianceRegimeFilter,
  type ComplianceStatusDistribution,
} from "@/lib/compliance-model";

function inferRegimeFromFilters(
  rawRegime: string,
  rawStatus: string,
  rawTokenType: string,
): ComplianceRegimeFilter {
  const normalizedRegime = normalizeComplianceRegimeFilter(rawRegime);
  if (rawRegime) return normalizedRegime;
  if (isMicaStatus(rawStatus) || normalizeMicaTokenTypeFilter(rawTokenType) !== "all") return "mica";
  if (isGeniusAuthorizationStatus(rawStatus)) return "genius";
  return normalizedRegime;
}

interface DistributionSegment {
  regime: "mica" | "genius";
  status: MicaStatus | GeniusAuthorizationStatus;
  key: string;
  label: string;
  count: number;
  colorClassName: string;
}

const GENIUS_NEUTRAL_SEGMENT_CLASSES: Partial<Record<GeniusAuthorizationStatus, string>> = {
  "no-public-authorization-found": "bg-muted-foreground/55",
  "not-applicable": "border border-border bg-muted-foreground/20",
  unknown:
    "border border-dashed border-muted-foreground/70 bg-muted/70 bg-[image:repeating-linear-gradient(135deg,var(--border)_0_2px,transparent_2px_5px)]",
};

function buildMicaSegments(distribution: ComplianceStatusDistribution["mica"]): DistributionSegment[] {
  return distribution.map(({ status, count }) => ({
    regime: "mica",
    status,
    key: status,
    label: MICA_STATUS_BADGE_STYLES[status].label,
    count,
    colorClassName:
      status === "out-of-scope"
        ? "border border-border bg-muted-foreground/25"
        : MICA_STATUS_SEGMENT_CLASSES[status],
  }));
}

function buildGeniusSegments(distribution: ComplianceStatusDistribution["genius"]): DistributionSegment[] {
  // Each neutral outcome carries a distinct editorial meaning (R1-R8):
  // negative-evidence review vs out-of-scope vs unresolved unknown.
  return distribution.map(({ status, count }) => ({
    regime: "genius",
    status,
    key: status,
    label: GENIUS_AUTHORIZATION_STATUS_BADGE_STYLES[status].label,
    count,
    colorClassName:
      GENIUS_STATUS_SEGMENT_CLASSES[status] ??
      GENIUS_NEUTRAL_SEGMENT_CLASSES[status] ??
      "border border-border bg-muted-foreground/25",
  }));
}

function StatusDistributionBar({
  label,
  segments,
  activeRegime,
  activeStatus,
  onSelect,
}: {
  label: string;
  segments: DistributionSegment[];
  activeRegime: string;
  activeStatus: string;
  onSelect: (segment: DistributionSegment, isActive: boolean, event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const total = segments.reduce((sum, segment) => sum + segment.count, 0);
  if (total === 0) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs font-semibold text-foreground">{label}</p>
        <p className="pharos-numeric text-2xs text-muted-foreground">{total.toLocaleString()} assessed</p>
      </div>
      <div className="flex h-2.5 w-full gap-[2px] overflow-hidden rounded-full bg-transparent">
        {segments.map((segment) => {
          const isActive = activeRegime === segment.regime && activeStatus === segment.status;
          const href = isActive
            ? `/compliance/?regime=${segment.regime}`
            : `/compliance/?regime=${segment.regime}&status=${segment.status}`;
          const title = `${segment.label}: ${segment.count.toLocaleString()} of ${total.toLocaleString()}`;
          return (
            <Link
              key={segment.key}
              href={href}
              onClick={(event) => onSelect(segment, isActive, event)}
              title={title}
              aria-current={isActive ? "true" : undefined}
              aria-label={
                isActive
                  ? `${title}; clear status filter`
                  : `${title}; filter the compliance tracker`
              }
              data-status={segment.status}
              className={cn(
                "pharos-focus-ring block h-full min-w-[6px] transition-opacity",
                segment.colorClassName,
                activeRegime === segment.regime && activeStatus !== "" && activeStatus !== "all" && !isActive && "opacity-45 hover:opacity-80",
              )}
              style={{ width: `${(segment.count / total) * 100}%` }}
            >
              <span className="sr-only">{title}</span>
            </Link>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {segments.map((segment) => {
          const isActive = activeRegime === segment.regime && activeStatus === segment.status;
          const href = isActive
            ? `/compliance/?regime=${segment.regime}`
            : `/compliance/?regime=${segment.regime}&status=${segment.status}`;
          return (
            <Link
              key={segment.key}
              href={href}
              onClick={(event) => onSelect(segment, isActive, event)}
              aria-current={isActive ? "true" : undefined}
              data-legend-status={segment.status}
              className={cn(
                "pharos-focus-ring inline-flex min-h-8 items-center gap-1.5 rounded-full border px-2 py-0.5 text-2xs transition-colors",
                isActive
                  ? "border-foreground/45 bg-muted/70 font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:border-border/70 hover:bg-muted/40 hover:text-foreground",
              )}
            >
              <span
                className={cn("h-2.5 w-2.5 shrink-0 rounded-full", segment.colorClassName)}
                aria-hidden="true"
              />
              <span>{segment.label}</span>
              <span className="pharos-numeric">{segment.count.toLocaleString()}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

export function ComplianceStatusDistributionBars({
  distribution,
}: {
  distribution: ComplianceStatusDistribution;
}) {
  const { getParam, setParams } = useUrlFilters();
  const activeStatus = getParam("status");
  const activeRegime = inferRegimeFromFilters(getParam("regime"), activeStatus, getParam("type"));

  const handleSelect = (
    segment: DistributionSegment,
    isActive: boolean,
    event: MouseEvent<HTMLAnchorElement>,
  ) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    setParams({
      regime: segment.regime,
      status: isActive ? "all" : segment.status,
      type: "all",
    });
  };

  const micaSegments = buildMicaSegments(distribution.mica);
  const geniusSegments = buildGeniusSegments(distribution.genius);

  return (
    <div className="grid gap-4 border-t border-border/50 px-4 py-3.5 sm:px-5 lg:grid-cols-2">
      <StatusDistributionBar
        label="MiCA"
        segments={micaSegments}
        activeRegime={activeRegime}
        activeStatus={activeStatus}
        onSelect={handleSelect}
      />
      <StatusDistributionBar
        label="GENIUS"
        segments={geniusSegments}
        activeRegime={activeRegime}
        activeStatus={activeStatus}
        onSelect={handleSelect}
      />
    </div>
  );
}
