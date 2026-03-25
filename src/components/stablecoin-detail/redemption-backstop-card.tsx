"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { DETAIL_SECTION_TITLE_CLASS } from "./section-title";
import {
  REDEMPTION_ACCESS_LABELS,
  REDEMPTION_OUTPUT_ASSET_LABELS,
  REDEMPTION_ROUTE_FAMILY_LABELS,
  REDEMPTION_SETTLEMENT_LABELS,
} from "@shared/lib/redemption-backstop-scoring";
import type { RedemptionBackstopEntry } from "@shared/types";
import { formatCurrency, formatPercent } from "@shared/lib/format";
import { MethodologyCardActions, MethodologyLabel } from "@/components/methodology-hint";

function formatCapacityUsd(value: number | null): string | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  return formatCurrency(value, 1);
}

/** Full badge treatment (border + bg + text) for the composite score */
function scoreToneClass(score: number | null): string {
  if (score == null) return "border-border/60 bg-muted/30 text-muted-foreground";
  if (score >= 80) return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
  if (score >= 65) return "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400";
  if (score >= 50) return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400";
  if (score >= 35) return "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-400";
  return "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400";
}

/** Text-only color for sub-score values */
function scoreTextClass(score: number | null): string {
  if (score == null) return "text-muted-foreground";
  if (score >= 80) return "text-emerald-700 dark:text-emerald-400";
  if (score >= 65) return "text-blue-700 dark:text-blue-400";
  if (score >= 50) return "text-amber-700 dark:text-amber-400";
  if (score >= 35) return "text-orange-700 dark:text-orange-400";
  return "text-red-700 dark:text-red-400";
}

function formatResolutionState(value: RedemptionBackstopEntry["resolutionState"]): string {
  switch (value) {
    case "resolved":
      return "resolved";
    case "missing-cache":
      return "missing cache";
    case "missing-capacity":
      return "missing capacity";
    case "failed":
      return "failed";
  }
}

function formatModelConfidence(value: RedemptionBackstopEntry["modelConfidence"]): string {
  switch (value) {
    case "high":
      return "confidence: high";
    case "medium":
      return "confidence: medium";
    case "low":
      return "confidence: low";
  }
}

function getResolutionSummary(entry: RedemptionBackstopEntry): string | null {
  if (entry.resolutionState === "resolved") return null;
  if (entry.resolutionState === "missing-cache") {
    return "This route is configured, but the current stablecoins snapshot did not contain the asset, so no usable redemption score could be computed.";
  }
  if (entry.resolutionState === "missing-capacity") {
    return "This route is configured, but the current snapshot could not resolve enough capacity data to produce a usable redemption score.";
  }
  return "This route is configured, but the current snapshot failed to resolve a usable redemption score.";
}

function getFeeSummary(entry: RedemptionBackstopEntry): {
  headline: string;
  detail: string;
} {
  if (entry.feeBps != null && Number.isFinite(entry.feeBps)) {
    const feeBps = Math.max(0, entry.feeBps);
    return {
      headline: `${feeBps} bps (${formatPercent(feeBps / 100)})`,
      detail:
        entry.feeDescription ??
        (feeBps === 0
          ? "No fixed redemption fee is modeled for this route."
          : "Pharos models this route with a fixed bounded redemption fee."),
    };
  }

  if (entry.feeDescription) {
    return {
      headline: entry.feeDescription,
      detail:
        entry.feeModelKind === "formula"
          ? "Protocol or issuer docs publish a fee formula rather than a single fixed bps rate."
          : entry.feeModelKind === "documented-variable"
            ? "Protocol or issuer docs publish fee logic, but it is variable, conditional, or not a single fixed bps value."
            : "Public route docs were reviewed, but they do not publish a bounded numeric redemption fee.",
    };
  }

  if (entry.feeModelKind === "undisclosed-reviewed") {
    return {
      headline: "Reviewed, but not published",
      detail:
        "Public route docs were reviewed, but they do not publish a bounded numeric redemption fee.",
    };
  }

  return {
    headline: "Variable / not explicitly modeled",
    detail:
      "No fixed fee is configured in the current model. Actual issuer or protocol fees may vary or be undisclosed.",
  };
}

