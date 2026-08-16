import type { SeverityTone } from "@/lib/severity-tone";
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

/**
 * Client-safe projection of the curated reserve slices' quality attributes
 * (asset class, liquidity horizon, obligor, risk factors) plus the server-only
 * `reserveReview` aggregates, in the `projectOracleRiskClientSummary` pattern:
 * bounded labels and formatted figures only. The review's rationale and
 * per-disposition prose stay server-side; the module renders the mix, the
 * liquidation ladder, and the review's own disclosure-quality numbers.
 *
 * Aggregates only the curated composition (`coin.reserves`) — never the live
 * reserve feed or category templates, which do not carry quality attributes.
 */
export interface ReserveQualityMixClientRow {
  key: string;
  label: string;
  pct: number;
  /** Categorical data-series class by share rank; index 5 is the folded tail. */
  barClass: string;
}

export interface ReserveQualityLadderClientRow {
  key: ReserveLiquidityHorizon;
  /** Severity tone for the ladder bar fill; see `HORIZON_TONES`. */
  tone: SeverityTone;
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
  obligor: string | null;
  riskFactorLabels: string[];
}

export interface ReserveQualityClientSummary {
  chipLabel: string;
  chipToneClass: string;
  lede: string;
  mix: ReserveQualityMixClientRow[];
  ladder: ReserveQualityLadderClientRow[];
  liquidWithinOneDayPct: number;
  unknownHorizonPct: number;
  /** `reserveReview.knownUnknownExposurePct` — basket share with no identified obligor. */
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

/**
 * The ladder is an ordinal *risk* ramp, not a composition: how fast the basket
 * can actually be turned into cash. It therefore takes severity tones (owner
 * feedback 2026-08-11) — a same-day horizon and a beyond-a-week horizon are not
 * two shades of the same grey.
 *
 * `unknown` stays `neutral`: an unestablished exit timeline is an absence of
 * evidence, and absence of data does not get an alarm colour (owner ruling
 * §5.4). Its amber row label already flags it.
 */
const HORIZON_TONES: Record<ReserveLiquidityHorizon, SeverityTone> = {
  immediate: "ok",
  "one-day": "info",
  "seven-days": "watch",
  "over-seven-days": "alert",
  unknown: "neutral",
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

const CONFIDENCE_LABELS: Record<string, string> = {
  verified: "Verified",
  probable: "Probable",
  "manual-review": "Manual review",
  unknown: "Unknown",
};

/** Distinct asset classes rendered inline before the tail folds into one segment. */
const MIX_SEGMENT_LIMIT = 5;

/**
 * Asset mix is a *categorical composition* (T-bills vs repo vs private credit),
 * so it takes the categorical data-series palette rather than the severity ramp
 * — the classes are distinct kinds, not degrees of risk. The previous
 * share-ranked `bg-foreground/80…/10` monochrome ramp made adjacent segments
 * indistinguishable (owner feedback 2026-08-11: "hard to read with those
 * nuances of grey-black").
 *
 * Hues are drawn from the same sequence the donut charts use, which the owner
 * ratified as a legitimate wide palette for data series (plan §5.6). Index 5 is
 * the folded tail and stays muted so it reads as "everything else". Static
 * strings per the Tailwind hard rule.
 */
const MIX_BAR_CLASSES = [
  "bg-blue-500",
  "bg-cyan-500",
  "bg-violet-500",
  "bg-amber-500",
  "bg-teal-500",
  "bg-muted-foreground/40",
] as const;

const UNCLASSIFIED_MIX_KEY = "unclassified";

/**
 * A single position at or above this share surfaces as a concentration fact —
 * but only when the slice itself carries medium-or-worse risk; a 61% T-bill
 * allocation is not a concentration finding.
 */
const TOP_POSITION_MIN_PCT = 20;

const TOP_POSITION_RISKS: ReadonlySet<ReserveRisk> = new Set(["medium", "high", "very-high"]);

// Chip tone strings match the oracle/bridge TIER_TONES palette byte-for-byte.
const CHIP_TONES = {
  emerald: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  blue: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400",
  amber: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
} as const;

/** Rounds to at most 1 decimal and trims trailing zeros, e.g. 12.56 -> "12.6%", 71 -> "71%". */
export function formatReserveQualityPct(value: number): string {
  return `${Number(value.toFixed(1))}%`;
}

function round1(value: number): number {
  return Number(value.toFixed(1));
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
  if (liquidWithinOneDayPct >= 90) return { label: "Highly liquid", toneClass: CHIP_TONES.emerald };
  if (liquidWithinOneDayPct >= 60) return { label: "Mostly liquid", toneClass: CHIP_TONES.blue };
  if (unknownHorizonPct >= 40) return { label: "Opaque exit", toneClass: CHIP_TONES.amber };
  return { label: "Mixed liquidity", toneClass: CHIP_TONES.amber };
}

function buildLede(
  sliceCount: number,
  liquidWithinOneDayPct: number,
  unknownHorizonPct: number,
  unidentifiedObligorsPct: number | null,
  selfExposurePct: number | null,
): string {
  const sliceNoun = sliceCount === 1 ? "reviewed reserve slice" : "reviewed reserve slices";
  let lede = `${sliceCount} ${sliceNoun} — ${formatReserveQualityPct(liquidWithinOneDayPct)} convertible within one day`;
  if (unknownHorizonPct > 0) {
    lede += `, ${formatReserveQualityPct(unknownHorizonPct)} with no established exit timeline`;
  }
  lede += ".";
  if (unidentifiedObligorsPct != null && unidentifiedObligorsPct > 0) {
    lede += ` ${formatReserveQualityPct(unidentifiedObligorsPct)} of the basket has no identified obligor.`;
  }
  if (selfExposurePct != null && selfExposurePct > 0) {
    lede += ` ${formatReserveQualityPct(selfExposurePct)} is issuer self-exposure rather than independent collateral.`;
  }
  return lede;
}

function buildMix(slices: readonly ReserveSlice[]): ReserveQualityMixClientRow[] {
  const shares = new Map<string, { label: string; pct: number }>();
  for (const slice of slices) {
    const key = slice.assetClass ?? UNCLASSIFIED_MIX_KEY;
    const label = slice.assetClass ? ASSET_CLASS_LABELS[slice.assetClass] : "Unclassified";
    const existing = shares.get(key);
    if (existing) existing.pct += slice.pct;
    else shares.set(key, { label, pct: slice.pct });
  }

  const ranked = [...shares.entries()]
    .map(([key, entry]) => ({ key, label: entry.label, pct: entry.pct }))
    .sort((a, b) => b.pct - a.pct);

  const inline = ranked.slice(0, MIX_SEGMENT_LIMIT);
  const tail = ranked.slice(MIX_SEGMENT_LIMIT);
  const rows = inline.map((row, index) => ({
    key: row.key,
    label: row.label,
    pct: round1(row.pct),
    barClass: MIX_BAR_CLASSES[index]!,
  }));
  if (tail.length > 0) {
    rows.push({
      key: "mix-tail",
      label: tail.length === 1 ? tail[0]!.label : `${tail.length} smaller classes`,
      pct: round1(tail.reduce((total, row) => total + row.pct, 0)),
      barClass: MIX_BAR_CLASSES[MIX_SEGMENT_LIMIT]!,
    });
  }
  return rows;
}

function buildLadder(slices: readonly ReserveSlice[]): ReserveQualityLadderClientRow[] {
  const shares = new Map<ReserveLiquidityHorizon, number>();
  for (const slice of slices) {
    const horizon = slice.liquidityHorizon ?? "unknown";
    shares.set(horizon, (shares.get(horizon) ?? 0) + slice.pct);
  }
  return LADDER_ORDER.filter((horizon) => (shares.get(horizon) ?? 0) > 0).map((horizon) => ({
    key: horizon,
    tone: HORIZON_TONES[horizon],
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
    mix: buildMix(slices),
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
      typeof review?.confidence === "string" ? (CONFIDENCE_LABELS[review.confidence] ?? review.confidence) : null,
    reviewedAt: review?.reviewedAt ?? null,
    compositionBasis: review?.compositionBasis ?? null,
    knownUnknownExposureNote: review?.knownUnknownExposure ?? null,
    slices: slices.map((slice, index) => ({
      key: `${slice.name}:${index}`,
      name: slice.name,
      pct: round1(slice.pct),
      assetClassLabel: slice.assetClass ? ASSET_CLASS_LABELS[slice.assetClass] : null,
      horizonLabel: slice.liquidityHorizon ? HORIZON_LABELS[slice.liquidityHorizon] : null,
      riskLabel: RESERVE_RISK_PRESENTATION[slice.risk].shortLabel,
      obligor: slice.issuerOrObligor ?? null,
      riskFactorLabels: (slice.riskFactors ?? []).map((factor) => RISK_FACTOR_LABELS[factor] ?? factor),
    })),
    sources: review?.sources ?? [],
  };
}
