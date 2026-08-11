import {
  REDEMPTION_ACCESS_LABELS,
  REDEMPTION_OUTPUT_ASSET_LABELS,
  REDEMPTION_SETTLEMENT_LABELS,
} from "@shared/lib/redemption-backstop-scoring";
import { formatCurrency, formatPercent } from "@shared/lib/format";
import { formatRelativeDurationSeconds } from "@shared/lib/relative-time";
import type { RedemptionBackstopEntry } from "@shared/types";
import {
  formatRedemptionDocsProvenance,
  formatRedemptionModelConfidence,
  formatRedemptionResolutionState,
  formatRedemptionRouteFamily,
  formatRedemptionRouteStatus,
} from "@/lib/redemption-backstop-labels";
import { scoreToColorClass } from "@/lib/severity-colors";

type DocSource = NonNullable<NonNullable<RedemptionBackstopEntry["docs"]>["sources"]>[number];

type FeeSummary = {
  headline: string;
  detail: string;
};

type CapacitySummary = {
  title: string;
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

type TelemetryContextItem = {
  label: string;
  value: string;
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
    if (entry.feeModelKind === "formula") {
      return {
        headline: `${feeBps} bps current (${formatPercent(feeBps / 100)})`,
        detail: entry.feeDescription
          ? `${entry.feeDescription} Current live telemetry resolved this formula to the displayed bps value.`
          : "Protocol or issuer docs publish a fee formula; current live telemetry resolved it to the displayed bps value.",
      };
    }

    if (entry.feeModelKind === "documented-variable") {
      return {
        headline: `${feeBps} bps current (${formatPercent(feeBps / 100)})`,
        detail: entry.feeDescription
          ? `${entry.feeDescription} Current telemetry resolved this variable fee to the displayed bps value.`
          : "Protocol or issuer docs publish variable fee logic; current telemetry resolved it to the displayed bps value.",
      };
    }

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
    detail:
      "No fixed fee is configured in the current model. Actual issuer or protocol fees may vary or be undisclosed.",
  };
}

function getCapacitySummary(entry: RedemptionBackstopEntry): CapacitySummary {
  const scoringHorizon = entry.capacityProfile?.scoringHorizon;
  const title =
    scoringHorizon === "daily"
      ? "Daily Capacity"
      : scoringHorizon === "queued"
        ? "Queued Capacity"
        : scoringHorizon === "eventual" || entry.capacitySemantics === "eventual-only"
          ? "Eventual Redeemability"
          : "Immediate Capacity";
  const scoringCapacityUsd =
    entry.capacityProfile?.scoringUsd != null &&
    Number.isFinite(entry.capacityProfile.scoringUsd) &&
    entry.capacityProfile.scoringUsd > 0
      ? formatCurrency(entry.capacityProfile.scoringUsd, 1)
      : null;
  const immediateCapacityUsd =
    entry.immediateCapacityUsd != null && Number.isFinite(entry.immediateCapacityUsd) && entry.immediateCapacityUsd > 0
      ? formatCurrency(entry.immediateCapacityUsd, 1)
      : null;
  const usesScoringCapacityHeadline =
    (scoringHorizon === "daily" || scoringHorizon === "queued") && scoringCapacityUsd != null;
  const capacityUsd = usesScoringCapacityHeadline ? scoringCapacityUsd : (immediateCapacityUsd ?? scoringCapacityUsd);
  const capacityRatio =
    !usesScoringCapacityHeadline &&
    entry.immediateCapacityRatio != null &&
    Number.isFinite(entry.immediateCapacityRatio)
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
      title,
      headline: "Not separately quantified",
      detail: `${capacityEvidence} Modeled as eventual redeemability of current supply, not as an immediate cash buffer.`,
    };
  }

  if (capacityUsd || capacityRatio) {
    const horizonDetail =
      scoringHorizon === "daily"
        ? " Current modeled capacity is daily-limited."
        : scoringHorizon === "queued"
          ? " Current modeled capacity is queue-limited."
          : scoringHorizon === "eventual"
            ? " Capacity is modeled as eventual redeemability rather than current same-size liquidity."
            : " Current modeled immediate redeemable capacity.";
    return {
      title,
      headline: [capacityUsd, capacityRatio].filter(Boolean).join(" · "),
      detail: `${capacityEvidence}${horizonDetail}`,
    };
  }

  return {
    title,
    headline: "Unavailable",
    detail: `${capacityEvidence} Current snapshot did not produce a usable immediate-capacity estimate.`,
  };
}