function getCapacitySummary(entry: RedemptionBackstopEntry): {
  headline: string;
  detail: string;
} {
  const capacityUsd = formatCapacityUsd(entry.immediateCapacityUsd);
  const capacityRatio =
    entry.immediateCapacityRatio != null && Number.isFinite(entry.immediateCapacityRatio)
      ? `${(entry.immediateCapacityRatio * 100).toFixed(1)}% of supply`
      : null;

  if (entry.capacitySemantics === "eventual-only") {
    return {
      headline: "Not separately quantified",
      detail: "Modeled as eventual redeemability of current supply, not as an immediate cash buffer.",
    };
  }

  if (capacityUsd || capacityRatio) {
    return {
      headline: [capacityUsd, capacityRatio].filter(Boolean).join(" · "),
      detail: "Current modeled immediate redeemable capacity.",
    };
  }

  return {
    headline: "Unavailable",
    detail: "Current snapshot did not produce a usable immediate-capacity estimate.",
  };
}

function formatDocsProvenance(value: NonNullable<NonNullable<RedemptionBackstopEntry["docs"]>["provenance"]>): string {
  switch (value) {
    case "config-reviewed":
      return "Reviewed route source";
    case "live-reserve-display":
      return "Fallback live reserve source";
    case "proof-of-reserves":
      return "Fallback proof-of-reserves source";
    case "preferred-link":
      return "Fallback project link";
  }
}

function formatDocSupports(source: NonNullable<NonNullable<RedemptionBackstopEntry["docs"]>["sources"]>[number]): string | null {
  if (!source.supports || source.supports.length === 0) return null;
  return source.supports.join(", ");
}

