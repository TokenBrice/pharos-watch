"use client";

import Link from "next/link";
import { formatComparisonPrice, hasObservedDisplayPrice, resolveCurrentDeviation, resolveCurrentPeg } from "@/lib/current-peg";
import { memo, useId, useMemo, useState, type ReactNode } from "react";
import {
  BACKING_LABELS_SHORT,
  COLLATERAL_QUALITY_LABELS,
  CUSTODY_MODEL_LABELS,
  GOVERNANCE_LABELS,
  MECHANISM_ARCHETYPE_SHORT_LABELS,
  THREAT_BAND_LABELS,
  THREAT_BAND_STYLES,
  isThreatBand,
} from "@shared/lib/classification";
import {
  formatCurrency,
  formatBps,
  formatPercent,
  formatPercentFromRatio,
  formatScore,
  formatSignedCurrency,
  formatSignedPercent,
} from "@shared/lib/format";
import { formatPegOccupancy } from "@shared/lib/peg-format";
import { GENIUS_STATUS_SHORT_LABELS } from "@shared/lib/genius";
import { MICA_STATUS_BADGE_STYLES } from "@shared/lib/mica";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { isTokenizedFundId } from "@shared/lib/stablecoins/listing-governance";
import { getSupplyChangePercent } from "@/components/stablecoin-directory/stablecoin-table-logic";
import { getVariantAccessibleLabel } from "@shared/lib/variant-display";
import { projectTopDriver } from "@shared/lib/safety-score-v9/public-top-driver";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { CoinStateChip } from "@/components/coin-state-chip";
import { SafetyGradeBadge } from "@/components/safety-scores/safety-grade-badge";
import { SafetyScoreTopDriver } from "@/components/safety-scores/safety-score-top-driver";
import { describePartialEvidence, formatPartialEvidenceGap } from "@/lib/safety-score-reason-labels";
import {
  TableBody,
  TableCell,
  TableFrame,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/table";
import { MethodologyLabel } from "@/components/methodology-hint";
import { resolveMintAuthorityStatus } from "@/lib/mint-authority-display";
import { humanizeSafetyScoreV9Value } from "@/lib/stablecoin-safety-score-v9-presentation";
import { buildStablecoinUrl } from "@shared/lib/urls";
import type { ComparisonCoinEntry } from "@/lib/compare-derive";
import { stablecoinLabel } from "@/lib/stablecoin-label";
import { bluechipObservationText } from "@/lib/bluechip";
import { FlowSignedNetValue } from "@/components/mint-burn/flow-valuation-value";
import {
  resolveCoinNetFlow,
  resolvePressureScore,
  resolvePressureState,
  resolvePressureUnavailableNote,
  type MintBurnNetWindow,
} from "@shared/lib/mint-burn-coin-helpers";
import { cn } from "@/lib/utils";

/** Signed flow net gated by valuation completeness: unavailable renders the placeholder, never $0. */
function renderFlowNet(coin: ComparisonCoinEntry, window: MintBurnNetWindow): ReactNode {
  return coin.flow
    ? <FlowSignedNetValue net={resolveCoinNetFlow(coin.flow, window)} format={formatSignedCurrency} />
    : NULL_VALUE;
}

function flowNetKey(coin: ComparisonCoinEntry, window: MintBurnNetWindow): string {
  if (!coin.flow) return NULL_KEY;
  const net = resolveCoinNetFlow(coin.flow, window);
  return net.valueUsd != null ? formatSignedCurrency(net.valueUsd) : `unavail:${net.completeness}`;
}

function renderFlowPressure(coin: ComparisonCoinEntry): ReactNode {
  if (!coin.flow) return NULL_VALUE;
  const unavailableNote = resolvePressureUnavailableNote(coin.flow);
  if (unavailableNote) {
    return (
      <span className="text-muted-foreground" title={unavailableNote}>
        NR<span className="sr-only"> ({unavailableNote})</span>
      </span>
    );
  }
  const score = resolvePressureScore(coin.flow);
  const state = resolvePressureState(coin.flow);
  return `${state === "nr" ? "NR" : humanizeSafetyScoreV9Value(state)}${score != null ? ` · ${formatScore(score, { trimInteger: true })}` : ""}`;
}

function flowPressureKey(coin: ComparisonCoinEntry): string {
  if (!coin.flow) return NULL_KEY;
  const unavailableNote = resolvePressureUnavailableNote(coin.flow);
  if (unavailableNote) return `NR:${unavailableNote}`;
  const score = resolvePressureScore(coin.flow);
  const state = resolvePressureState(coin.flow);
  return `${state}:${score != null ? formatScore(score, { trimInteger: true }) : ""}`;
}

interface ComparisonTableProps {
  coins: ComparisonCoinEntry[];
  logos?: Record<string, string>;
  detailErrors?: Record<string, boolean>;
}

interface ComparisonMetric {
  key: string;
  label: ReactNode;
  render: (coin: ComparisonCoinEntry) => ReactNode;
  /** Normalized comparable value for "Differences only" filtering. */
  compareValue: (coin: ComparisonCoinEntry) => string;
  numeric?: boolean;
  /** Associate each cell with the section's visible description (the caveat it needs). */
  describedBySection?: boolean;
}

interface ComparisonSection {
  key: string;
  title: string;
  shortLabel: string;
  description: string;
  metrics: ComparisonMetric[];
}

const NULL_KEY = "__null__";
const NULL_VALUE = <span className="text-muted-foreground" title="No comparable data available">—</span>;

/** What a scoped report's shares are measured against, per reviewed composition basis. */
const SCOPED_REPORT_DENOMINATORS: Record<string, string> = {
  "nusd-nexus": "nominal pool balances",
  "satusd-river": "gross product deposits",
  "xo-exodus": "measured holdings in scope",
};

function present(value: string | number | null | undefined, fallback: ReactNode = NULL_VALUE): ReactNode {
  return value == null || value === "" ? fallback : value;
}

function presentKey(value: string | number | null | undefined): string {
  return value == null || value === "" ? NULL_KEY : String(value);
}

function humanizeText(value: string | null | undefined): string | null {
  if (value == null || value === "") return null;
  if (value.toLowerCase() === "nr") return "NR";
  return humanizeSafetyScoreV9Value(value.replaceAll("_", "-"));
}

function humanize(value: string | null | undefined): ReactNode {
  const text = humanizeText(value);
  return text ?? NULL_VALUE;
}

function formatComparisonBpsText(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return rounded === 0
    ? `${value > 0 ? "+" : ""}${value.toFixed(0)} bps`
    : formatBps(rounded);
}

function formatComparisonBps(value: number | null | undefined): ReactNode {
  return formatComparisonBpsText(value) ?? NULL_VALUE;
}

function ScoreTrackBar({ value, tone = "accent" }: { value: number; tone?: "accent" | "muted" }) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <span
      aria-hidden="true"
      className="mx-auto mt-1 block h-1 w-16 overflow-hidden rounded-full bg-muted"
    >
      <span
        className={cn(
          "block h-full rounded-full",
          tone === "muted" ? "bg-muted-foreground/45" : "bg-brand-accent/75",
        )}
        style={{ width: `${clamped}%` }}
      />
    </span>
  );
}

