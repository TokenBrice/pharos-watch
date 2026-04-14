import {
  REDEMPTION_ACCESS_LABELS,
  REDEMPTION_OUTPUT_ASSET_LABELS,
  REDEMPTION_ROUTE_FAMILY_LABELS,
  REDEMPTION_SETTLEMENT_LABELS,
} from "@shared/lib/redemption-backstop-scoring";
import { formatCurrency, formatPercent } from "@shared/lib/format";
import type { RedemptionBackstopEntry } from "@shared/types";
import { scoreToColorClass } from "@/lib/severity-colors";

type DocSource = NonNullable<NonNullable<RedemptionBackstopEntry["docs"]>["sources"]>[number];

type FeeSummary = {
  headline: string;
  detail: string;
};

type CapacitySummary = {
  headline: string;
  detail: string;
};

type ScoreBreakdownItem = {
  label: string;
  score: number | null;
  suffix?: string;
  textClass: string;
};

type ScoreBreakdownViewModel = {
  access: ScoreBreakdownItem;
  settlement: ScoreBreakdownItem;
  execution: ScoreBreakdownItem;
  capacity: ScoreBreakdownItem;
  outputQuality: ScoreBreakdownItem;
  cost: ScoreBreakdownItem;
};

type DocSourceViewModel = {
  label: string;
  url: string;
  supports: string | null;
};

