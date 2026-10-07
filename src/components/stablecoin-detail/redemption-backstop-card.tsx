"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import { TableBody, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/table";
import { cn } from "@/lib/utils";
import type { RedemptionBackstopEntry, SafetyScoreV9CurrentCard } from "@shared/types";
import {
  REVIEWED_REDEMPTION_COVERAGE_DISPOSITIONS,
  type RedemptionCoverageReasonCode,
} from "@shared/data/coverage-dispositions/redemption-coverage-dispositions";
import { countSummaryWords, SUMMARY_VERDICT_MAX_WORDS } from "@shared/lib/summary-budget";
import { formatPercent, formatV9PresentationUsd } from "@shared/lib/format";
import {
  REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS,
  REDEMPTION_ROUTE_FAMILY_CAPS,
} from "@shared/lib/redemption-backstop-scoring";
import { resolveV9EffectiveScoringWeight } from "@shared/types/safety-score-v9-causes";
import { describeExitRouteVenue } from "@/lib/safety-score-reason-labels";
import { humanizeSafetyScoreV9Value } from "@/lib/stablecoin-safety-score-v9-presentation-helpers";
import { formatRedemption } from "@/lib/show-your-work-formatters";
import { METHODOLOGY_CONTEXT } from "@/lib/methodology-context";
import { useShowWorkMode } from "@/hooks/use-show-work-mode";
import { FeedbackModal } from "@/components/feedback-modal";
import { MethodologyHint } from "@/components/methodology-hint";
import { ScoreBadgeWrapper } from "@/components/score-badge-wrapper";
import { EvidenceFooter } from "@/components/stablecoin-detail/evidence-footer";
import { EvidenceModule, type EvidenceModuleVariant } from "@/components/stablecoin-detail/evidence-module";
import { ModuleDisclosure } from "@/components/stablecoin-detail/module-disclosure";
import { StationLabel } from "@/components/stablecoin-detail/rail-station";
import { RedemptionRouteRail } from "@/components/stablecoin-detail/redemption-route-rail";
import { ScoreBandSpectrum, type SpectrumBand } from "@/components/stablecoin-detail/score-band-spectrum";
import { ScorePill } from "@/components/stablecoin-detail/score-pill";
import { FreshnessIndicator } from "@/components/status/freshness-indicator";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { buildRedemptionBackstopCardViewModel } from "./redemption-backstop-card-view-model";

type ExitBreakdown = NonNullable<SafetyScoreV9CurrentCard["breakdowns"]>["exit"];
type ExitScoredRoute = NonNullable<ExitBreakdown["primaryRoute"]>;
type ExitAlternativeRoute = ExitBreakdown["alternatives"][number];
type ExitComponentKey = ExitScoredRoute["components"][number]["key"];
type RouteComponentField =
  | "accessScore"
  | "settlementScore"
  | "executionCertaintyScore"
  | "capacityScore"
  | "outputAssetQualityScore"
  | "costScore";

/**
 * The six weighted route components, in policy order. `item` keys the view
 * model's breakdown, `weight` the shared component weights; the Exit pillar
 * scores the same six components under the same weights.
 */
const SCORE_COMPONENT_ROWS = [
  { item: "access", weight: "access", label: "Access" },
  { item: "settlement", weight: "settlement", label: "Settlement" },
  { item: "execution", weight: "executionCertainty", label: "Execution certainty" },
  { item: "capacity", weight: "capacity", label: "Capacity" },
  { item: "outputQuality", weight: "outputAssetQuality", label: "Output quality" },
  { item: "cost", weight: "cost", label: "Cost" },
] as const;

/** Exit component → the standalone entry field it re-scores, as named in prose. */
const EXIT_COMPONENT_ROUTE_FIELDS: Record<ExitComponentKey, { label: string; field: RouteComponentField }> = {
  access: { label: "access", field: "accessScore" },
  settlement: { label: "settlement", field: "settlementScore" },
  executionCertainty: { label: "execution", field: "executionCertaintyScore" },
  capacity: { label: "capacity", field: "capacityScore" },
  outputAssetQuality: { label: "output quality", field: "outputAssetQualityScore" },
  cost: { label: "cost", field: "costScore" },
};

/** The view model's tone cutoffs (80/65/50/35) as a range track. The tiers
 *  have no published names, so each band is labelled by its score range.
 *  Worst → best, left → right. */