function formatScore100(value: number | null | undefined, options?: { track?: boolean; muted?: boolean }): ReactNode {
  if (value == null) return NULL_VALUE;
  const formatted = `${formatScore(value, { trimInteger: true })}/100`;
  if (options?.track === false) return formatted;
  return (
    <span className="inline-flex flex-col items-center">
      <span>{formatted}</span>
      <ScoreTrackBar value={value} tone={options?.muted ? "muted" : "accent"} />
    </span>
  );
}

function score100Key(value: number | null | undefined): string {
  return value == null ? NULL_KEY : formatScore(value, { trimInteger: true });
}

/** Every exceptional state, the top one with its specifics; "None" only once the live state inputs have loaded. */
function renderCoinStates(coin: ComparisonCoinEntry): ReactNode {
  if (coin.coinStates == null) return NULL_VALUE;
  if (coin.coinStates.length === 0) return <span className="text-muted-foreground">None</span>;
  return (
    <span className="flex flex-col items-center gap-1">
      {coin.coinStates.map((state, index) => (
        <CoinStateChip key={state.kind} state={state} showDetail={index === 0} />
      ))}
    </span>
  );
}

function coinStatesKey(coin: ComparisonCoinEntry): string {
  if (coin.coinStates == null) return NULL_KEY;
  if (coin.coinStates.length === 0) return "none";
  return coin.coinStates.map((state) => JSON.stringify(state)).join("|");
}

/** Under a critical or paused notice, a price that is unavailable, unusable or inherited leaves Peg Score reading only past history. */
function pegScoreCaveat(coin: ComparisonCoinEntry): string | null {
  if (!coin.coinStates?.some((state) => state.kind === "critical" || state.kind === "paused")) return null;
  const current = resolveCurrentPeg(coin.data, coin.pegDetails);
  if (current?.currentPriceUnavailable === true || !hasObservedDisplayPrice(coin.data)) return "no usable current price";
  if (current?.primaryTrust === "unusable") return "unusable price source";
  return coin.data.priceDerivation ? "price inherited from its parent" : null;
}

function renderPegScore(coin: ComparisonCoinEntry): ReactNode {
  const score = coin.pegDetails?.pegScore;
  const caveat = score == null ? null : pegScoreCaveat(coin);
  if (caveat === null) return formatScore100(score);
  return (
    <span
      className="inline-flex flex-col items-center text-muted-foreground"
      title={`Peg Score reads the recorded history; with ${caveat} under the current notice it does not show the peg holding now.`}
    >
      {formatScore100(score, { muted: true })}
      <span className="block text-3xs">{caveat}</span>
    </span>
  );
}

function pegScoreKey(coin: ComparisonCoinEntry): string {
  const score = coin.pegDetails?.pegScore;
  if (score == null) return NULL_KEY;
  return `${score100Key(score)}:${pegScoreCaveat(coin) ?? ""}`;
}

function formatCurrentSupplyText(coin: ComparisonCoinEntry): string | null {
  const current = getCirculatingRawOrNull(coin.data);
  return current == null ? null : formatCurrency(current);
}

function formatCurrentSupply(coin: ComparisonCoinEntry): ReactNode {
  return formatCurrentSupplyText(coin) ?? NULL_VALUE;
}

function formatSupplyChangeText(coin: ComparisonCoinEntry, window: "day" | "week" | "month"): string | null {
  const change = getSupplyChangePercent(coin.data, window);
  return change == null ? null : formatSignedPercent(change);
}

function formatSupplyChange(coin: ComparisonCoinEntry, window: "day" | "week" | "month"): ReactNode {
  return formatSupplyChangeText(coin, window) ?? NULL_VALUE;
}

function formatCountText(value: number | null | undefined, singular: string, plural = `${singular}s`): string | null {
  if (value == null) return null;
  return `${value.toLocaleString()} ${value === 1 ? singular : plural}`;
}

function formatCount(value: number | null | undefined, singular: string, plural = `${singular}s`): ReactNode {
  return formatCountText(value, singular, plural) ?? NULL_VALUE;
}

function formatDaysText(value: number | null | undefined): string | null {
  if (value == null) return null;
  if (value >= 730) return `${(value / 365).toFixed(1)} years`;
  if (value >= 365) return `${(value / 365).toFixed(1)} year`;
  return `${Math.round(value)} days`;
}

function formatDays(value: number | null | undefined): ReactNode {
  return formatDaysText(value) ?? NULL_VALUE;
}

