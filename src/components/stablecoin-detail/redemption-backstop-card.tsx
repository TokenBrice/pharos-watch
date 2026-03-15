"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DETAIL_SECTION_TITLE_CLASS } from "./section-title";
import {
  REDEMPTION_ACCESS_LABELS,
  REDEMPTION_OUTPUT_ASSET_LABELS,
  REDEMPTION_ROUTE_FAMILY_LABELS,
  REDEMPTION_SETTLEMENT_LABELS,
} from "@shared/lib/redemption-backstop-scoring";
import type { RedemptionBackstopEntry } from "@shared/types";
import { formatCurrency } from "@shared/lib/format";
import { MethodologyCardActions, MethodologyLabel } from "@/components/methodology-hint";

function formatCapacityUsd(value: number | null): string | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  return formatCurrency(value, 1);
}

function scoreToneClass(score: number | null): string {
  if (score == null) return "border-border/60 bg-muted/30 text-muted-foreground";
  if (score >= 80) return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
  if (score >= 65) return "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400";
  if (score >= 50) return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400";
  if (score >= 35) return "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-400";
  return "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400";
}

export function RedemptionBackstopCard({
  entry,
}: {
  entry: RedemptionBackstopEntry;
}) {
  const capacityUsd = formatCapacityUsd(entry.immediateCapacityUsd);
  const capacityRatio =
    entry.immediateCapacityRatio != null && Number.isFinite(entry.immediateCapacityRatio)
      ? `${(entry.immediateCapacityRatio * 100).toFixed(1)}% of supply`
      : null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle as="h3" className={DETAIL_SECTION_TITLE_CLASS}>
          <MethodologyLabel topic="redemptionBackstop">Redemption Backstop</MethodologyLabel>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className={`font-mono ${scoreToneClass(entry.score)}`}>
            {entry.score != null ? `${entry.score}/100` : "NR"}
          </Badge>
          {entry.effectiveExitScore != null ? (
            <Badge variant="outline" className="font-mono border-border/60 bg-muted/30">
              <span className="inline-flex items-center gap-1">
                <MethodologyLabel topic="effectiveExit">Exit</MethodologyLabel> {entry.effectiveExitScore}/100
              </span>
            </Badge>
          ) : null}
          <Badge variant="outline" className="border-border/60 bg-muted/30">
            {REDEMPTION_ROUTE_FAMILY_LABELS[entry.routeFamily]}
          </Badge>
          <Badge variant="outline" className="border-border/60 bg-muted/30">
            {entry.sourceMode}
          </Badge>
        </div>

        <div className="grid gap-2 text-sm sm:grid-cols-2">
          <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
            <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
              Access
            </p>
            <p className="mt-1 font-medium">
              {REDEMPTION_ACCESS_LABELS[entry.accessModel]}
            </p>
          </div>
          <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
            <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
              Settlement
            </p>
            <p className="mt-1 font-medium">
              {REDEMPTION_SETTLEMENT_LABELS[entry.settlementModel]}
            </p>
          </div>
          <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
            <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
              Output
            </p>
            <p className="mt-1 font-medium">
              {REDEMPTION_OUTPUT_ASSET_LABELS[entry.outputAssetType]}
            </p>
          </div>
          <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
            <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
              Immediate Capacity
            </p>
            <p className="mt-1 font-medium">
              {capacityUsd ?? "Unavailable"}
              {capacityRatio ? ` · ${capacityRatio}` : ""}
            </p>
          </div>
        </div>

        <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
          <div className="rounded-lg border border-border/60 px-3 py-2">
            Access score <span className="font-mono text-foreground">{entry.accessScore ?? "—"}</span>
          </div>
          <div className="rounded-lg border border-border/60 px-3 py-2">
            Settlement <span className="font-mono text-foreground">{entry.settlementScore ?? "—"}</span>
          </div>
          <div className="rounded-lg border border-border/60 px-3 py-2">
            Execution <span className="font-mono text-foreground">{entry.executionCertaintyScore ?? "—"}</span>
          </div>
          <div className="rounded-lg border border-border/60 px-3 py-2">
            Capacity <span className="font-mono text-foreground">{entry.capacityScore ?? "—"}</span>
          </div>
          <div className="rounded-lg border border-border/60 px-3 py-2">
            Output quality <span className="font-mono text-foreground">{entry.outputAssetQualityScore ?? "—"}</span>
          </div>
          <div className="rounded-lg border border-border/60 px-3 py-2">
            Cost <span className="font-mono text-foreground">{entry.costScore ?? "—"}</span>
            {entry.feeBps != null ? ` (${entry.feeBps} bps)` : ""}
          </div>
        </div>

        {entry.notes && entry.notes.length > 0 ? (
          <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
            {entry.notes.join(". ")}
          </div>
        ) : null}

        {entry.docs?.url ? (
          <a
            href={entry.docs.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex text-sm underline underline-offset-2 transition-colors hover:text-foreground"
          >
            {entry.docs.label ?? "Source"}
          </a>
        ) : null}

        <MethodologyCardActions topic="redemptionBackstop" />
      </CardContent>
    </Card>
  );
}