const REDEMPTION_SCORE_BANDS: readonly SpectrumBand[] = [
  { key: "t0", label: "<35", fillClass: "bg-red-500/70", textClass: "text-red-700 dark:text-red-400" },
  { key: "t35", label: "35–49", fillClass: "bg-orange-500/70", textClass: "text-orange-700 dark:text-orange-400" },
  { key: "t50", label: "50–64", fillClass: "bg-amber-500/70", textClass: "text-amber-700 dark:text-amber-400" },
  { key: "t65", label: "65–79", fillClass: "bg-blue-500/70", textClass: "text-blue-700 dark:text-blue-400" },
  { key: "t80", label: "80+", fillClass: "bg-emerald-500/70", textClass: "text-emerald-700 dark:text-emerald-400" },
];
const REDEMPTION_SCORE_CUTOFFS = [0, 35, 50, 65, 80] as const;

const CHIP_CLASS = "border-border/60 bg-muted/30 text-xs";

/** Standalone caps and capacity penalties (`redemption-backstop-scoring.ts`). */
const STANDALONE_CAP_LABELS: Record<string, string> = {
  "settlement-delay-penalty": "Settlement-delay penalty on capacity",
  "queue-depth-penalty": "Queue-depth penalty on capacity",
  "minimum-size-penalty": "Minimum-size penalty on capacity",
  "live-holder-eligibility-penalty": "Holder-eligibility penalty on capacity",
  "zero-executable-capacity": "No executable capacity: score 0",
  "queue-route-cap": `Queue-redeem cap at ${REDEMPTION_ROUTE_FAMILY_CAPS.queueRedeem}`,
  "offchain-route-cap": `Offchain-issuer cap at ${REDEMPTION_ROUTE_FAMILY_CAPS.offchainIssuer}`,
  "config-cap": "Reviewed route cap",
};

/** Verb phrases for an Exit route the pillar evaluated but did not credit. */
const EXIT_EXCLUSION_CLAUSES: Record<string, (notional: string | null) => string> = {
  "unsupported-same-notional-route": (notional) =>
    `lacks supported ${notional ? `${notional} ` : ""}same-notional evidence`,
  "missing-same-notional-route": (notional) => `has no ${notional ? `${notional} ` : ""}same-notional measurement`,
  "unproven-settlement-bound": () => "has no proven settlement bound",
  "unresolved-exit-output": () => "has an unresolved output asset",
  "missing-runtime-route-evidence": () => "lacks current runtime evidence",
  "incomparable-route-requests": () => "was measured against a different request",
};

function redemptionScoreBandKey(score: number): string {
  if (score >= 80) return "t80";
  if (score >= 65) return "t65";
  if (score >= 50) return "t50";
  if (score >= 35) return "t35";
  return "t0";
}

function MetadataBadgeList({ items }: { items: readonly { label: string; value: string }[] }) {
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {items.map((item) => (
        <Badge
          key={`${item.label}:${item.value}`}
          variant="outline"
          className="border-border/60 bg-background/60 text-[11px] font-normal text-muted-foreground"
        >
          {item.label}: {item.value}
        </Badge>
      ))}
    </div>
  );
}

const NO_HOLDER_ROUTE_REASONS: Partial<Record<RedemptionCoverageReasonCode, string>> = {
  "pegkeeper-only": "Only PegKeeper contracts redeem; holders exit through markets.",
  "no-holder-route": "No issuer or protocol route lets ordinary holders redeem; holders exit through markets.",
  "borrower-repay-only": "Only borrowers repaying debt reclaim collateral; holders exit through markets.",
  "secondary-market-only": "Holders exit through secondary markets only.",
};

/**
 * Why the standalone route score is missing. Each sentence names the
 * standalone score, so it never reads as the route being unscored everywhere:
 * the Exit pillar can still score the same route from its own evidence.
 */
const NOT_RATED_REASONS: Record<Exclude<RedemptionBackstopEntry["resolutionState"], "resolved">, string> = {
  "missing-capacity": "No standalone route score: no executable redemption capacity could be measured.",
  "missing-cache": "No standalone route score: the asset was missing from the current supply snapshot.",
  impaired: "No standalone route score: current evidence contradicts par redemption on this route.",
  failed: "No standalone route score: the last route refresh failed.",
};

/** A resolved route without a score has eventual capacity only; the standalone score reads immediate capacity. */
function notRatedReason(entry: RedemptionBackstopEntry): string {
  if (entry.resolutionState !== "resolved") return NOT_RATED_REASONS[entry.resolutionState];
  return entry.capacityScore == null
    ? "No standalone route score: only eventual capacity is published, and the standalone score needs immediate capacity."
    : "No standalone route score is published for this route.";
}