function reserveSummaryText(coin: ComparisonCoinEntry): string | null {
  const reserves = coin.meta.reserves ?? [];
  if (reserves.length === 0) return null;
  if (coin.meta.reserveCompositionScope === "allocation-unavailable") return "Allocation unavailable";
  if (coin.meta.reserveCompositionScope === "selected-holdings") return "Selected holdings only";
  const sorted = [...reserves].sort((a, b) => b.pct - a.pct);
  const lead = sorted[0];
  const scope = coin.meta.reserveCompositionScope === "scoped-report"
    ? ` of ${SCOPED_REPORT_DENOMINATORS[coin.id] ?? "scoped reserve report"}`
    : coin.meta.reserveCompositionScope === "nominal-issuance-paths" ? " of reviewed nominal issuance paths" : "";
  return `${lead.name} ${formatPercent(lead.pct, 0)}${scope}${reserves.length > 1 ? ` · ${reserves.length} slices` : ""}`;
}

function reserveSummary(coin: ComparisonCoinEntry): ReactNode {
  return reserveSummaryText(coin) ?? NULL_VALUE;
}

function dependencySummaryText(coin: ComparisonCoinEntry): string | null {
  const card = coin.safetyCard;
  if (!card) return null;
  const dependencies = [
    ...card.dependencies.serial.map((item) => item.upstreamAssetId),
    ...card.dependencies.basket.map((item) => item.upstreamAssetId),
  ];
  if (dependencies.length === 0) return "No scored dependency";
  const labels = dependencies.map((id) =>
    CLIENT_TRACKED_META_BY_ID.has(id) ? stablecoinLabel({ id, symbol: id }) : "Untracked asset"
  );
  return labels.slice(0, 3).join(", ") + (labels.length > 3 ? ` +${labels.length - 3}` : "");
}

function dependencySummary(coin: ComparisonCoinEntry): ReactNode {
  return dependencySummaryText(coin) ?? NULL_VALUE;
}

function variantSummaryText(coin: ComparisonCoinEntry): string {
  if (!coin.meta.variantOf) return "Base asset";
  const parent = CLIENT_TRACKED_META_BY_ID.get(coin.meta.variantOf);
  const label = coin.meta.variantKind ? getVariantAccessibleLabel(coin.meta.variantKind) : "Variant";
  return parent
    ? `${label} of ${parent.name} (${parent.symbol})`
    : `${label} of an untracked asset`;
}

function bindingCapSummaryText(coin: ComparisonCoinEntry): string | null {
  const card = coin.safetyCard;
  if (!card) return null;
  // A null cap on a non-rated card means "not assessed", not "no binding cap".
  if (card.ratingStatus !== "rated") return null;
  return card.bindingCap
    ? `${humanizeSafetyScoreV9Value(card.bindingCap.kind)} · ${card.bindingCap.limit}`
    : "None";
}

function bindingCapSummary(coin: ComparisonCoinEntry): ReactNode {
  return bindingCapSummaryText(coin) ?? NULL_VALUE;
}

function blacklistLabel(coin: ComparisonCoinEntry): string {
  switch (coin.meta.blacklistStatus) {
    case true:
      return "Direct freeze power";
    case "inherited":
      return "Upstream freeze exposure";
    case "possible":
      return "Freeze power possible";
    case false:
      return "No known freeze power";
    default:
      return "Not reviewed";
  }
}

function safetyGradeLabel(coin: ComparisonCoinEntry): ReactNode {
  const card = coin.safetyCard;
  const isUngradedFund = isTokenizedFundId(coin.meta.id)
    || (card?.ratingStatus === "not-rated" && card.nrReasons.some((reason) => reason.code === "tokenized-fund-not-graded"));
  if (isUngradedFund && card?.ratingStatus !== "pipeline-gap") {
    return (
      <span className="inline-flex flex-col items-center gap-0.5">
        <span className="inline-flex items-center rounded-sm border border-border/60 bg-muted/40 px-1.5 py-0.5 text-2xs font-semibold text-muted-foreground">
          Tokenized fund
        </span>
        <span className="text-3xs text-muted-foreground">Not graded</span>
      </span>
    );
  }
  if (!card) return NULL_VALUE;
  if (card.ratingStatus === "pipeline-gap") {
    return (
      <span className="inline-flex flex-col items-center gap-0.5">
        <SafetyGradeBadge grade={null} size="xs" />
        <span className="text-3xs text-muted-foreground">No Safety Score published</span>
      </span>
    );
  }
  const roundedScore = card.score == null ? null : Math.round(card.score);
  const partial = describePartialEvidence(card);
  return (
    <span className="inline-flex flex-col items-center gap-0.5" title={partial?.summary}>
      <SafetyGradeBadge
        grade={card.grade}
        score={roundedScore}
        showScore={roundedScore !== null}
        size="xs"
      />
      {partial ? (
        <span className="text-3xs text-muted-foreground">
          {partial.gaps.map(formatPartialEvidenceGap).join(" · ")}
        </span>
      ) : null}
    </span>
  );
}

function safetyGradeKey(coin: ComparisonCoinEntry): string {
  const card = coin.safetyCard;
  const isUngradedFund = isTokenizedFundId(coin.meta.id)
    || (card?.ratingStatus === "not-rated" && card.nrReasons.some((reason) => reason.code === "tokenized-fund-not-graded"));
  if (isUngradedFund && card?.ratingStatus !== "pipeline-gap") return "tokenized-fund-not-graded";
  if (!card) return NULL_KEY;
  if (card.ratingStatus === "pipeline-gap") return "pipeline-gap";
  const partial = describePartialEvidence(card);
  return `${card.grade ?? ""}:${card.score != null ? Math.round(card.score) : ""}:${partial?.gaps.join(",") ?? ""}`;
}

function renderDewsCell(coin: ComparisonCoinEntry): ReactNode {
  if (!coin.stress) return NULL_VALUE;
  const band = coin.stress.band;
  const scoreText = formatScore(coin.stress.score, { trimInteger: true });
  if (isThreatBand(band)) {
    const style = THREAT_BAND_STYLES[band];
    return (
      <span className="inline-flex flex-col items-center">
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-2xs font-semibold",
            style.cls,
          )}
        >
          <span>{THREAT_BAND_LABELS[band]}</span>
          <span className="opacity-80">· {scoreText}</span>
        </span>
        <ScoreTrackBar value={coin.stress.score} tone="muted" />
      </span>
    );
  }
  return (
    <span className="inline-flex flex-col items-center">
      <span>{band} · {scoreText}</span>
      <ScoreTrackBar value={coin.stress.score} tone="muted" />
    </span>
  );
}

