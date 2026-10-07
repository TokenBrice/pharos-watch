import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import type {
  ReserveAssetClass,
  ReserveLiquidityHorizon,
  ReserveRisk,
  ReserveRiskFactor,
  ReserveSlice,
  StablecoinLink,
  StablecoinMeta,
} from "@shared/types";
import { RESERVE_RISK_PRESENTATION } from "@shared/lib/classification/reserve-risk";
import { RESEARCH_REVIEW_CONFIDENCE_LABELS } from "@shared/lib/classification";
import { round1 } from "@shared/lib/math";

/**
 * Client-safe projection of the curated reserve slices' quality attributes
 * (asset class, liquidity horizon, obligor, risk factors) plus the server-only
 * `reserveReview` aggregates, in the `projectOracleRiskClientSummary` pattern:
 * bounded labels and formatted figures only. The review's rationale and
 * per-disposition prose stay server-side; the module renders the reviewed-slice
 * treemap, the liquidation ladder, and the review's own disclosure-quality numbers.
 *
 * Aggregates only the curated composition (`coin.reserves`) — never the live
 * reserve feed or category templates, which do not carry quality attributes.
 */
export interface ReserveQualityLadderClientRow {
  key: ReserveLiquidityHorizon;
  label: string;
  pct: number;
}

export interface ReserveQualitySliceClientRow {
  key: string;
  name: string;
  pct: number;
  assetClassLabel: string | null;
  horizonLabel: string | null;
  riskLabel: string;
  /** Reviewed risk tier, the treemap's tone channel. */
  risk: ReserveRisk;
  obligor: string | null;
  riskFactorLabels: string[];
}

export interface ReserveQualityClientSummary {
  chipLabel: string;
  chipToneClass: string;
  lede: string;
  ladder: ReserveQualityLadderClientRow[];
  liquidWithinOneDayPct: number;
  unknownHorizonPct: number;
  /** `reserveReview.knownUnknownExposurePct` — total share of unresolved reserve dispositions. */
  unidentifiedObligorsPct: number | null;
  /** Share of the basket the review marks as self-reserve (issuer's own assets). */
  selfExposurePct: number | null;
  topPositionName: string | null;
  topPositionPct: number | null;
  asOf: string | null;
  sliceCount: number;
  confidenceLabel: string | null;
  reviewedAt: string | null;
  compositionBasis: string | null;
  knownUnknownExposureNote: string | null;
  slices: ReserveQualitySliceClientRow[];
  sources: StablecoinLink[];
}

const ASSET_CLASS_LABELS: Record<ReserveAssetClass, string> = {
  cash: "Cash",
  "bank-deposit": "Bank deposits",
  "treasury-bill": "Treasury bills",
  "government-security": "Government securities",
  repo: "Repo",
  "money-market-fund": "Money-market funds",
  stablecoin: "Stablecoins",
  cryptoasset: "Cryptoassets",
  "hedged-crypto": "Hedged crypto",
  "private-credit": "Private credit",
  "public-credit": "Public credit",
  "tokenized-security": "Tokenized securities",
  "fund-share": "Fund shares",
  "protocol-position": "Protocol positions",
  "commodity-allocated": "Allocated commodities",
  other: "Other assets",
};

const LADDER_ORDER: readonly ReserveLiquidityHorizon[] = [
  "immediate",
  "one-day",
  "seven-days",
  "over-seven-days",
  "unknown",
];

const HORIZON_LABELS: Record<ReserveLiquidityHorizon, string> = {
  immediate: "Immediate",
  "one-day": "≤ 1 day",
  "seven-days": "≤ 7 days",
  "over-seven-days": "> 7 days",
  unknown: "Unknown",
};

const RISK_FACTOR_LABELS: Record<ReserveRiskFactor, string> = {
  credit: "credit",
  duration: "duration",
  liquidity: "liquidity",
  custody: "custody",
  counterparty: "counterparty",
  "smart-contract": "smart contract",
  market: "market",
  basis: "basis",
  legal: "legal",
  concentration: "concentration",
  leverage: "leverage",
};

/**
 * A single position at or above this share surfaces as a concentration fact —
 * but only when the slice itself carries medium-or-worse risk; a 61% T-bill
 * allocation is not a concentration finding.
 */
const TOP_POSITION_MIN_PCT = 20;

