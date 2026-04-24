"use client";

import { AlertTriangle, ClipboardCheck } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@shared/lib/format";
import type {
  SafetyInspectionBoardModel,
  SafetyInspectionRow,
  SortDirection,
  SortKey,
} from "./view-model";

function scoreTone(row: SafetyInspectionRow): {
  text: string;
  bar: string;
  panel: string;
  label: string;
} {
  const score = row.weightedScore ?? row.averageScore;
  if (score == null) {
    return {
      text: "text-zinc-700 dark:text-zinc-300",
      bar: "bg-zinc-500",
      panel: "border-zinc-500/30 bg-zinc-500/10",
      label: "Not rated",
    };
  }
  if (score >= 80) {
    return {
      text: "text-emerald-700 dark:text-emerald-300",
      bar: "bg-emerald-500",
      panel: "border-emerald-500/30 bg-emerald-500/10",
      label: "Clean",
    };
  }
  if (score >= 65) {
    return {
      text: "text-sky-700 dark:text-sky-300",
      bar: "bg-sky-500",
      panel: "border-sky-500/30 bg-sky-500/10",
      label: "Watch",
    };
  }
  if (score >= 50) {
    return {
      text: "text-amber-700 dark:text-amber-300",
      bar: "bg-amber-500",
      panel: "border-amber-500/30 bg-amber-500/10",
      label: "Finding",
    };
  }
  return {
    text: "text-red-700 dark:text-red-300",
    bar: "bg-red-500",
    panel: "border-red-500/30 bg-red-500/10",
    label: "Critical",
  };
}

function formatScoreValue(score: number | null): string {
  return score == null ? "NR" : String(score);
}

export function SafetyInspectionBoard({
  model,
  sortKey,
  sortDirection,
  onSortChange,
}: {
  model: SafetyInspectionBoardModel;
  sortKey: SortKey;
  sortDirection: SortDirection;
  onSortChange: (value: SortKey) => void;
}) {
  if (model.rows.length === 0 || !model.leadFinding) return null;

  const leadTone = scoreTone(model.leadFinding);
  const totalFindings = model.rows.reduce((sum, row) => sum + row.findingCount, 0);

  return (
    <Card className="overflow-hidden rounded-xl border-l-[3px] border-l-amber-500">
      <CardContent className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-1">
            <p className="pharos-kicker">Inspection Board</p>
            <h2 className="text-lg font-semibold tracking-tight">Which risk dimension is carrying the weakest load?</h2>
            <p className="max-w-3xl text-sm text-muted-foreground">
              Market-cap-weighted inspection by report-card dimension. Select a dimension to surface weaker cards first.
            </p>
          </div>
          <div className={cn("rounded-xl border px-3 py-2", leadTone.panel)}>
            <div className="flex items-center gap-2">
              <AlertTriangle className={cn("h-4 w-4", leadTone.text)} aria-hidden />
              <span className="text-xs text-muted-foreground">Weakest load</span>
            </div>
            <p className={cn("mt-1 font-mono text-lg font-bold tabular-nums", leadTone.text)}>
              {model.leadFinding.shortLabel} {formatScoreValue(model.leadFinding.weightedScore ?? model.leadFinding.averageScore)}
            </p>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-xl border border-border/60 bg-background/35 p-3">
            <div className="flex items-center gap-2 text-muted-foreground">
              <ClipboardCheck className="h-4 w-4 text-emerald-700 dark:text-emerald-300" aria-hidden />
              <span className="text-[11px] uppercase tracking-wide">Inspected</span>
            </div>
            <p className="mt-1 font-mono text-lg font-bold tabular-nums">{model.inspectedCount}</p>
            <p className="text-xs text-muted-foreground">active report cards</p>
          </div>
          <div className="rounded-xl border border-border/60 bg-background/35 p-3">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Open findings</p>
            <p className="mt-1 font-mono text-lg font-bold tabular-nums text-amber-700 dark:text-amber-300">{totalFindings}</p>
            <p className="text-xs text-muted-foreground">D/F dimension grades</p>
          </div>
          <div className="rounded-xl border border-border/60 bg-background/35 p-3">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Finding exposure</p>
            <p className="mt-1 font-mono text-lg font-bold tabular-nums">{formatCurrency(model.findingExposureUsd, 0)}</p>
            <p className="text-xs text-muted-foreground">unique market cap with any D/F finding</p>
          </div>
        </div>

        <div className="grid gap-3 lg:grid-cols-5">
          {model.rows.map((row) => {
            const tone = scoreTone(row);
            const score = row.weightedScore ?? row.averageScore;
            const active = sortKey === row.key && sortDirection === "asc";
            return (
              <button
                key={row.key}
                type="button"
                onClick={() => onSortChange(row.key)}
                aria-pressed={active}
                aria-label={`Sort report cards by weakest ${row.label} first`}
                className={cn(
                  "pharos-focus-ring min-h-11 rounded-xl border p-3 text-left transition-colors",
                  active ? "border-frost-blue bg-frost-blue/10" : "border-border/60 bg-background/35 hover:bg-muted/30",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-foreground">{row.shortLabel}</p>
                    <p className="text-[11px] text-muted-foreground">{tone.label}</p>
                  </div>
                  <span className={cn("font-mono text-lg font-bold tabular-nums", tone.text)}>
                    {formatScoreValue(score)}
                  </span>
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted/45" aria-hidden="true">
                  <div className={cn("h-full rounded-full", tone.bar)} style={{ width: `${Math.max(score ?? 0, 2)}%` }} />
                </div>
                <div className="mt-3 space-y-1 text-xs text-muted-foreground">
                  <p>
                    <span className="font-mono font-semibold text-foreground">{row.findingCount}</span> findings
                    {row.unknownCount > 0 ? `, ${row.unknownCount} unknown` : ""}
                  </p>
                  <p className="font-mono tabular-nums">{formatCurrency(row.findingExposureUsd, 0)} exposure</p>
                </div>
                {row.worstFindings.length > 0 ? (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {row.worstFindings.map((finding) => (
                      <span
                        key={finding.id}
                        className="rounded-full border border-border/60 bg-card/70 px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
                        title={`${finding.name}: ${finding.grade}`}
                      >
                        {finding.symbol} {finding.grade}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="mt-3 text-[11px] text-muted-foreground">No D/F findings.</p>
                )}
              </button>
            );
          })}
        </div>
        <p className="border-t border-border/60 pt-3 text-xs text-muted-foreground">
          Source: Report Cards plus stablecoin supply. Findings are D/F dimension grades, not forecasts.
        </p>
      </CardContent>
    </Card>
  );
}