/** What the Exit pillar read to score a route, for "scores this route at N from …". */
const EXIT_CAPACITY_EVIDENCE_PHRASES: Record<ExitAlternativeRoute["capacityEvidenceTier"], string> = {
  "live-direct": "live capacity readings",
  "live-queue-proxy": "live queue readings",
  documented: "documented capacity terms",
  heuristic: "a capacity estimate",
  unknown: "its own capacity evidence",
};

/**
 * The Exit pillar's score for a route that has no standalone score, with what
 * that number is: Exit's own re-score from its capacity evidence at the stress
 * size, not a standalone value. The stress size drops out where the sentence
 * already names the Exit outcome.
 */
function exitOwnScoreClause(
  tier: ExitAlternativeRoute["capacityEvidenceTier"],
  score: number,
  stressSize: string | null,
): string {
  const evidence = `scores this route at ${score} from ${EXIT_CAPACITY_EVIDENCE_PHRASES[tier]}`;
  return stressSize ? `${evidence} at ${stressSize}` : evidence;
}

/** Exit route keys end in the producer's route id, `redemption:<coin>:<family>`. */
export function isEntryRouteKey(key: string, entry: RedemptionBackstopEntry): boolean {
  return key.startsWith("redemption:") && key.endsWith(`:${entry.stablecoinId}:${entry.routeFamily}`);
}

/** 0.97 → "0.97", 0.9 → "0.9". */
function formatFactor(value: number): string {
  return String(Number(value.toFixed(2)));
}

/** The Exit cap that bound the route's score, as a clause. */
function exitCapClause(capsApplied: readonly string[], stressSize: string, notional: string | null): string | null {
  if (capsApplied.includes("zero-executable-capacity")) return `it clears nothing at ${stressSize}`;
  if (capsApplied.includes("immaterial-executable-capacity")) return `it clears an immaterial amount at ${stressSize}`;
  if (capsApplied.includes("evidence-kind:documented-terms")) return "its documented-terms cap applies";
  const horizon = capsApplied.find((cap) => cap.startsWith("capacity-horizon:"));
  if (horizon) return `its ${horizon.slice("capacity-horizon:".length)}-capacity cap applies`;
  if (capsApplied.includes("route-family:queue-redeem")) return "its queue-redeem cap applies";
  if (capsApplied.includes("route-family:offchain-issuer")) return "its offchain-issuer cap applies";
  const completion = capsApplied.find((cap) => cap.startsWith("insufficient-completion:"));
  if (completion) return `it fills too little of ${notional ?? "the request"}, capping it at ${completion.split(":")[1]}`;
  return null;
}

/**
 * Why the Exit pillar's score for this same route differs from the standalone
 * route score: the single largest published effect pushing in the direction
 * of the difference. Exit re-scores the six components at its stress size,
 * multiplies by evidence confidence and holder eligibility, then caps; the
 * standalone score carries its own caps.
 */
function exitDivergenceClause(
  route: ExitScoredRoute,
  exitScore: number,
  entry: RedemptionBackstopEntry,
  routeScore: number,
  stressSize: string,
  notional: string | null,
): string | null {
  const direction = Math.sign(exitScore - routeScore);
  const ceiling = route.supportedComponentCeiling ?? exitScore;
  const confidence = route.confidenceFactor;
  const eligibility = route.eligibilityMultiplier;
  const candidates: { effect: number; clause: string }[] = [];

  for (const component of route.components) {
    const mapping = EXIT_COMPONENT_ROUTE_FIELDS[component.key];
    const standalone = entry[mapping.field];
    if (component.score === null || standalone == null) continue;
    const exitValue = Math.round(component.score);
    const routeValue = Math.round(standalone);
    if (exitValue === routeValue) continue;
    candidates.push({
      effect: resolveV9EffectiveScoringWeight(component) * (component.score - standalone),
      clause: `${mapping.label} scores ${exitValue} at ${stressSize}, not ${routeValue}`,
    });
  }
  if (confidence < 1) {
    candidates.push({
      effect: ceiling * (confidence - 1),
      clause: `a ${formatFactor(confidence)} evidence-confidence factor applies`,
    });
  }
  if (eligibility < 1) {
    candidates.push({
      effect: ceiling * confidence * (eligibility - 1),
      clause: `a ${formatFactor(eligibility)} holder-eligibility factor applies`,
    });
  }
  const capClause = exitCapClause(route.capsApplied, stressSize, notional);
  if (capClause) candidates.push({ effect: exitScore - ceiling * confidence * eligibility, clause: capClause });

  const standaloneCaps = entry.capsApplied ?? [];
  const routeCap = standaloneCaps.find((cap) => cap.endsWith("-cap"));
  if (routeCap) {
    let weighted = 0;
    let complete = true;
    for (const row of SCORE_COMPONENT_ROWS) {
      const value = entry[EXIT_COMPONENT_ROUTE_FIELDS[row.weight].field];
      if (value == null) complete = false;
      else weighted += value * REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS[row.weight];
    }
    if (complete) {
      candidates.push({
        effect: weighted - routeScore,
        clause: `the standalone score carries its ${(STANDALONE_CAP_LABELS[routeCap] ?? humanizeSafetyScoreV9Value(routeCap)).toLowerCase()}`,
      });
    }
  }

  const best = candidates
    .filter((candidate) => Math.sign(candidate.effect) === direction && Math.abs(candidate.effect) >= 0.5)
    .sort((left, right) => Math.abs(right.effect) - Math.abs(left.effect))[0];
  return best?.clause ?? null;
}