const TOP_POSITION_RISKS: ReadonlySet<ReserveRisk> = new Set(["medium", "high", "very-high"]);

/**
 * The one-day liquidity fact turns amber below this share, and the verdict chip
 * drops from the ok/info tones to watch at the same line: a basket converting
 * less than 60% of itself within a day is the module's own "not mostly liquid"
 * boundary, so the fact and the chip never disagree about breach.
 */
export const LIQUID_WITHIN_ONE_DAY_WATCH_BELOW_PCT = 60;

// Shared severity pills: the same strings the oracle tier chip and
// `COLLATERAL_COVERAGE_PILL_CLASSES` (`@shared/lib/classification`) use.
const CHIP_TONES = {
  ok: SEVERITY_TONE_CLASS.ok.pill,
  info: SEVERITY_TONE_CLASS.info.pill,
  watch: SEVERITY_TONE_CLASS.watch.pill,
} as const;

/** Rounds to at most 1 decimal and trims trailing zeros, e.g. 12.56 -> "12.6%", 71 -> "71%". */
export function formatReserveQualityPct(value: number): string {
  if (value > 0 && value < 0.1) return "<0.1%";
  return `${Number(value.toFixed(1))}%`;
}

interface ChipVerdict {
  label: string;
  toneClass: string;
}

/**
 * Liquidity-led chip: the headline is how much of the basket converts within a
 * day, except when the unknown-horizon share is large enough that the honest
 * headline is opacity itself.
 */
function resolveChip(liquidWithinOneDayPct: number, unknownHorizonPct: number): ChipVerdict {
  if (liquidWithinOneDayPct >= 90) return { label: "Highly liquid", toneClass: CHIP_TONES.ok };
  if (liquidWithinOneDayPct >= LIQUID_WITHIN_ONE_DAY_WATCH_BELOW_PCT) return { label: "Mostly liquid", toneClass: CHIP_TONES.info };
  if (unknownHorizonPct >= 40) return { label: "Opaque exit", toneClass: CHIP_TONES.watch };
  return { label: "Mixed liquidity", toneClass: CHIP_TONES.watch };
}

/**
 * The convertibility figure is only a measurement of the part of the basket
 * whose liquidation timeline the issuer actually published. Leading with it
 * unqualified turns a disclosure gap into an illiquidity claim — a fully
 * undisclosed ladder reported "0% convertible within one day" (owner feedback
 * 2026-08-18). So the sentence branches on the unknown share *before* any
 * percentage is emitted:
 *
 * - fully undisclosed → no convertibility figure at all, only the gap;
 * - partly undisclosed → "at least X%", which is the honest floor, since the
 *   undisclosed remainder may convert just as fast;
 * - fully disclosed → the plain measurement, unchanged.
 */
function buildConvertibilityClause(liquidWithinOneDayPct: number, unknownHorizonPct: number): string {
  if (unknownHorizonPct >= 100) {
    return "no published exit timeline for any of the basket.";
  }
  if (unknownHorizonPct > 0) {
    const disclosed =
      liquidWithinOneDayPct > 0
        ? `at least ${formatReserveQualityPct(liquidWithinOneDayPct)} convertible within one day`
        : "none of the disclosed basket converts within one day";
    return `${disclosed}; ${formatReserveQualityPct(unknownHorizonPct)} has no published exit timeline.`;
  }
  return `${formatReserveQualityPct(liquidWithinOneDayPct)} convertible within one day.`;
}

function buildLede(
  sliceCount: number,
  liquidWithinOneDayPct: number,
  unknownHorizonPct: number,
  unidentifiedObligorsPct: number | null,
  selfExposurePct: number | null,
): string {
  const sliceNoun = sliceCount === 1 ? "reviewed reserve slice" : "reviewed reserve slices";
  let lede = `${sliceCount} ${sliceNoun} — ${buildConvertibilityClause(liquidWithinOneDayPct, unknownHorizonPct)}`;
  if (unidentifiedObligorsPct != null && unidentifiedObligorsPct > 0) {
    lede += ` ${formatReserveQualityPct(unidentifiedObligorsPct)} of the basket has unresolved reserve exposure.`;
  }
  if (selfExposurePct != null && selfExposurePct > 0) {
    lede += ` ${formatReserveQualityPct(selfExposurePct)} is issuer self-exposure rather than independent collateral.`;
  }
  return lede;
}