function dewsKey(coin: ComparisonCoinEntry): string {
  if (!coin.stress) return NULL_KEY;
  return `${coin.stress.band}:${formatScore(coin.stress.score, { trimInteger: true })}`;
}

function buildSections(): ComparisonSection[] {
  return [
    {
      key: "overview",
      title: "Overview",
      shortLabel: "Overview",
      description: "Current state first, then the compact substitution view: peg, scale, safety, liquidity, and design. Market-cap changes use USD-valued circulation, not token counts or price returns.",
      metrics: [
        { key: "state", label: "Current state", render: renderCoinStates, compareValue: coinStatesKey },
        {
          key: "price",
          label: "Price",
          numeric: true,
          render: (coin) => formatComparisonPrice(
            coin.data,
            coin.meta.flags.pegCurrency ?? "USD",
            coin.meta.flags.navToken ? coin.navPriceReference ?? null : undefined,
            coin.pegDetails,
          ),
          compareValue: (coin) => formatComparisonPrice(
            coin.data,
            coin.meta.flags.pegCurrency ?? "USD",
            coin.meta.flags.navToken ? coin.navPriceReference ?? null : undefined,
            coin.pegDetails,
          ),
        },
        {
          key: "deviation",
          label: "Peg deviation",
          numeric: true,
          render: (coin) => {
            const read = resolveCurrentDeviation(
              coin.data, coin.pegDetails, coin.meta.flags.navToken ? null : coin.meta.flags.pegCurrency,
            );
            return read.referenceNote
              ? <span className="text-muted-foreground">{read.referenceNote}</span>
              : formatComparisonBps(read.deviationBps);
          },
          compareValue: (coin) => {
            const read = resolveCurrentDeviation(
              coin.data, coin.pegDetails, coin.meta.flags.navToken ? null : coin.meta.flags.pegCurrency,
            );
            return read.referenceNote ?? formatComparisonBpsText(read.deviationBps) ?? NULL_KEY;
          },
        },
        { key: "peg-score", label: <MethodologyLabel topic="pegScore">Peg Score</MethodologyLabel>, numeric: true, render: renderPegScore, compareValue: pegScoreKey },
        { key: "market-cap", label: "Market cap", numeric: true, render: formatCurrentSupply, compareValue: (coin) => formatCurrentSupplyText(coin) ?? NULL_KEY },
        { key: "supply-24h", label: "Market-cap change · 24h", numeric: true, render: (coin) => formatSupplyChange(coin, "day"), compareValue: (coin) => formatSupplyChangeText(coin, "day") ?? NULL_KEY },
        { key: "supply-7d", label: "Market-cap change · 7d", numeric: true, render: (coin) => formatSupplyChange(coin, "week"), compareValue: (coin) => formatSupplyChangeText(coin, "week") ?? NULL_KEY },
        { key: "supply-30d", label: "Market-cap change · 30d", numeric: true, render: (coin) => formatSupplyChange(coin, "month"), compareValue: (coin) => formatSupplyChangeText(coin, "month") ?? NULL_KEY },
        { key: "safety", label: <MethodologyLabel topic="safetyScore">Safety</MethodologyLabel>, numeric: true, render: safetyGradeLabel, compareValue: safetyGradeKey },
        { key: "liquidity", label: <MethodologyLabel topic="liquidityScore">Liquidity</MethodologyLabel>, numeric: true, render: (coin) => formatScore100(coin.liquidity?.liquidityScore), compareValue: (coin) => score100Key(coin.liquidity?.liquidityScore) },
        {
          key: "mechanism",
          label: "Mechanism",
          render: (coin) => coin.meta.mechanismArchetype
            ? MECHANISM_ARCHETYPE_SHORT_LABELS[coin.meta.mechanismArchetype]
            : NULL_VALUE,
          compareValue: (coin) => coin.meta.mechanismArchetype
            ? MECHANISM_ARCHETYPE_SHORT_LABELS[coin.meta.mechanismArchetype]
            : NULL_KEY,
        },
      ],
    },
    {
      key: "peg",
      title: "Peg track record",
      shortLabel: "Peg",
      description: "Time at peg is a record-derived estimate, not proof of recovery or continuous observation. Tracking closure can leave unobserved time.",
      metrics: [
        { key: "active-depeg", label: "Open recorded incident", render: (coin) => coin.pegDetails ? (coin.pegDetails.activeDepeg ? "Yes" : "No") : NULL_VALUE, compareValue: (coin) => coin.pegDetails ? (coin.pegDetails.activeDepeg ? "Yes" : "No") : NULL_KEY },
        { key: "peg-90d", label: "Time at peg · up to 90d", numeric: true, describedBySection: true, render: (coin) => renderRecentPegOccupancy(coin.pegDetails?.recent90d), compareValue: (coin) => recentPegOccupancyKey(coin.pegDetails?.recent90d) },
        { key: "incidents-90d", label: "Incidents · 90d", numeric: true, render: (coin) => coin.pegDetails?.recent90d ? formatCount(coin.pegDetails.recent90d.incidentCount, "incident") : NULL_VALUE, compareValue: (coin) => coin.pegDetails?.recent90d ? formatCountText(coin.pegDetails.recent90d.incidentCount, "incident") ?? NULL_KEY : NULL_KEY },
        { key: "worst-deviation", label: "Worst deviation", numeric: true, render: (coin) => formatComparisonBps(coin.pegDetails?.worstDeviationBps), compareValue: (coin) => formatComparisonBpsText(coin.pegDetails?.worstDeviationBps) ?? NULL_KEY },
        { key: "event-count", label: "Recorded incidents", numeric: true, render: (coin) => coin.pegDetails ? formatCount(coin.pegDetails.eventCount, "incident") : NULL_VALUE, compareValue: (coin) => coin.pegDetails ? formatCountText(coin.pegDetails.eventCount, "incident") ?? NULL_KEY : NULL_KEY },
        { key: "tracking-span", label: "Tracking span", numeric: true, render: (coin) => formatDays(coin.pegDetails?.trackingSpanDays), compareValue: (coin) => formatDaysText(coin.pegDetails?.trackingSpanDays) ?? NULL_KEY },
        { key: "price-confidence", label: "Price confidence", render: (coin) => humanize(resolveCurrentPeg(coin.data, coin.pegDetails)?.priceConfidence), compareValue: (coin) => humanizeText(resolveCurrentPeg(coin.data, coin.pegDetails)?.priceConfidence) ?? NULL_KEY },
        { key: "price-sources", label: "Price sources", numeric: true, render: (coin) => resolveCurrentPeg(coin.data, coin.pegDetails) ? formatCount(resolveCurrentPeg(coin.data, coin.pegDetails)?.consensusSources?.length ?? 0, "source") : NULL_VALUE, compareValue: (coin) => resolveCurrentPeg(coin.data, coin.pegDetails) ? formatCountText(resolveCurrentPeg(coin.data, coin.pegDetails)?.consensusSources?.length ?? 0, "source") ?? NULL_KEY : NULL_KEY },
      ],
    },
    {
      key: "safety",
      title: "Safety construction",
      shortLabel: "Safety",
      description: "Exact safety pillars, binding constraints, access posture, and dependency exposure.",
      metrics: [
        { key: "backing-pillar", label: "Backing pillar", numeric: true, render: (coin) => formatScore100(coin.safetyCard?.pillars.backing.score), compareValue: (coin) => score100Key(coin.safetyCard?.pillars.backing.score) },
        { key: "exit-pillar", label: "Exit pillar", numeric: true, render: (coin) => formatScore100(coin.safetyCard?.pillars.exit.score), compareValue: (coin) => score100Key(coin.safetyCard?.pillars.exit.score) },
        { key: "control-pillar", label: "Control pillar", numeric: true, render: (coin) => formatScore100(coin.safetyCard?.pillars.control.score), compareValue: (coin) => score100Key(coin.safetyCard?.pillars.control.score) },
        {
          key: "weakest-pillar",
          label: "Weakest pillar",
          render: (coin) => coin.safetyCard?.weakestPillar ? `${humanizeSafetyScoreV9Value(coin.safetyCard.weakestPillar.pillar)} · ${formatScore(coin.safetyCard.weakestPillar.score, { trimInteger: true })}` : NULL_VALUE,
          compareValue: (coin) => coin.safetyCard?.weakestPillar ? `${coin.safetyCard.weakestPillar.pillar}:${formatScore(coin.safetyCard.weakestPillar.score, { trimInteger: true })}` : NULL_KEY,
        },
        { key: "binding-cap", label: "Binding cap", render: bindingCapSummary, compareValue: (coin) => bindingCapSummaryText(coin) ?? NULL_KEY },
        {
          key: "evidence",
          label: "Evidence",
          render: (coin) => coin.safetyCard ? `${humanizeSafetyScoreV9Value(coin.safetyCard.evidence.level)} · ${coin.safetyCard.evidence.freshness === "unknown" ? "Freshness not assessed" : humanizeSafetyScoreV9Value(coin.safetyCard.evidence.freshness)}` : NULL_VALUE,
          compareValue: (coin) => coin.safetyCard ? `${coin.safetyCard.evidence.level}:${coin.safetyCard.evidence.freshness}` : NULL_KEY,
        },
        {
          key: "top-driver",
          label: "Top driver",
          render: (coin) => {
            if (!coin.safetyCard) return NULL_VALUE;
            // A pipeline gap is technical unavailability, not a withheld verdict;
            // it has no score-bearing driver to project.
            if (coin.safetyCard.ratingStatus === "pipeline-gap") return NULL_VALUE;
            const driver = projectTopDriver(coin.safetyCard);
            return driver ? (
              <SafetyScoreTopDriver driver={driver} coinId={coin.id} subjectLabel={coin.symbol} />
            ) : NULL_VALUE;
          },
          compareValue: (coin) => {
            if (!coin.safetyCard || coin.safetyCard.ratingStatus === "pipeline-gap") return NULL_KEY;
            const driver = projectTopDriver(coin.safetyCard);
            return driver ? JSON.stringify(driver) : NULL_KEY;
          },
        },
        { key: "primary-exit", label: "Primary exit access", render: (coin) => humanize(coin.safetyCard?.accessPosture.primaryExit), compareValue: (coin) => humanizeText(coin.safetyCard?.accessPosture.primaryExit) ?? NULL_KEY },
        { key: "freeze-exposure", label: "Freeze exposure", render: (coin) => humanize(coin.safetyCard?.accessPosture.freezeExposure), compareValue: (coin) => humanizeText(coin.safetyCard?.accessPosture.freezeExposure) ?? NULL_KEY },
        { key: "dependencies", label: "Scored dependencies", render: dependencySummary, compareValue: (coin) => dependencySummaryText(coin) ?? NULL_KEY },
        {
          key: "bluechip",
          label: "External Bluechip",
          render: (coin) => {
            if (!coin.bluechipRating) return coin.bluechipPublicationAvailable ? "Not rated" : NULL_VALUE;
            const audit = coin.bluechipRating.smartContractAudit == null
              ? "audit not reported"
              : coin.bluechipRating.smartContractAudit
                ? "audit recorded"
                : "no audit flag";
            const observationText = bluechipObservationText(coin.bluechipRating.lastObservedAt, Math.floor(Date.now() / 1000));
            return <span title={observationText}>{`${coin.bluechipRating.grade} · ${audit}`}<span className="sr-only">{` · ${observationText}`}</span></span>;
          },
          compareValue: (coin) => {
            if (!coin.bluechipRating) return coin.bluechipPublicationAvailable ? "not-rated" : NULL_KEY;
            return `${coin.bluechipRating.grade}:${String(coin.bluechipRating.smartContractAudit)}`;
          },
        },
      ],
    },
    {
      key: "exit",
      title: "Exit & Liquidity",
      shortLabel: "Exit & Liquidity",
      description: "Venue depth and the primary redemption route are shown separately, not blended.",
      metrics: [
        { key: "effective-tvl", label: "Effective DEX TVL", numeric: true, render: (coin) => coin.liquidity ? formatCurrency(coin.liquidity.effectiveTvlUsd) : NULL_VALUE, compareValue: (coin) => coin.liquidity ? formatCurrency(coin.liquidity.effectiveTvlUsd) : NULL_KEY },
        { key: "volume-24h", label: "DEX volume · 24h", numeric: true, render: (coin) => coin.liquidity?.totalVolume24hUsd != null ? formatCurrency(coin.liquidity.totalVolume24hUsd) : NULL_VALUE, compareValue: (coin) => coin.liquidity?.totalVolume24hUsd != null ? formatCurrency(coin.liquidity.totalVolume24hUsd) : NULL_KEY },
        { key: "venues", label: "Pools / chains", numeric: true, render: (coin) => coin.liquidity ? `${coin.liquidity.poolCount} / ${coin.liquidity.chainCount}` : NULL_VALUE, compareValue: (coin) => coin.liquidity ? `${coin.liquidity.poolCount}/${coin.liquidity.chainCount}` : NULL_KEY },
        { key: "dex-evidence", label: "Liquidity evidence", render: (coin) => humanize(coin.liquidity?.liquidityEvidenceClass), compareValue: (coin) => humanizeText(coin.liquidity?.liquidityEvidenceClass) ?? NULL_KEY },
        { key: "concentration", label: "Venue concentration", numeric: true, render: (coin) => coin.liquidity?.concentrationHhi != null ? formatPercent(coin.liquidity.concentrationHhi * 100, 0) : NULL_VALUE, compareValue: (coin) => coin.liquidity?.concentrationHhi != null ? formatPercent(coin.liquidity.concentrationHhi * 100, 0) : NULL_KEY },
        { key: "redemption-score", label: "Redemption score", numeric: true, render: (coin) => formatScore100(coin.redemption?.score), compareValue: (coin) => score100Key(coin.redemption?.score) },
        { key: "route-status", label: "Redemption route", render: (coin) => coin.redemption ? `${humanizeSafetyScoreV9Value(coin.redemption.routeFamily)} · ${humanizeSafetyScoreV9Value(coin.redemption.routeStatus)}` : NULL_VALUE, compareValue: (coin) => coin.redemption ? `${coin.redemption.routeFamily}:${coin.redemption.routeStatus}` : NULL_KEY },
        { key: "holder-access", label: "Holder eligibility", render: (coin) => humanize(coin.redemption?.holderEligibility), compareValue: (coin) => humanizeText(coin.redemption?.holderEligibility) ?? NULL_KEY },
        { key: "settlement", label: "Settlement", render: (coin) => humanize(coin.redemption?.settlementModel), compareValue: (coin) => humanizeText(coin.redemption?.settlementModel) ?? NULL_KEY },
        { key: "capacity", label: "Immediate capacity", numeric: true, render: (coin) => coin.redemption?.immediateCapacityUsd != null ? formatCurrency(coin.redemption.immediateCapacityUsd) : NULL_VALUE, compareValue: (coin) => coin.redemption?.immediateCapacityUsd != null ? formatCurrency(coin.redemption.immediateCapacityUsd) : NULL_KEY },
        { key: "fee", label: "Redemption fee", numeric: true, render: (coin) => coin.redemption?.feeBps != null ? `${coin.redemption.feeBps.toFixed(0)} bps` : NULL_VALUE, compareValue: (coin) => coin.redemption?.feeBps != null ? `${coin.redemption.feeBps.toFixed(0)}` : NULL_KEY },
      ],
    },
    {
      key: "activity",
      title: "Activity & Yield",
      shortLabel: "Activity & Yield",
      description: "Directional issuance and yield context; larger values are not treated as automatically better.",
      metrics: [
        { key: "dews", label: "DEWS", numeric: true, render: renderDewsCell, compareValue: dewsKey },
        { key: "pressure", label: "Pressure Shift", numeric: true, render: renderFlowPressure, compareValue: flowPressureKey },
        { key: "flow-24h", label: "Net flow · 24h", numeric: true, render: (coin) => renderFlowNet(coin, "24h"), compareValue: (coin) => flowNetKey(coin, "24h") },
        { key: "flow-7d", label: "Net flow · 7d", numeric: true, render: (coin) => renderFlowNet(coin, "7d"), compareValue: (coin) => flowNetKey(coin, "7d") },
        { key: "flow-30d", label: "Net flow · 30d", numeric: true, render: (coin) => renderFlowNet(coin, "30d"), compareValue: (coin) => flowNetKey(coin, "30d") },
        { key: "flow-90d", label: "Net flow · 90d", numeric: true, render: (coin) => renderFlowNet(coin, "90d"), compareValue: (coin) => flowNetKey(coin, "90d") },
        { key: "apy-30d", label: "APY · 30d", numeric: true, render: (coin) => coin.yield ? formatPercent(coin.yield.apy30d) : NULL_VALUE, compareValue: (coin) => coin.yield ? formatPercent(coin.yield.apy30d) : NULL_KEY },
        { key: "excess-yield", label: "Excess yield", numeric: true, render: (coin) => coin.yield ? formatSignedPercent(coin.yield.excessYield) : NULL_VALUE, compareValue: (coin) => coin.yield ? formatSignedPercent(coin.yield.excessYield) : NULL_KEY },
        { key: "pys", label: "Pharos Yield Score", numeric: true, render: (coin) => formatScore100(coin.yield?.pharosYieldScore), compareValue: (coin) => score100Key(coin.yield?.pharosYieldScore) },
        { key: "yield-stability", label: "Yield stability", numeric: true, render: (coin) => coin.yield?.yieldStability != null ? formatPercentFromRatio(coin.yield.yieldStability, 0) : NULL_VALUE, compareValue: (coin) => coin.yield?.yieldStability != null ? formatPercentFromRatio(coin.yield.yieldStability, 0) : NULL_KEY },
        { key: "yield-source", label: "Yield source", render: (coin) => present(coin.yield?.yieldSource), compareValue: (coin) => presentKey(coin.yield?.yieldSource) },
        { key: "yield-tvl", label: "Yield source TVL", numeric: true, render: (coin) => coin.yield?.sourceTvlUsd != null ? formatCurrency(coin.yield.sourceTvlUsd) : NULL_VALUE, compareValue: (coin) => coin.yield?.sourceTvlUsd != null ? formatCurrency(coin.yield.sourceTvlUsd) : NULL_KEY },
      ],
    },
    {
      key: "structure",
      title: "Structure & Controls",
      shortLabel: "Control & Structure",
      description: "Curated design, custody, control, reserve, and regulatory context.",
      metrics: [
        { key: "peg-target", label: "Peg target", render: (coin) => coin.meta.flags.pegCurrency, compareValue: (coin) => coin.meta.flags.pegCurrency },
        { key: "backing", label: "Backing", render: (coin) => BACKING_LABELS_SHORT[coin.meta.flags.backing] ?? coin.meta.flags.backing, compareValue: (coin) => coin.meta.flags.backing },
        { key: "governance", label: "Governance", render: (coin) => GOVERNANCE_LABELS[coin.meta.flags.governance] ?? coin.meta.flags.governance, compareValue: (coin) => coin.meta.flags.governance },
        { key: "launch", label: "Launch date", numeric: true, render: (coin) => present(coin.meta.launchDate), compareValue: (coin) => presentKey(coin.meta.launchDate) },
        { key: "reserves", label: "Largest reserve exposure", render: reserveSummary, compareValue: (coin) => reserveSummaryText(coin) ?? NULL_KEY },
        { key: "collateral-quality", label: "Collateral quality", render: (coin) => coin.meta.collateralQuality ? COLLATERAL_QUALITY_LABELS[coin.meta.collateralQuality] : NULL_VALUE, compareValue: (coin) => coin.meta.collateralQuality ?? NULL_KEY },
        { key: "custody", label: "Custody model", render: (coin) => coin.meta.custodyModel ? CUSTODY_MODEL_LABELS[coin.meta.custodyModel] : NULL_VALUE, compareValue: (coin) => coin.meta.custodyModel ?? NULL_KEY },
        { key: "mint-authority", label: "Mint authority", render: (coin) => resolveMintAuthorityStatus(coin.meta.mintAuthoritySummary).spokenLabel, compareValue: (coin) => resolveMintAuthorityStatus(coin.meta.mintAuthoritySummary).spokenLabel },
        { key: "blacklist", label: "Freeze capability", render: blacklistLabel, compareValue: blacklistLabel },
        { key: "variant", label: "Variant relationship", render: variantSummaryText, compareValue: variantSummaryText },
        { key: "mica", label: "MiCA", render: (coin) => coin.meta.mica ? `${MICA_STATUS_BADGE_STYLES[coin.meta.mica.status].label}${coin.meta.mica.tokenType ? ` · ${coin.meta.mica.tokenType}` : ""}` : "Not researched", compareValue: (coin) => coin.meta.mica ? `${coin.meta.mica.status}:${coin.meta.mica.tokenType ?? ""}` : "not-researched" },
        { key: "genius", label: "GENIUS pathway", render: (coin) => coin.meta.genius ? GENIUS_STATUS_SHORT_LABELS[coin.meta.genius.authorizationStatus] : "Not researched", compareValue: (coin) => coin.meta.genius ? coin.meta.genius.authorizationStatus : "not-researched" },
      ],
    },
  ];
}

