"use client";

import { AlertTriangle } from "lucide-react";
import { SafetyGradeBadge } from "@/components/safety-grade-badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import { cn } from "@/lib/utils";
import type { V9ConsumerCard } from "@/lib/safety-score-v9-consumers";

interface MobileRiskSnapshotProps {
  reportCard: V9ConsumerCard | null;
}

export function MobileRiskSnapshot({ reportCard }: MobileRiskSnapshotProps) {
  if (!reportCard) return null;

  const weakest = reportCard.weakestPillar;
  const caveat = weakest
    ? `${weakest.pillar} is the weakest pillar at ${weakest.score.toFixed(0)} / 100.`
    : "No rated pillar is available yet.";
  const pillarValue = (score: number | null) => score === null ? "NR" : `${score.toFixed(0)} / 100`;

  return (
    <Card className="pharos-card-shell lg:hidden" aria-labelledby="mobile-risk-snapshot-heading">
      <CardHeader className="pb-1">
        <div className="flex items-center justify-between gap-3">
          <DetailSectionTitle id="mobile-risk-snapshot-heading">Risk Snapshot</DetailSectionTitle>
          <SafetyGradeBadge
            grade={reportCard.grade}
            score={reportCard.score}
            size="sm"
            versionTopic="safetyScore"
            versionVariant="tooltip-only"
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <RiskSnapshotMetric label="Backing" value={pillarValue(reportCard.pillars.backing.score)} mono />
          <RiskSnapshotMetric label="Exit" value={pillarValue(reportCard.pillars.exit.score)} mono />
          <RiskSnapshotMetric
            label="Economic control"
            value={pillarValue(reportCard.pillars.control.score)}
            className="col-span-2"
            mono
          />
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