function buildLadder(slices: readonly ReserveSlice[]): ReserveQualityLadderClientRow[] {
  const shares = new Map<ReserveLiquidityHorizon, number>();
  for (const slice of slices) {
    const horizon = slice.liquidityHorizon ?? "unknown";
    shares.set(horizon, (shares.get(horizon) ?? 0) + slice.pct);
  }
  return LADDER_ORDER.filter((horizon) => (shares.get(horizon) ?? 0) > 0).map((horizon) => ({
    key: horizon,
    label: HORIZON_LABELS[horizon],
    pct: round1(shares.get(horizon)!),
  }));
}

export function projectReserveQualityClientSummary(coin: StablecoinMeta): ReserveQualityClientSummary | null {
  const slices = coin.reserves ?? [];
  const hasQualityData =
    slices.some((slice) => slice.assetClass != null) && slices.some((slice) => slice.liquidityHorizon != null);
  if (!hasQualityData) return null;

  const review = coin.reserveReview ?? null;

  const ladder = buildLadder(slices);
  const ladderPct = (horizon: ReserveLiquidityHorizon): number =>
    ladder.find((row) => row.key === horizon)?.pct ?? 0;
  const liquidWithinOneDayPct = round1(ladderPct("immediate") + ladderPct("one-day"));
  const unknownHorizonPct = ladderPct("unknown");

  const selfReservePct = (review?.nonLinkDispositions ?? [])
    .filter((disposition) => disposition.disposition === "self-reserve")
    .reduce((total, disposition) => total + disposition.pct, 0);
  const selfExposurePct = selfReservePct > 0 ? round1(selfReservePct) : null;
  // Field-level guard: the client-coin builder feeds this projection before
  // stripping, and the stripping contract is tested with malformed sentinel
  // review objects — treat anything non-numeric as absent.
  const unidentifiedObligorsPct =
    typeof review?.knownUnknownExposurePct === "number" ? round1(review.knownUnknownExposurePct) : null;

  const topSlice = slices.reduce<ReserveSlice | null>(
    (top, slice) => (top == null || slice.pct > top.pct ? slice : top),
    null,
  );
  const hasTopPosition =
    topSlice != null &&
    slices.length > 1 &&
    topSlice.pct >= TOP_POSITION_MIN_PCT &&
    TOP_POSITION_RISKS.has(topSlice.risk);

  const chip = resolveChip(liquidWithinOneDayPct, unknownHorizonPct);

  return {
    chipLabel: chip.label,
    chipToneClass: chip.toneClass,
    lede: buildLede(slices.length, liquidWithinOneDayPct, unknownHorizonPct, unidentifiedObligorsPct, selfExposurePct),
    ladder,
    liquidWithinOneDayPct,
    unknownHorizonPct,
    unidentifiedObligorsPct,
    selfExposurePct,
    topPositionName: hasTopPosition ? topSlice.name : null,
    topPositionPct: hasTopPosition ? round1(topSlice.pct) : null,
    asOf: review?.compositionAsOf ?? null,
    sliceCount: slices.length,
    confidenceLabel:
      typeof review?.confidence === "string" ? (RESEARCH_REVIEW_CONFIDENCE_LABELS[review.confidence] ?? review.confidence) : null,
    reviewedAt: review?.reviewedAt ?? null,
    compositionBasis: review?.compositionBasis ?? null,
    knownUnknownExposureNote: review?.knownUnknownExposure ?? null,
    slices: slices.map((slice, index) => ({
      key: `${slice.name}:${index}`,
      name: slice.name,
      pct: slice.pct,
      risk: slice.risk,
      assetClassLabel: slice.assetClass ? ASSET_CLASS_LABELS[slice.assetClass] : null,
      horizonLabel: slice.liquidityHorizon ? HORIZON_LABELS[slice.liquidityHorizon] : null,
      riskLabel: RESERVE_RISK_PRESENTATION[slice.risk].shortLabel,
      obligor: slice.issuerOrObligor ?? null,
      riskFactorLabels: (slice.riskFactors ?? []).map((factor) => RISK_FACTOR_LABELS[factor] ?? factor),
    })),
    sources: review?.sources ?? [],
  };
}