function scoreToneClass(score: number | null): string {
  return scoreToColorClass(
    score,
    [
      { min: 80, className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
      { min: 65, className: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400" },
      { min: 50, className: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400" },
      { min: 35, className: "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-400" },
      { min: Number.NEGATIVE_INFINITY, className: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400" },
    ],
    "border-border/60 bg-muted/30 text-muted-foreground",
  );
}

function scoreTextClass(score: number | null): string {
  return scoreToColorClass(score, [
    { min: 80, className: "text-emerald-700 dark:text-emerald-400" },
    { min: 65, className: "text-blue-700 dark:text-blue-400" },
    { min: 50, className: "text-amber-700 dark:text-amber-400" },
    { min: 35, className: "text-orange-700 dark:text-orange-400" },
    { min: Number.NEGATIVE_INFINITY, className: "text-red-700 dark:text-red-400" },
  ]);
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
    case "impaired":
      return "impaired";
  }
  const exhaustiveCheck: never = value;
  return exhaustiveCheck;
}

function formatRouteStatus(value: RedemptionBackstopEntry["routeStatus"]): string {
  switch (value) {
    case "open":
      return "open";
    case "degraded":
      return "degraded";
    case "paused":
      return "paused";
    case "cohort-limited":
      return "cohort limited";
    case "unknown":
      return "status unknown";
  }
  const exhaustiveCheck: never = value;
  return exhaustiveCheck;
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
  const exhaustiveCheck: never = value;
  return exhaustiveCheck;
}

function getResolutionSummary(entry: RedemptionBackstopEntry): string | null {
  if (entry.resolutionState === "resolved") return null;
  if (entry.resolutionState === "missing-cache") {
    return "This route is configured, but the current stablecoins snapshot did not contain the asset, so no usable redemption score could be computed.";
  }
  if (entry.resolutionState === "missing-capacity") {
    return "This route is configured, but the current snapshot could not resolve enough capacity data to produce a usable redemption score.";
  }
  if (entry.resolutionState === "impaired") {
    return (
      entry.routeStatusReason ??
      "This route is configured, but current market or route-availability evidence contradicts broad par redemption. Pharos excludes it from current redemption scoring until live-open evidence returns."
    );
  }
  return "This route is configured, but the current snapshot failed to resolve a usable redemption score.";
}

function getFeeSummary(entry: RedemptionBackstopEntry): FeeSummary {
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
      detail: "Public route docs were reviewed, but they do not publish a bounded numeric redemption fee.",
    };
  }

  return {
    headline: "Variable / not explicitly modeled",
    detail: "No fixed fee is configured in the current model. Actual issuer or protocol fees may vary or be undisclosed.",
  };
}

function getCapacitySummary(entry: RedemptionBackstopEntry): CapacitySummary {
  const capacityUsd =
    entry.immediateCapacityUsd != null &&
    Number.isFinite(entry.immediateCapacityUsd) &&
    entry.immediateCapacityUsd > 0
      ? formatCurrency(entry.immediateCapacityUsd, 1)
      : null;
  const capacityRatio =
    entry.immediateCapacityRatio != null && Number.isFinite(entry.immediateCapacityRatio)
      ? `${(entry.immediateCapacityRatio * 100).toFixed(1)}% of supply`
      : null;

  const capacityEvidence =
    entry.capacityConfidence === "live-direct"
      ? "Live direct redemption telemetry."
      : entry.capacityConfidence === "live-proxy"
        ? "Live proxy liquidity telemetry."
        : entry.capacityConfidence === "documented-bound"
          ? "Reviewed documented redemption bound."
          : entry.capacityConfidence === "dynamic"
            ? "Legacy live-capacity classification."
            : "Heuristic capacity assumption.";

  if (entry.capacitySemantics === "eventual-only") {
    return {
      headline: "Not separately quantified",
      detail: `${capacityEvidence} Modeled as eventual redeemability of current supply, not as an immediate cash buffer.`,
    };
  }

  if (capacityUsd || capacityRatio) {
    return {
      headline: [capacityUsd, capacityRatio].filter(Boolean).join(" · "),
      detail: `${capacityEvidence} Current modeled immediate redeemable capacity.`,
    };
  }

  return {
    headline: "Unavailable",
    detail: `${capacityEvidence} Current snapshot did not produce a usable immediate-capacity estimate.`,
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
  const exhaustiveCheck: never = value;
  return exhaustiveCheck;
}

function formatDocSupports(source: DocSource): string | null {
  if (!source.supports || source.supports.length === 0) return null;
  return source.supports.join(", ");
}

function buildDocSources(entry: RedemptionBackstopEntry): DocSourceViewModel[] {
  const docs = entry.docs ?? null;
  if (docs?.sources && docs.sources.length > 0) {
    return docs.sources.map((source) => ({
      label: source.label,
      url: source.url,
      supports: formatDocSupports(source),
    }));
  }

  if (docs?.url) {
    return [
      {
        label: docs.label ?? "Source",
        url: docs.url,
        supports: null,
      },
    ];
  }

  return [];
}

function buildFilteredNotes(entry: RedemptionBackstopEntry): string[] {
  return (
    entry.notes?.filter(
      (note) => !(entry.capacitySemantics === "eventual-only" && note.toLowerCase().includes("redeemability")),
    ) ?? []
  );
}

export function buildRedemptionBackstopCardViewModel(entry: RedemptionBackstopEntry) {
  const docs = entry.docs ?? null;
  return {
    scoreToneClass: scoreToneClass(entry.score),
    heroScoreLabel: entry.score != null ? `${entry.score}/100` : "NR",
    showExitScore: entry.effectiveExitScore != null,
    exitScoreLabel: entry.effectiveExitScore != null ? `${entry.effectiveExitScore}/100` : null,
    routeFamilyLabel: REDEMPTION_ROUTE_FAMILY_LABELS[entry.routeFamily],
    sourceModeLabel: entry.sourceMode,
    showResolutionStateBadge: entry.resolutionState !== "resolved",
    resolutionStateLabel: formatResolutionState(entry.resolutionState),
    showRouteStatusBadge: entry.routeStatus !== "open",
    routeStatusLabel: formatRouteStatus(entry.routeStatus),
    modelConfidenceLabel: formatModelConfidence(entry.modelConfidence),
    resolutionSummary: getResolutionSummary(entry),
    accessLabel: REDEMPTION_ACCESS_LABELS[entry.accessModel],
    settlementLabel: REDEMPTION_SETTLEMENT_LABELS[entry.settlementModel],
    outputAssetLabel: REDEMPTION_OUTPUT_ASSET_LABELS[entry.outputAssetType],
    capacitySummary: getCapacitySummary(entry),
    feeSummary: getFeeSummary(entry),
    filteredNotes: buildFilteredNotes(entry),
    docSources: buildDocSources(entry),
    docsReviewedAt: docs?.reviewedAt ?? null,
    docsProvenanceLabel: docs?.provenance ? formatDocsProvenance(docs.provenance) : null,
    scoreBreakdown: {
      access: { label: "Access score", score: entry.accessScore, textClass: scoreTextClass(entry.accessScore) },
      settlement: { label: "Settlement", score: entry.settlementScore, textClass: scoreTextClass(entry.settlementScore) },
      execution: {
        label: "Execution",
        score: entry.executionCertaintyScore,
        textClass: scoreTextClass(entry.executionCertaintyScore),
      },
      capacity: { label: "Capacity", score: entry.capacityScore, textClass: scoreTextClass(entry.capacityScore) },
      outputQuality: {
        label: "Output quality",
        score: entry.outputAssetQualityScore,
        textClass: scoreTextClass(entry.outputAssetQualityScore),
      },
      cost: {
        label: "Cost",
        score: entry.costScore,
        textClass: scoreTextClass(entry.costScore),
        suffix: entry.feeBps != null ? ` (${entry.feeBps} bps)` : "",
      },
    } satisfies ScoreBreakdownViewModel,
  };
}