/** Verb phrase for this route when the Exit pillar evaluated but did not credit it. */
function exitExclusionClause(route: ExitAlternativeRoute, stressSize: string, notional: string | null): string {
  if (route.capacity?.executableUsd === 0) return `clears nothing at ${stressSize}`;
  if (route.exclusionReason === null) return "is not credited";
  const clause = EXIT_EXCLUSION_CLAUSES[route.exclusionReason];
  return clause ? clause(notional) : `is not credited (${humanizeSafetyScoreV9Value(route.exclusionReason).toLowerCase()})`;
}

/**
 * A sentence naming the selected Exit route; the venue drops out when it would
 * push the sentence past the verdict budget, and the score stays.
 */
function withSelectedRoute(route: ExitScoredRoute, score: number, sentence: (selected: string) => string): string {
  const named = sentence(`${describeExitRouteVenue(route)} (${score})`);
  return countSummaryWords(named) <= SUMMARY_VERDICT_MAX_WORDS ? named : sentence(`another route (${score})`);
}

/**
 * How the Exit pillar relates to this route, in one sentence (≤ 25 words),
 * from the published Exit breakdown. Every number the module shows that the
 * Exit strip shows differently is named and explained here:
 *
 * - Exit scores this same route: the same number, or "counts this route as
 *   74, not 75: <largest published cause>".
 * - Exit selects another route: its venue and score, then how Exit treated
 *   this route (re-scored, not credited and why, or absent).
 * - No route qualifies: why this route did not, and the resulting Exit score.
 * - No standalone score: never "counts as N" beside the NR pill; Exit's own
 *   score for the route is named with the capacity evidence it read.
 */
function describeExitReconciliation(
  reportCard: SafetyScoreV9CurrentCard | null | undefined,
  entry: RedemptionBackstopEntry | null,
): string | null {
  const breakdown = reportCard?.breakdowns?.exit ?? null;
  if (reportCard == null || breakdown === null) return null;
  const notional = breakdown.stressRequest ? formatV9PresentationUsd(breakdown.stressRequest.requestedNotionalUsd) : null;
  const stressSize = notional ? `the ${notional} stress size` : "the Exit stress size";
  const ownRoute = entry === null ? null : (breakdown.alternatives.find((route) => isEntryRouteKey(route.key, entry)) ?? null);
  const primary = breakdown.primaryRoute;
  const primaryRawScore = primary?.score ?? null;

  if (primary === null || primaryRawScore === null) {
    const pillarScore = reportCard.pillars.exit.score;
    if (pillarScore === null) return null;
    const exitScore = Math.round(pillarScore);
    const outcome = `no route qualifies, so Exit is ${exitScore}.`;
    if (entry === null) {
      return `For ${notional ? `a ${notional} exit` : "the Exit stress request"}, ${outcome}`;
    }
    // An unrated route's verdict already names the missing standalone score.
    const unrated = entry.score == null;
    const subject = unrated ? "This route" : `This route scores ${entry.score} but`;
    if (primary !== null && isEntryRouteKey(primary.key, entry)) {
      return unrated ? `Exit cannot score this route either; ${outcome}` : `${subject} Exit cannot score it; ${outcome}`;
    }
    if (ownRoute === null) return `${subject} is not in the Exit evaluation; ${outcome}`;
    if (ownRoute.included && ownRoute.score !== null) {
      const counted = Math.round(ownRoute.score);
      return unrated
        ? `Exit ${exitOwnScoreClause(ownRoute.capacityEvidenceTier, counted, null)}, but no route qualifies, so Exit is ${exitScore}.`
        : `This route scores ${entry.score}, ${counted} in Exit, but no route qualifies, so Exit is ${exitScore}.`;
    }
    return `${subject} ${exitExclusionClause(ownRoute, stressSize, notional)}; ${outcome}`;
  }

  const primaryScore = Math.round(primaryRawScore);
  if (entry === null) {
    return withSelectedRoute(primary, primaryScore, (selected) => `The Exit pillar relies on market routes instead (best: ${selected}).`);
  }
  if (isEntryRouteKey(primary.key, entry)) {
    if (entry.score == null) {
      return `The Exit pillar ${exitOwnScoreClause(primary.capacityEvidenceTier, primaryScore, stressSize)}.`;
    }
    if (primaryScore === entry.score) return `The Exit pillar counts this route at the same score (${primaryScore}).`;
    const head = `The Exit pillar counts this route as ${primaryScore}, not ${entry.score}`;
    const clause = exitDivergenceClause(primary, primaryRawScore, entry, entry.score, stressSize, notional);
    return clause ? `${head}: ${clause}.` : `${head}, re-scored at ${stressSize}.`;
  }

  let routeClause: string;
  if (ownRoute !== null && ownRoute.included && ownRoute.score !== null) {
    const counted = Math.round(ownRoute.score);
    routeClause = entry.score == null
      ? `it ${exitOwnScoreClause(ownRoute.capacityEvidenceTier, counted, stressSize)}`
      : `it counts this route as ${counted}${counted !== entry.score ? `, not ${entry.score}` : ""}`;
  } else if (ownRoute !== null) {
    routeClause = `this route ${exitExclusionClause(ownRoute, stressSize, notional)}`;
  } else {
    routeClause = entry.score == null ? "this route is not in its evaluation" : `this route scores ${entry.score}`;
  }
  return withSelectedRoute(primary, primaryScore, (selected) => `The Exit pillar selects ${selected}; ${routeClause}.`);
}

