"use client";

import { AlertTriangle } from "lucide-react";
import { SafetyGradeBadge } from "@/components/safety-grade-badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import { cn } from "@/lib/utils";
import { DIMENSION_LABELS, DIMENSION_ORDER, getReportCardGradeRank } from "@shared/lib/report-cards";
import { formatBps } from "@shared/lib/format";
import type { DimensionKey, ReportCard, ReportCardGrade } from "@shared/types";

interface MobileRiskSnapshotProps {
  reportCard: ReportCard | null;
}

function gradeRank(grade: ReportCardGrade): number {
  return getReportCardGradeRank(grade) ?? -1;
}

function detailValue(card: ReportCard, label: string): string | null {
  const item = card.dimensions.resilience.detailItems?.find((entry) => entry.label === label);
  return item?.value ?? null;
}

function fallbackTokenLabel(value: string): string {
  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function weakestDimension(card: ReportCard): { key: DimensionKey; label: string; grade: ReportCardGrade } | null {
  const [weakest] = DIMENSION_ORDER
    .map((key) => ({ key, label: DIMENSION_LABELS[key], grade: card.dimensions[key].grade }))
    .sort((a, b) => gradeRank(a.grade) - gradeRank(b.grade));
  return weakest ?? null;
}

export function MobileRiskSnapshot({ reportCard }: MobileRiskSnapshotProps) {
  if (!reportCard) return null;

  const pegDimension = reportCard.dimensions.pegStability;
  const resilienceDimension = reportCard.dimensions.resilience;
  const collateralLabel = detailValue(reportCard, "Collateral") ?? fallbackTokenLabel(reportCard.rawInputs.collateralQuality);
  const custodyLabel = detailValue(reportCard, "Custody") ?? fallbackTokenLabel(reportCard.rawInputs.custodyModel);
  const weakest = weakestDimension(reportCard);
  const activeDepegBps = reportCard.rawInputs.activeDepegBps ?? null;
  const pegLabel = reportCard.rawInputs.activeDepeg
    ? `Active depeg${activeDepegBps != null ? ` ${formatBps(activeDepegBps)}` : ""}`
    : `${pegDimension.grade} peg stability`;
  const caveat = weakest
    ? `${weakest.label} is the lowest dimension at ${weakest.grade}.`
    : "No rated dimension is available yet.";

  return (
    <Card className="pharos-card-shell lg:hidden" aria-labelledby="mobile-risk-snapshot-heading">
      <CardHeader className="pb-1">
        <div className="flex items-center justify-between gap-3">
          <DetailSectionTitle id="mobile-risk-snapshot-heading">Risk Snapshot</DetailSectionTitle>
          <SafetyGradeBadge
            grade={reportCard.overallGrade}
            score={reportCard.overallScore}
            size="sm"
            versionTopic="safetyScore"
            versionVariant="tooltip-only"
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <RiskSnapshotMetric label="Peg state" value={pegLabel} />
          <RiskSnapshotMetric label="Resilience" value={resilienceDimension.grade} mono />
          <RiskSnapshotMetric label="Collateral" value={collateralLabel} className="col-span-2" />
          <RiskSnapshotMetric label="Custody" value={custodyLabel} className="col-span-2" />
        </div>
        <div className="flex gap-2 rounded-lg border border-border/60 bg-background/50 px-3 py-2 text-xs text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden="true" />
          <p className="min-w-0 leading-relaxed">{caveat}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function RiskSnapshotMetric({
  label,
  value,
  mono = false,
  className,
}: {
  label: string;
  value: string;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 rounded-lg border border-border/60 bg-background/45 px-3 py-2", className)}>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={cn("mt-1 min-w-0 truncate text-sm font-medium text-foreground", mono && "font-mono tabular-nums")}>
        {value}
      </p>
    </div>
  );
}