export function RedemptionBackstopCard({
  entry,
}: {
  entry: RedemptionBackstopEntry;
}) {
  const feeSummary = getFeeSummary(entry);
  const capacitySummary = getCapacitySummary(entry);
  const resolutionSummary = getResolutionSummary(entry);
  const docs = entry.docs ?? null;
  const docSources = docs?.sources && docs.sources.length > 0
    ? docs.sources
    : docs?.url
      ? [{ label: docs.label ?? "Source", url: docs.url }]
      : [];

  // Filter notes that are redundant with the capacity detail (distill)
  const filteredNotes = entry.notes?.filter(
    (note) => !(entry.capacitySemantics === "eventual-only" && note.toLowerCase().includes("redeemability")),
  ) ?? [];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle as="h2" className={DETAIL_SECTION_TITLE_CLASS}>
          <MethodologyLabel topic="redemptionBackstop">Redemption Backstop</MethodologyLabel>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* ── arrange: Hero score + Exit, separated from metadata ── */}
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
          <Badge variant="outline" className={cn("px-2.5 py-1 font-mono text-lg", scoreToneClass(entry.score))}>
            {entry.score != null ? `${entry.score}/100` : "NR"}
          </Badge>
          {entry.effectiveExitScore != null && (
            <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <MethodologyLabel topic="effectiveExit">Exit</MethodologyLabel>
              <span className="font-mono text-foreground">{entry.effectiveExitScore}/100</span>
            </span>
          )}
        </div>

        {/* ── arrange: Classification + metadata badges (secondary) ── */}
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="border-border/60 bg-muted/30 text-xs">
            {REDEMPTION_ROUTE_FAMILY_LABELS[entry.routeFamily]}
          </Badge>
          <Badge variant="outline" className="border-border/60 bg-muted/30 text-xs">
            {entry.sourceMode}
          </Badge>
          {entry.resolutionState !== "resolved" && (
            <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-xs text-amber-700 dark:text-amber-300">
              {formatResolutionState(entry.resolutionState)}
            </Badge>
          )}
          <Badge variant="outline" className="border-border/60 bg-muted/30 text-xs">
            {formatModelConfidence(entry.modelConfidence)}
          </Badge>
        </div>

        {resolutionSummary ? (
          <div className="rounded-lg border border-amber-500/25 bg-amber-500/8 px-3 py-2 text-sm text-muted-foreground">
            {resolutionSummary}
          </div>
        ) : null}

        {/* ── distill: Route properties as compact inline row ── */}
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <div>
            <span className="text-xs uppercase tracking-[0.12em] text-muted-foreground">Access </span>
            <span className="font-medium">{REDEMPTION_ACCESS_LABELS[entry.accessModel]}</span>
          </div>
          <div>
            <span className="text-xs uppercase tracking-[0.12em] text-muted-foreground">Settlement </span>
            <span className="font-medium">{REDEMPTION_SETTLEMENT_LABELS[entry.settlementModel]}</span>
          </div>
          <div>
            <span className="text-xs uppercase tracking-[0.12em] text-muted-foreground">Output </span>
            <span className="font-medium">{REDEMPTION_OUTPUT_ASSET_LABELS[entry.outputAssetType]}</span>
          </div>
        </div>

        {/* ── Capacity card (earns the card treatment — has detail) ── */}
        <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
          <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
            Immediate Capacity
          </p>
          <p className="mt-1 text-sm font-medium">{capacitySummary.headline}</p>
          <p className="mt-1 text-xs text-muted-foreground">{capacitySummary.detail}</p>
        </div>

        {/* ── Fee card (earns the card treatment — has detail) ── */}
        <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
          <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
            Redemption Fee
          </p>
          <p className="mt-1 text-sm font-medium">{feeSummary.headline}</p>
          <p className="mt-1 text-xs text-muted-foreground">{feeSummary.detail}</p>
        </div>

        {/* ── colorize + distill: Sub-scores collapsed with color ── */}
        <details className="group">
          <summary className="pharos-focus-ring inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-md text-sm text-muted-foreground [&::-webkit-details-marker]:hidden lg:min-h-9">
            <span className="underline decoration-dashed underline-offset-2">Scoring breakdown</span>
            <ChevronDown aria-hidden="true" className="h-3 w-3 transition-transform group-open:rotate-180" />
          </summary>
          <div className="mt-2 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
            <div className="rounded-lg border border-border/60 px-3 py-2">
              Access score <span className={cn("font-mono", scoreTextClass(entry.accessScore))}>{entry.accessScore ?? "—"}</span>
            </div>
            <div className="rounded-lg border border-border/60 px-3 py-2">
              Settlement <span className={cn("font-mono", scoreTextClass(entry.settlementScore))}>{entry.settlementScore ?? "—"}</span>
            </div>
            <div className="rounded-lg border border-border/60 px-3 py-2">
              Execution <span className={cn("font-mono", scoreTextClass(entry.executionCertaintyScore))}>{entry.executionCertaintyScore ?? "—"}</span>
            </div>
            <div className="rounded-lg border border-border/60 px-3 py-2">
              Capacity <span className={cn("font-mono", scoreTextClass(entry.capacityScore))}>{entry.capacityScore ?? "—"}</span>
            </div>
            <div className="rounded-lg border border-border/60 px-3 py-2">
              Output quality <span className={cn("font-mono", scoreTextClass(entry.outputAssetQualityScore))}>{entry.outputAssetQualityScore ?? "—"}</span>
            </div>
            <div className="rounded-lg border border-border/60 px-3 py-2">
              Cost <span className={cn("font-mono", scoreTextClass(entry.costScore))}>{entry.costScore ?? "—"}</span>
              {entry.feeBps != null ? ` (${entry.feeBps} bps)` : ""}
            </div>
          </div>
        </details>

        {/* ── distill: Notes (filtered for redundancy with capacity) ── */}
        {filteredNotes.length > 0 ? (
          <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
            {filteredNotes.join(". ")}
          </div>
        ) : null}

        {docSources.length > 0 ? (
          <div className="space-y-1">
            {docSources.map((source) => {
              const supports = formatDocSupports(source);
              return (
                <div key={`${source.label}:${source.url}`} className="text-sm">
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex underline underline-offset-2 transition-colors hover:text-foreground"
                  >
                    {source.label}
                  </a>
                  {supports ? (
                    <span className="ml-2 text-xs text-muted-foreground">Supports {supports}</span>
                  ) : null}
                </div>
              );
            })}
            {docs?.reviewedAt ? (
              <p className="text-xs text-muted-foreground">Reviewed {docs.reviewedAt}</p>
            ) : docs?.provenance ? (
              <p className="text-xs text-muted-foreground">{formatDocsProvenance(docs.provenance)}</p>
            ) : null}
          </div>
        ) : null}

        <MethodologyCardActions topic="redemptionBackstop" />
      </CardContent>
    </Card>
  );
}