/** Verdict sentence, then the route-vs-pillar reconciliation as a muted second line. */
function RouteVerdict({ verdict, reconciliation }: { verdict: string; reconciliation: string | null }) {
  return (
    <>
      {verdict}
      {reconciliation ? (
        <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{reconciliation}</span>
      ) : null}
    </>
  );
}

const methodologyHint = <MethodologyHint topic="redemptionBackstop" />;

/** The reviewed "no holder route" reason for a coin without a scored route, if one is published. */
function noHolderRouteReason(coinId: string) {
  const disposition = REVIEWED_REDEMPTION_COVERAGE_DISPOSITIONS.find((row) => row.id === coinId);
  const reason = disposition ? NO_HOLDER_ROUTE_REASONS[disposition.reasonCode] : undefined;
  return disposition && reason !== undefined ? { disposition, reason } : null;
}

/** Whether `RedemptionRouteSection` renders anything for this coin. */
export function hasRedemptionRouteModule(entry: RedemptionBackstopEntry | null | undefined, coinId: string): boolean {
  return entry != null || noHolderRouteReason(coinId) !== null;
}

/**
 * Exit-evidence module: the scored redemption route, an explicit "No holder
 * redemption route" state from the reviewed coverage dispositions, or nothing.
 * Root keeps `id="redemption"` in every state (hero passport link target).
 *
 * The no-holder state has no route to draw, so it always renders in strip
 * form (plan §8a: a module whose visual degrades becomes a strip).
 */
export function RedemptionRouteSection({
  entry,
  reportCard,
  coinId,
  variant = "module",
  stripForm = false,
}: {
  entry: RedemptionBackstopEntry | null | undefined;
  reportCard: SafetyScoreV9CurrentCard | null | undefined;
  coinId: string;
  variant?: EvidenceModuleVariant;
  stripForm?: boolean;
}) {
  if (entry) {
    return (
      <RedemptionBackstopCard
        entry={entry}
        reconciliation={describeExitReconciliation(reportCard, entry)}
        variant={variant}
        stripForm={stripForm}
      />
    );
  }
  const noHolder = noHolderRouteReason(coinId);
  if (!noHolder) return null;
  const { disposition, reason } = noHolder;
  return (
    <EvidenceModule
      id="redemption"
      title="Redemption route"
      variant={variant}
      stripForm
      methodology={methodologyHint}
      headerRight={<ScorePill label="No holder route" title="No holder redemption route exists, so none is scored" />}
      verdict={<RouteVerdict verdict={reason} reconciliation={describeExitReconciliation(reportCard, null)} />}
      footer={
        <EvidenceFooter
          notes={<p>{disposition.blocker}</p>}
          notesCount={1}
          sources={disposition.evidenceUrls.map((url) => ({ label: new URL(url).hostname, url }))}
          reviewed={disposition.reviewedDate}
        />
      }
    />
  );
}

/** The view-model labels the route inputs read. */
interface RouteInputLabels {
  routeFamilyLabel: string;
  accessLabel: string;
  settlementLabel: string;
  outputAssetLabel: string;
}