function formatTelemetryKind(value: string): string {
  return value.replaceAll("-", " ");
}

function formatScoreOutOf100(value: number): string {
  return `${Math.round(value)}/100`;
}

function buildTelemetryContext(entry: RedemptionBackstopEntry): TelemetryContextItem[] {
  const items: TelemetryContextItem[] = [];
  if (entry.capacityProfile) {
    items.push({ label: "Horizon", value: formatTelemetryKind(entry.capacityProfile.scoringHorizon) });
    items.push({
      label: "Profile confidence",
      value: formatTelemetryKind(entry.capacityProfile.capacityProfileConfidence),
    });
    if (entry.capacityProfile.scoringUsd != null) {
      items.push({ label: "Scoring capacity", value: formatCurrency(entry.capacityProfile.scoringUsd, 1) });
    }
    if (entry.capacityProfile.eventualUsd != null) {
      items.push({ label: "Eventual capacity", value: formatCurrency(entry.capacityProfile.eventualUsd, 1) });
    }
    if (entry.capacityProfile.queuedUsd != null) {
      items.push({ label: "Queued capacity", value: formatCurrency(entry.capacityProfile.queuedUsd, 1) });
    }
    if (entry.capacityProfile.modeledExitSizeUsd != null) {
      items.push({ label: "Modeled exit", value: formatCurrency(entry.capacityProfile.modeledExitSizeUsd, 1) });
    }
  }
  if (entry.eventualRedeemabilityScore != null) {
    items.push({ label: "Eventual score", value: formatScoreOutOf100(entry.eventualRedeemabilityScore) });
  }
  if (entry.capacityKind) {
    items.push({ label: "Capacity evidence", value: formatTelemetryKind(entry.capacityKind) });
  }
  if (entry.freshnessKind) {
    items.push({ label: "Freshness", value: formatTelemetryKind(entry.freshnessKind) });
  }
  if (entry.settlementDelaySec != null) {
    items.push({
      label: "Live delay",
      value: formatRelativeDurationSeconds(entry.settlementDelaySec, {
        rounding: "round",
        dayThresholdSec: 48 * 3600,
      }),
    });
  }
  if (entry.queueDepthUsd != null) {
    items.push({ label: "Queue depth", value: formatCurrency(entry.queueDepthUsd, 1) });
  }
  if (entry.dailyLimitUsd != null) {
    items.push({ label: "Daily limit", value: formatCurrency(entry.dailyLimitUsd, 1) });
  }
  if (entry.minRedeemUsd != null) {
    items.push({ label: "Minimum redeem", value: formatCurrency(entry.minRedeemUsd, 1) });
  }
  if (entry.liveHolderEligibility) {
    items.push({ label: "Live eligibility", value: formatTelemetryKind(entry.liveHolderEligibility) });
  }
  return items;
}

function buildCostScenarioContext(entry: RedemptionBackstopEntry): TelemetryContextItem[] {
  const scenarios = entry.costScenarioScores;
  if (!scenarios) return [];
  return [
    scenarios.retail != null ? { label: "Retail cost", value: formatScoreOutOf100(scenarios.retail) } : null,
    scenarios.activeUser != null ? { label: "Active-user cost", value: formatScoreOutOf100(scenarios.activeUser) } : null,
    scenarios.institutional != null
      ? { label: "Institutional cost", value: formatScoreOutOf100(scenarios.institutional) }
      : null,
  ].filter((item): item is TelemetryContextItem => item != null);
}