function FrozenBadge({ frozenAt }: { frozenAt?: string }) {
  return (
    <span
      className="rounded-sm border border-border px-1 text-3xs uppercase text-muted-foreground"
      title={frozenAt ? `Frozen on ${frozenAt}` : "Frozen"}
    >
      Frozen
    </span>
  );
}

const sections = buildSections();
const TOTAL_METRIC_COUNT = sections.reduce((sum, section) => sum + section.metrics.length, 0);

function rowHasDifference(metric: ComparisonMetric, coins: readonly ComparisonCoinEntry[]): boolean {
  if (coins.length < 2) return true;
  const first = metric.compareValue(coins[0]!);
  for (let i = 1; i < coins.length; i++) {
    if (metric.compareValue(coins[i]!) !== first) return true;
  }
  return false;
}

export const ComparisonTable = memo(function ComparisonTable({ coins, logos, detailErrors }: ComparisonTableProps) {
  const [differencesOnly, setDifferencesOnly] = useState(false);

  const visibleSections = useMemo(() => {
    if (!differencesOnly || coins.length < 2) return sections;
    return sections
      .map((section) => ({
        ...section,
        metrics: section.metrics.filter((metric) => rowHasDifference(metric, coins)),
      }))
      .filter((section) => section.metrics.length > 0);
  }, [coins, differencesOnly]);

  const visibleMetricCount = useMemo(
    () => visibleSections.reduce((sum, section) => sum + section.metrics.length, 0),
    [visibleSections],
  );

  if (coins.length === 0) {
    return <div className="pharos-empty-note py-8 text-center">Select stablecoins above to compare them side-by-side.</div>;
  }

  return (
    <div className="space-y-3">
      <div className="pharos-subtle-band space-y-2.5">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="pharos-label">Comparison matrix</p>
            <p className="mt-0.5 text-sm text-foreground">Exact values across market, risk, exit, activity, and structure.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {coins.length >= 2 ? (
              <button
                type="button"
                aria-pressed={differencesOnly}
                onClick={() => setDifferencesOnly((prev) => !prev)}
                className={cn(
                  "pharos-focus-ring pharos-control-pill min-h-11 px-3 py-1.5 text-xs font-medium sm:min-h-8",
                  differencesOnly && "pharos-control-pill-active",
                )}
              >
                Differences only
                {differencesOnly ? (
                  <span className="pharos-numeric ml-1.5 text-muted-foreground">
                    ({visibleMetricCount}/{TOTAL_METRIC_COUNT})
                  </span>
                ) : null}
              </button>
            ) : null}
            <p className="pharos-meta">A dash means that source has no comparable value; it is not a zero.</p>
          </div>
        </div>

        {visibleSections.length > 0 ? (
          <nav aria-label="Jump to comparison section" className="flex flex-wrap items-center gap-1.5">
            {visibleSections.map((section) => (
              <a
                key={section.key}
                href={`#compare-section-${section.key}`}
                className="pharos-focus-ring pharos-control-pill inline-flex min-h-9 items-center px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground sm:min-h-7"
              >
                {section.shortLabel}
              </a>
            ))}
          </nav>
        ) : null}
      </div>

      {visibleSections.length === 0 ? (
        <div className="pharos-empty-note flex flex-col items-center gap-2 py-8 text-center">
          <p className="text-sm text-foreground">All compared metrics match across the selected coins.</p>
          <button
            type="button"
            onClick={() => setDifferencesOnly(false)}
            className="pharos-focus-ring pharos-control-pill min-h-11 px-3.5 py-1.5 text-xs font-medium sm:min-h-8"
          >
            Show all rows
          </button>
        </div>
      ) : (
        <TableFrame
          tableId="live-comparison-matrix"
          testId="live-comparison-matrix-table"
          role="region"
          aria-label="Stablecoin comparison matrix"
          tabIndex={0}
          tableAriaLabel="Stablecoin comparison matrix"
          chrome="default"
          density="compact"
          stickyHeader
          stickyMode="page"
        >
          <TableHeader>
            <TableRow>
              <TableHead scope="col" className="pharos-table-sticky-metric z-10 min-w-[10rem] bg-card">Metric</TableHead>
              {coins.map((coin) => (
                <TableHead scope="col" key={coin.id} className="min-w-[9.5rem] bg-card text-center align-top">
                  <Link
                    href={buildStablecoinUrl(coin.id)}
                    className="pharos-focus-ring inline-flex w-full flex-col items-center gap-1 rounded-md px-2 py-2"
                  >
                    <StablecoinLogo src={logos?.[coin.id]} name={coin.name} size={28} />
                    <span className="flex items-center gap-1 text-xs font-semibold text-foreground">
                      {coin.symbol}
                      {coin.meta.status === "frozen" ? <FrozenBadge frozenAt={coin.meta.frozenAt} /> : null}
                    </span>
                    <span className="max-w-[8.5rem] truncate text-xs font-normal text-muted-foreground">{coin.name}</span>
                    {detailErrors?.[coin.id] ? <span className="text-3xs text-destructive">History unavailable</span> : null}
                  </Link>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleSections.map((section) => (
              <SectionRows key={section.key} section={section} coins={coins} />
            ))}
          </TableBody>
        </TableFrame>
      )}
    </div>
  );
});

// Whole-day flooring matches the detail page's recent-window basis; a positive sub-day basis is <1d.
function formatOccupancyBasisDays(observedDays: number): string {
  const days = Math.floor(observedDays);
  return days === 0 && observedDays > 0 ? "<1d" : `${days}d`;
}

function recentPegOccupancyKey(recent: NonNullable<ComparisonCoinEntry["pegDetails"]>["recent90d"] | undefined): string {
  if (!recent) return NULL_KEY;
  const value = recent.pegPct == null ? NULL_KEY : formatPegOccupancy(recent.pegPct);
  return recent.coverageLimited ? `${value}:${formatOccupancyBasisDays(recent.observedDays)}` : value;
}

function renderRecentPegOccupancy(recent: NonNullable<ComparisonCoinEntry["pegDetails"]>["recent90d"] | undefined): ReactNode {
  if (!recent) return NULL_VALUE;
  const value = recent.pegPct == null ? NULL_VALUE : formatPegOccupancy(recent.pegPct);
  if (!recent.coverageLimited) return value;
  // Only a limited window carries an inline basis marker; a full window adds nothing under the value.
  const days = formatOccupancyBasisDays(recent.observedDays);
  const basis = `Based on ${days}`;
  return (
    <>
      {value}
      <span className="text-muted-foreground" title={`${basis} · Partial 90-day coverage`}>
        {` · ${days}`}<span className="sr-only"> of partial 90-day coverage</span>
      </span>
    </>
  );
}

function SectionRows({ section, coins }: { section: ComparisonSection; coins: ComparisonCoinEntry[] }) {
  const descriptionId = `${useId()}-description`;
  return (
    <>
      <TableRow id={`compare-section-${section.key}`} className="scroll-mt-36 hover:bg-muted/30">
        <TableHead colSpan={coins.length + 1} className="bg-muted/35 px-3 py-3 text-left">
          <span className="block text-sm font-semibold text-foreground">{section.title}</span>
          <span id={descriptionId} className="mt-0.5 block text-xs font-normal text-muted-foreground">{section.description}</span>
        </TableHead>
      </TableRow>
      {section.metrics.map((metric) => (
        <TableRow key={metric.key}>
          <TableHead scope="row" className="pharos-table-sticky-metric min-w-[10rem] bg-card font-medium text-foreground">
            {metric.label}
          </TableHead>
          {coins.map((coin) => (
            <TableCell
              key={coin.id}
              className={`max-w-[14rem] whitespace-normal text-center text-xs ${metric.numeric ? "pharos-numeric" : ""}`}
              aria-describedby={metric.describedBySection ? descriptionId : undefined}
            >
              {metric.render(coin)}
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}