interface RouteScoreComponent {
  score: number | null;
  textClass: string;
  suffix?: string;
}

type RouteScoreComponents = Record<(typeof SCORE_COMPONENT_ROWS)[number]["item"], RouteScoreComponent>;

/** Route inputs, in the order the score reads them; unavailable is "–", never 0. */
function routeInputRows(entry: RedemptionBackstopEntry, viewModel: RouteInputLabels) {
  return [
    { label: "Route family", value: viewModel.routeFamilyLabel },
    { label: "Access model", value: viewModel.accessLabel },
    { label: "Settlement model", value: viewModel.settlementLabel },
    { label: "Execution model", value: humanizeSafetyScoreV9Value(entry.executionModel) },
    { label: "Output", value: viewModel.outputAssetLabel },
    { label: "Capacity confidence", value: humanizeSafetyScoreV9Value(entry.capacityConfidence) },
    {
      label: "Immediate capacity",
      value: entry.immediateCapacityUsd != null ? formatV9PresentationUsd(entry.immediateCapacityUsd) : "–",
    },
    {
      label: "Immediate capacity ratio",
      value: entry.immediateCapacityRatio != null ? formatPercent(entry.immediateCapacityRatio * 100, 1) : "–",
    },
    { label: "Fee", value: entry.feeBps != null ? `${entry.feeBps} bps` : "–" },
  ];
}

/**
 * The score inputs: each component × its weight = its contribution, the
 * standalone caps, the route inputs and the formula. It replaces the sitewide
 * show-your-work panel and its footer toggle, so the fold opens by default
 * while the sitewide "show work" mode is on.
 */
function RouteScoreBreakdown({
  entry,
  viewModel,
}: {
  entry: RedemptionBackstopEntry;
  viewModel: RouteInputLabels & { scoreBreakdown: RouteScoreComponents };
}) {
  const { enabled: showWork } = useShowWorkMode();
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const rows = SCORE_COMPONENT_ROWS.map((row) => {
    const item = viewModel.scoreBreakdown[row.item];
    const weight = REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS[row.weight];
    return { ...row, item, weight, contribution: item.score == null ? null : item.score * weight };
  });
  const weightedSum = rows.every((row) => row.contribution !== null)
    ? rows.reduce((sum, row) => sum + (row.contribution ?? 0), 0)
    : null;
  const caps = entry.capsApplied ?? [];
  const versionLabel = METHODOLOGY_CONTEXT.redemptionBackstop.versionLabel;

  return (
    <ModuleDisclosure label="Scoring breakdown" defaultOpen={showWork}>
      <div className="mt-2 grid gap-x-10 gap-y-5 pb-1 text-xs text-muted-foreground @4xl/evidence:grid-cols-2">
        <div className="min-w-0 space-y-2">
          <TableFrame
            tableId="redemption-route-score-breakdown"
            chrome="bare"
            density="compact"
            caption="Route score: component score × weight = contribution"
            captionClassName="sr-only"
            tableClassName="border-collapse text-xs"
            viewportProps={{ mobileScrollHint: false, compactBottomPadding: false }}
          >
            <TableHeader>
              <TableRow rowIntent="static" className="border-border/50 text-left">
                <TableHead scope="col" className="h-auto px-0 py-1.5 pr-3 font-normal">Component</TableHead>
                <TableHead scope="col" className="h-auto px-0 py-1.5 pr-3 text-right font-normal">Score</TableHead>
                <TableHead scope="col" className="h-auto px-0 py-1.5 pr-3 text-right font-normal">Weight</TableHead>
                <TableHead scope="col" className="h-auto px-0 py-1.5 text-right font-normal">Contribution</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.label} rowIntent="static" className="border-border/30">
                  <TableHead scope="row" className="h-auto whitespace-normal px-0 py-1.5 pr-3 font-normal text-foreground">
                    {row.label}
                    {row.item.suffix ? <span className="text-muted-foreground">{row.item.suffix}</span> : null}
                  </TableHead>
                  <TableCell className={cn("pharos-numeric px-0 py-1.5 pr-3 text-right", row.item.score == null ? undefined : row.item.textClass)}>
                    {row.item.score ?? "–"}
                  </TableCell>
                  <TableCell className="pharos-numeric px-0 py-1.5 pr-3 text-right">{formatPercent(row.weight * 100, 0)}</TableCell>
                  <TableCell className="pharos-numeric px-0 py-1.5 text-right text-foreground">
                    {row.contribution == null ? "–" : row.contribution.toFixed(1)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <tfoot>
              <TableRow rowIntent="static" className="border-b-0 border-t border-border/30">
                <TableHead scope="row" colSpan={3} className="h-auto px-0 pt-2 pr-3 font-normal">Weighted sum</TableHead>
                <TableCell className="pharos-numeric px-0 py-0 pt-2 text-right text-foreground">{weightedSum == null ? "–" : weightedSum.toFixed(1)}</TableCell>
              </TableRow>
              <TableRow rowIntent="static" className="border-b-0">
                <TableHead scope="row" colSpan={3} className="h-auto px-0 pt-1 pr-3 font-medium text-foreground">Route score</TableHead>
                <TableCell className={cn("pharos-numeric px-0 py-0 pt-1 text-right text-sm font-semibold", entry.score == null ? undefined : "text-foreground")}>
                  {entry.score ?? "NR"}
                </TableCell>
              </TableRow>
            </tfoot>
          </TableFrame>
          {caps.length > 0 ? (
            <p>
              <span className="text-foreground">Caps applied:</span>{" "}
              {caps.map((cap) => STANDALONE_CAP_LABELS[cap] ?? humanizeSafetyScoreV9Value(cap)).join(" · ")}
            </p>
          ) : null}
        </div>

        <div className="min-w-0 space-y-3">
          <dl className="grid gap-x-6 @2xl/evidence:grid-cols-2">
            {routeInputRows(entry, viewModel).map((row) => (
              <div key={row.label} className="flex items-baseline justify-between gap-3 border-b border-border/30 py-1.5">
                <dt>{row.label}</dt>
                <dd className="text-right text-foreground">{row.value}</dd>
              </div>
            ))}
          </dl>
          <p className="max-w-prose leading-relaxed text-pretty">{formatRedemption(entry).formula}</p>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {versionLabel ? <span>Methodology {versionLabel}</span> : null}
            <button
              type="button"
              onClick={() => setFeedbackOpen(true)}
              className="pharos-focus-ring -my-2 inline-flex min-h-8 items-center rounded-sm underline decoration-dashed underline-offset-2 transition-colors hover:text-foreground"
            >
              Report a discrepancy
            </button>
          </p>
          <FeedbackModal
            open={feedbackOpen}
            onOpenChange={setFeedbackOpen}
            defaultType="data-correction"
            stablecoinId={entry.stablecoinId}
          />
        </div>
      </div>
    </ModuleDisclosure>
  );
}