function buildConfidenceContext(entry: RedemptionBackstopEntry): TelemetryContextItem[] {
  const details = entry.confidenceDetails;
  if (!details) return [];
  const items: TelemetryContextItem[] = [
    { label: "Capacity evidence", value: formatScoreOutOf100(details.capacityEvidenceQuality) },
    { label: "Fee evidence", value: formatScoreOutOf100(details.feeEvidenceQuality) },
    { label: "Route freshness", value: formatScoreOutOf100(details.routeStatusFreshness) },
    { label: "Holder breadth", value: formatScoreOutOf100(details.holderCohortBreadth) },
    { label: "Source quality", value: formatScoreOutOf100(details.sourceQuality) },
  ];
  if (details.reviewedDocAgeDays != null) {
    items.push({ label: "Reviewed docs age", value: `${Math.round(details.reviewedDocAgeDays)}d` });
  }
  return items;
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

function feeBpsBreakdownSuffix(entry: RedemptionBackstopEntry): string {
  if (entry.feeBps == null || !Number.isFinite(entry.feeBps)) return "";
  if (entry.feeModelKind === "formula") return ` (${entry.feeBps} bps current)`;
  if (entry.feeModelKind === "documented-variable") return ` (${entry.feeBps} bps current)`;
  return ` (${entry.feeBps} bps)`;
}

/**
 * `entry.sourceMode` is a raw enum value; rendering it straight put lowercase
 * chips (`estimated`) next to Title Case ones on the same row.
 */
const SOURCE_MODE_LABELS: Record<RedemptionBackstopEntry["sourceMode"], string> = {
  dynamic: "Dynamic",
  estimated: "Estimated",
  static: "Static",
};

export function buildRedemptionBackstopCardViewModel(entry: RedemptionBackstopEntry) {
  const docs = entry.docs ?? null;
  return {
    title: entry.routeFamily === "offchain-issuer" ? "Issuer redemption route" : "Redemption route",
    scoreToneClass: scoreToneClass(entry.score),
    heroScoreLabel: entry.score != null ? `${entry.score}/100` : "NR",
    routeFamilyLabel: formatRedemptionRouteFamily(entry.routeFamily),
    sourceModeLabel: SOURCE_MODE_LABELS[entry.sourceMode],
    showResolutionStateBadge: entry.resolutionState !== "resolved",
    resolutionStateLabel: formatRedemptionResolutionState(entry.resolutionState),
    showRouteStatusBadge: entry.routeStatus !== "open",
    routeStatusLabel: formatRedemptionRouteStatus(entry.routeStatus),
    modelConfidenceLabel: formatRedemptionModelConfidence(entry.modelConfidence),
    isLowConfidence: entry.modelConfidence === "low",
    resolutionSummary: getResolutionSummary(entry),
    score: entry.score,
    accessModel: entry.accessModel,
    accessLabel: REDEMPTION_ACCESS_LABELS[entry.accessModel],
    settlementLabel: REDEMPTION_SETTLEMENT_LABELS[entry.settlementModel],
    outputAssetLabel: REDEMPTION_OUTPUT_ASSET_LABELS[entry.outputAssetType],
    routeExitCorrelationLabel: entry.routeExitCorrelation ? formatTelemetryKind(entry.routeExitCorrelation) : null,
    capacitySummary: getCapacitySummary(entry),
    telemetryContext: buildTelemetryContext(entry),
    costScenarioContext: buildCostScenarioContext(entry),
    confidenceContext: buildConfidenceContext(entry),
    confidenceReasons: entry.confidenceDetails?.reasons ?? [],
    feeSummary: getFeeSummary(entry),
    filteredNotes: buildFilteredNotes(entry),
    docSources: buildDocSources(entry),
    docsReviewedAt: docs?.reviewedAt ?? null,
    docsProvenanceLabel: docs?.provenance ? formatRedemptionDocsProvenance(docs.provenance) : null,
    scoreBreakdown: {
      access: { label: "Access score", score: entry.accessScore, textClass: scoreTextClass(entry.accessScore) },
      settlement: {
        label: "Settlement",
        score: entry.settlementScore,
        textClass: scoreTextClass(entry.settlementScore),
      },
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
        suffix: feeBpsBreakdownSuffix(entry),
      },
    } satisfies ScoreBreakdownViewModel,
  };
}