function RedemptionBackstopCard({
  entry,
  reconciliation,
  variant,
  stripForm,
}: {
  entry: RedemptionBackstopEntry;
  reconciliation: string | null;
  variant: EvidenceModuleVariant;
  stripForm: boolean;
}) {
  const viewModel = buildRedemptionBackstopCardViewModel(entry);
  const verdict = viewModel.score == null
    ? notRatedReason(entry)
    : `${viewModel.accessLabel} access; ${viewModel.settlementLabel.toLowerCase()} settlement into ${viewModel.outputAssetLabel.toLowerCase()}.`;
  // One active-state chip at most: a non-open route status outranks an
  // unresolved snapshot, whose consequence the not-rated verdict already states.
  const stateLabel = viewModel.showRouteStatusBadge
    ? viewModel.routeStatusLabel
    : viewModel.showResolutionStateBadge
      ? viewModel.resolutionStateLabel
      : null;
  // Both vocabularies are lower case; chips read sentence case.
  const stateChip = stateLabel ? `${stateLabel.charAt(0).toUpperCase()}${stateLabel.slice(1)}` : null;

  // Score track and route side by side once the module is wide enough for
  // both (a full-width module at lg+); stacked, track first, below that.
  const visual = (
    <div className="@container/route">
      <div className="flex flex-col gap-4 @4xl/route:flex-row @4xl/route:items-start @4xl/route:gap-8">
        {viewModel.score != null ? (
          <div className="flex w-full max-w-md min-w-0 flex-col gap-1 @4xl/route:w-72 @4xl/route:shrink-0">
            <StationLabel>Route score</StationLabel>
            <ScoreBandSpectrum
              mode="range"
              bands={REDEMPTION_SCORE_BANDS}
              cutoffs={REDEMPTION_SCORE_CUTOFFS}
              activeKey={redemptionScoreBandKey(viewModel.score)}
              score={viewModel.score}
              ariaLabel={`Route score ${viewModel.score} of 100 on the redemption score track.`}
            />
          </div>
        ) : null}
        <div className="min-w-0 flex-1">
          <RedemptionRouteRail
            accessModel={viewModel.accessModel}
            accessLabel={viewModel.accessLabel}
            settlementLabel={viewModel.settlementLabel}
            outputAssetLabel={viewModel.outputAssetLabel}
            routeFamilyLabel={viewModel.routeFamilyLabel}
          />
        </div>
      </div>
    </div>
  );

  return (
    <EvidenceModule
      id="redemption"
      title={viewModel.title}
      variant={variant}
      stripForm={stripForm}
      methodology={methodologyHint}
      headerRight={
        // A low-confidence score keeps the broken outline so it does not read
        // as firm as a well-evidenced one.
        <ScoreBadgeWrapper topic="redemptionBackstop" variant="tooltip-only">
          <ScorePill
            label={viewModel.heroScoreLabel}
            toneClass={viewModel.scoreToneClass}
            title="Standalone route score. Tone follows the 80/65/50/35 score cutoffs on the track below."
            className={viewModel.isLowConfidence ? "border-dashed" : undefined}
          />
        </ScoreBadgeWrapper>
      }
      visual={visual}
      verdict={<RouteVerdict verdict={verdict} reconciliation={reconciliation} />}
      chipRow={
        <>
          <Badge variant="outline" className={CHIP_CLASS}>
            {viewModel.sourceModeLabel}
          </Badge>
          <Badge variant="outline" className={CHIP_CLASS}>
            {viewModel.modelConfidenceLabel}
          </Badge>
          {stateChip ? (
            <Badge variant="outline" className={cn("text-xs", SEVERITY_TONE_CLASS.watch.pill)}>
              {stateChip}
            </Badge>
          ) : null}
        </>
      }
      folds={
        <>
          <RouteScoreBreakdown entry={entry} viewModel={viewModel} />
          <ModuleDisclosure label="Capacity, fees & confidence">
            <div className="mt-2 grid items-start gap-3 xl:grid-cols-2">
              <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
                <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
                  {viewModel.capacitySummary.title}
                </p>
                <p className="mt-1 text-sm font-medium">{viewModel.capacitySummary.headline}</p>
                <p className="mt-1 text-xs text-muted-foreground">{viewModel.capacitySummary.detail}</p>
                {viewModel.routeExitCorrelationLabel ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Exit correlation: <span className="text-foreground">{viewModel.routeExitCorrelationLabel}</span>
                  </p>
                ) : null}
                {viewModel.telemetryContext.length > 0 ? <MetadataBadgeList items={viewModel.telemetryContext} /> : null}
              </div>

              {/* Fee and confidence stack to balance the capacity column's height. */}
              <div className="grid content-start gap-3">
                <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
                  <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">Redemption Fee</p>
                  <p className="mt-1 text-sm font-medium">{viewModel.feeSummary.headline}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{viewModel.feeSummary.detail}</p>
                  {viewModel.costScenarioContext.length > 0 ? (
                    <MetadataBadgeList items={viewModel.costScenarioContext} />
                  ) : null}
                </div>

                {viewModel.confidenceContext.length > 0 ? (
                  <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
                    <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">Confidence Detail</p>
                    <MetadataBadgeList items={viewModel.confidenceContext} />
                    {viewModel.confidenceReasons.length > 0 ? (
                      <p className="mt-2 text-xs text-muted-foreground">{viewModel.confidenceReasons.join(". ")}</p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>

            {/* Route notes, filtered for redundancy with the capacity detail. */}
            {viewModel.filteredNotes.length > 0 ? (
              <div className="mt-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
                {viewModel.filteredNotes.join(". ")}
              </div>
            ) : null}
          </ModuleDisclosure>
        </>
      }
      footer={
        <EvidenceFooter
          notes={viewModel.resolutionSummary ? <p>{viewModel.resolutionSummary}</p> : undefined}
          notesCount={viewModel.resolutionSummary ? 1 : undefined}
          sources={viewModel.docSources.map((source) => ({
            label: source.label,
            url: source.url,
            note: source.supports ? `Supports ${source.supports}` : undefined,
          }))}
          sourcesFootnote={viewModel.docsProvenanceLabel ? <p>{viewModel.docsProvenanceLabel}</p> : null}
          reviewed={viewModel.docsReviewedAt ?? undefined}
        >
          {/* Live-data freshness as plain footer text on the left; the docs
              review date sits right. The 2× producer headroom matches the
              compact chip's, so amber means a producer run was missed. */}
          <FreshnessIndicator
            updatedAtMs={entry.updatedAt * 1000}
            staleAfterMs={API_FRESHNESS_MAX_AGE_SEC.redemptionBackstops * 2000}
            labelPrefix="Updated"
            className="border-transparent bg-transparent px-0 py-0 text-xs font-normal"
          />
        </EvidenceFooter>
      }
    />
  );
}
