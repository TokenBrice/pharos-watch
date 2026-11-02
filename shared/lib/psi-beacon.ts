import type { PsiConditionBand } from "../types/stability-constants";
import { PSI_HEX_COLORS, PSI_UNKNOWN_BAND_HEX, isConditionBand } from "./classification/psi";
import { PSI_CONDITION_BANDS } from "./psi-policy";
import { numberValue } from "./type-guards";

/**
 * Pure view-model for the PSI beacon: the lighthouse beam is a 0–100 ruler.
 * Lit length is the score; the dark remainder out to 100 is one fog bank per
 * penalty component, so lit + fog − trend gain = 100 (the formula, made visible).
 * Presentation only: no formula, band or cap lives here (bands come from psi-policy).
 */

export type PsiBeaconPenaltyKey = "severity" | "breadth" | "stressBreadth";
export type PsiBeaconComponentKey = PsiBeaconPenaltyKey | "trend";

export interface PsiBeaconCurrentLike {
  score: number;
  band: string;
  avg24h?: number;
  avg24hBand?: string;
  computedAt: number;
  methodologyVersion?: string;
  components?: {
    severity: number | null;
    breadth: number | null;
    stressBreadth?: number | null;
    trend: number | null;
  };
  componentsUnavailable?: readonly PsiBeaconComponentKey[];
  inputDegradation?: {
    openDepegNoPrice?: boolean;
    openDepegsWithoutPrice?: number | null;
  };
}

export interface PsiBeaconStateInput {
  current: PsiBeaconCurrentLike | null | undefined;
  /** Query is pending with nothing to show yet. */
  isLoading?: boolean;
  /** Data-health verdict is `fresh` (the regime-bar rule); anything else is retained. */
  isFresh: boolean;
  /** Human health message, e.g. "Data is stale."; used as the unavailable/retained reason. */
  healthMessage?: string;
  /** Caller-formatted as-of stamp for the retained observation (frontend owns locale/timezone). */
  asOfLabel?: string;
}

export interface PsiBeaconReading {
  score: number;
  band: PsiConditionBand;
  avg24h: number | null;
  avg24hBand: PsiConditionBand | null;
  components: Record<PsiBeaconComponentKey, number | null>;
  /** Components the API names unavailable, or that arrived null. Never read as zero (R1). */
  unavailableComponents: PsiBeaconComponentKey[];
  /** Severity may be understated: open depegs without a usable price were skipped. */
  severityLowerBound: { unpricedCount: number | null } | null;
  computedAt: number;
  methodologyVersion: string | null;
}

export type PsiBeaconState =
  | { kind: "loading" }
  | { kind: "unavailable"; reason: string }
  | { kind: "current"; reading: PsiBeaconReading }
  | { kind: "retained"; reading: PsiBeaconReading; reason: string; asOfLabel: string | null };

const PENALTY_ORDER: readonly PsiBeaconPenaltyKey[] = ["severity", "breadth", "stressBreadth"];
const COMPONENT_KEYS: readonly PsiBeaconComponentKey[] = [...PENALTY_ORDER, "trend"];

export const PSI_BEACON_COMPONENT_LABELS: Record<PsiBeaconComponentKey, string> = {
  severity: "severity",
  breadth: "breadth",
  stressBreadth: "stress breadth",
  trend: "trend",
};

/** Display floor for a nonzero fog bank, in score points. Never published as a value (R7). */
export const PSI_BEACON_SLIVER_FLOOR = 0.3;
/**
 * Score is published at one decimal; components at more. Compare on the
 * published cent grid: a 6-cent rounding residual is valid, and quantizing
 * keeps binary float noise from flipping the boundary.
 */
const RECONCILE_TOLERANCE_CENTS = 6;

export function derivePsiBeaconState(input: PsiBeaconStateInput): PsiBeaconState {
  const { current } = input;
  if (!current) {
    if (input.isLoading) return { kind: "loading" };
    return { kind: "unavailable", reason: input.healthMessage ?? "No current PSI reading." };
  }
  if (!Number.isFinite(current.score) || current.score < 0 || current.score > 100) {
    return { kind: "unavailable", reason: "Current PSI score is not a valid reading." };
  }
  if (!isConditionBand(current.band)) {
    return { kind: "unavailable", reason: "Current PSI band is outside the published vocabulary." };
  }

  const raw = current.components;
  const named = new Set<PsiBeaconComponentKey>(current.componentsUnavailable ?? []);
  const components = {} as Record<PsiBeaconComponentKey, number | null>;
  for (const key of COMPONENT_KEYS) {
    const value = named.has(key) ? null : numberValue(raw?.[key]);
    components[key] = value;
    if (value === null) named.add(key);
  }

  const avg24h = numberValue(current.avg24h);
  const degradation = current.inputDegradation;
  const reading: PsiBeaconReading = {
    score: current.score,
    band: current.band,
    avg24h: avg24h !== null && avg24h >= 0 && avg24h <= 100 ? avg24h : null,
    avg24hBand: current.avg24hBand && isConditionBand(current.avg24hBand) ? current.avg24hBand : null,
    components,
    unavailableComponents: COMPONENT_KEYS.filter((key) => named.has(key)),
    severityLowerBound: degradation?.openDepegNoPrice
      ? { unpricedCount: numberValue(degradation.openDepegsWithoutPrice ?? null) }
      : null,
    computedAt: current.computedAt,
    methodologyVersion: current.methodologyVersion ?? null,
  };

  if (input.isFresh) return { kind: "current", reading };
  return {
    kind: "retained",
    reading,
    reason: input.healthMessage ?? "Data is not fresh.",
    asOfLabel: input.asOfLabel ?? null,
  };
}

// ---------------------------------------------------------------------------
// Ruler model
// ---------------------------------------------------------------------------

export interface PsiBeaconSpan {
  /** Exact extent on the 0–100 ruler. */
  from: number;
  to: number;
  /** Drawn extent: equal to the exact one except for the sliver floor. */
  drawFrom: number;
  drawTo: number;
}

export interface PsiBeaconFogBank extends PsiBeaconSpan {
  key: PsiBeaconPenaltyKey;
  value: number;
  /** Nonzero but drawn at the sliver floor; label as "<0.3", never as the floor value. */
  belowFloor: boolean;
  /** Severity bank only: open depegs without a price were skipped, so the true bank may be longer. */
  lowerBound: { unpricedCount: number | null } | null;
}

export interface PsiBeaconRing {
  value: number;
}

export interface PsiBeaconBandZone {
  band: PsiConditionBand;
  from: number;
  to: number;
}

export type PsiBeaconPaint =
  | { mode: "lit"; hex: string }
  | { mode: "outline"; hex: string }
  | { mode: "dark" };

export interface PsiBeaconModel {
  state: PsiBeaconState["kind"];
  paint: PsiBeaconPaint;
  /** Lit beam from 0. Null when there is no reading (never a 0-length beam: that is a real 0). */
  beam: { to: number; dashedTip: boolean } | null;
  /** Positive trend: light won back at the tip, overlapping the innermost fog. */
  gain: (PsiBeaconSpan & { value: number }) | null;
  /** Negative trend: a drag segment between the fog banks and the lit tip. */
  drag: (PsiBeaconSpan & { value: number }) | null;
  fog: PsiBeaconFogBank[];
  /** Missing components (or a sum that does not reconcile) leave this gap unattributed. */
  unknown: (PsiBeaconSpan & {
    keys: PsiBeaconComponentKey[];
    unreconciled: boolean;
    /** An unknown trend won light back: the gap lies under the lit beam, not beyond it. */
    overlapsBeam: boolean;
  }) | null;
  /** The formula clamp, shown rather than hidden. */
  clamp: { at: 0 | 100; rawScore: number } | null;
  avgTick: { value: number; band: PsiConditionBand | null } | null;
  rings: PsiBeaconRing[];
  zones: PsiBeaconBandZone[];
  /** Score and band as text (plate), retained or current. */
  plate: { score: number; band: PsiConditionBand } | null;
  ariaLabel: string;
}

const RING_VALUES: readonly number[] = [...PSI_CONDITION_BANDS.map((entry) => entry.min).filter((min) => min > 0), 100]
  .sort((a, b) => a - b);

const BAND_ZONES: readonly PsiBeaconBandZone[] = PSI_CONDITION_BANDS.map((entry, index) => ({
  band: entry.band,
  from: entry.min,
  to: index === 0 ? 100 : PSI_CONDITION_BANDS[index - 1].min,
})).sort((a, b) => a.from - b.from);

function clampRuler(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function span(from: number, to: number): PsiBeaconSpan {
  const a = clampRuler(from);
  const b = clampRuler(to);
  return { from: a, to: b, drawFrom: a, drawTo: b };
}

function fmt(value: number): string {
  return value.toFixed(1);
}

function signed(value: number): string {
  if (value > 0) return `+${fmt(value)}`;
  if (value < 0) return `−${fmt(Math.abs(value))}`;
  return fmt(value);
}

/** Decomposes the instant sample into lit length, fog banks, trend and unknown spans. */
function decompose(reading: PsiBeaconReading): Pick<PsiBeaconModel, "gain" | "drag" | "fog" | "unknown" | "clamp"> & { dashedTip: boolean } {
  const { score, components } = reading;
  const missing = reading.unavailableComponents;
  const trend = components.trend;

  // Fog banks stack from 100 inward: severity nearest 100, then breadth, then stress breadth.
  const fog: PsiBeaconFogBank[] = [];
  let edge = 100;
  for (const key of PENALTY_ORDER) {
    const value = components[key];
    if (value === null) continue;
    const exact = span(edge - Math.max(0, value), edge);
    edge -= Math.max(0, value);
    if (value <= 0) continue;
    const belowFloor = value < PSI_BEACON_SLIVER_FLOOR;
    fog.push({
      ...exact,
      // The sliver grows inward from its outer edge so the bank stays anchored where it belongs.
      drawFrom: belowFloor ? clampRuler(exact.to - PSI_BEACON_SLIVER_FLOOR) : exact.drawFrom,
      key,
      value,
      belowFloor,
      lowerBound: key === "severity" ? reading.severityLowerBound : null,
    });
  }

  let drag: PsiBeaconModel["drag"] = null;
  let gain: PsiBeaconModel["gain"] = null;
  let clamp: PsiBeaconModel["clamp"] = null;
  if (trend !== null && trend < 0) {
    drag = { ...span(edge + trend, edge), value: trend };
    edge += trend;
  }
  // `edge` is now 100 − known penalties + known negative trend: the unclamped raw score
  // when nothing is missing and trend is not positive.
  const rawScore = edge + (trend !== null && trend > 0 ? trend : 0);
  if (trend !== null && trend > 0) {
    gain = { ...span(edge, edge + trend), value: trend };
  }

  if (missing.length === 0) {
    const cents = (value: number) => Math.round(value * 100);
    const reconciled = Math.abs(cents(clampRuler(rawScore)) - cents(score)) <= RECONCILE_TOLERANCE_CENTS;
    if (reconciled) {
      if (cents(rawScore) > 10000 + RECONCILE_TOLERANCE_CENTS) clamp = { at: 100, rawScore };
      else if (cents(rawScore) < -RECONCILE_TOLERANCE_CENTS) clamp = { at: 0, rawScore };
      return { fog, drag, gain, unknown: null, clamp, dashedTip: false };
    }
    // Components that do not sum to the published score are not drawn as an explanation.
    return {
      fog: [],
      drag: null,
      gain: null,
      unknown: { ...span(score, 100), keys: [], unreconciled: true, overlapsBeam: false },
      clamp: null,
      dashedTip: true,
    };
  }

  // Missing components: the gap between the lit tip and the known banks is unattributed.
  // A known gain stays anchored at the tip; the unknown penalties sit under it like fog does.
  const gainValue = trend !== null && trend > 0 ? trend : 0;
  const tipGain = gainValue > 0 ? { ...span(score - gainValue, score), value: gainValue } : null;
  const gapFrom = score - gainValue;
  // edge < gapFrom only when an unknown trend won light back: that gap overlaps the beam.
  const unknown = edge >= gapFrom
    ? { ...span(gapFrom, edge), keys: [...missing], unreconciled: false, overlapsBeam: false }
    : { ...span(edge, gapFrom), keys: [...missing], unreconciled: false, overlapsBeam: true };
  return { fog, drag, gain: tipGain, unknown, clamp: null, dashedTip: true };
}

function heroAriaLabel(reading: PsiBeaconReading, model: Pick<PsiBeaconModel, "unknown" | "clamp">): string {
  const parts: string[] = [`instant ${fmt(reading.score)} ${reading.band}`];
  if (model.unknown?.unreconciled) {
    parts.push("components do not reconcile with the published score");
  } else {
    const lost = PENALTY_ORDER
      .map((key) => {
        const value = reading.components[key];
        if (value === null) return `${PSI_BEACON_COMPONENT_LABELS[key]} unavailable`;
        const bound = key === "severity" && reading.severityLowerBound ? " (lower bound)" : "";
        return `${PSI_BEACON_COMPONENT_LABELS[key]} ${fmt(value)}${bound}`;
      })
      .join(", ");
    parts.push(`light lost to ${lost}`);
    const trend = reading.components.trend;
    parts.push(trend === null ? "trend unavailable" : `trend ${signed(trend)}`);
    if (model.clamp) parts.push(`clamped at ${model.clamp.at}`);
  }
  if (reading.avg24h !== null) parts.push(`24h average ${fmt(reading.avg24h)}`);
  return `Pharos Stability Index lighthouse: ${parts.join("; ")}.`;
}

/**
 * Builds the ruler: the instant sample with its decomposition and a 24h-average tick
 * (the instant sample is the only basis with published components).
 */
export function buildPsiBeaconModel(state: PsiBeaconState): PsiBeaconModel {
  const rings = RING_VALUES.map((value) => ({ value }));
  const zones = [...BAND_ZONES];
  const empty = {
    state: state.kind,
    paint: { mode: "dark" } as const,
    beam: null,
    gain: null,
    drag: null,
    fog: [],
    unknown: null,
    clamp: null,
    avgTick: null,
    rings,
    zones,
    plate: null,
  };

  if (state.kind === "loading") {
    return { ...empty, ariaLabel: "Pharos Stability Index lighthouse: loading." };
  }
  if (state.kind === "unavailable") {
    return { ...empty, ariaLabel: `Pharos Stability Index lighthouse: PSI unavailable. ${state.reason}` };
  }

  const { reading } = state;
  const retained = state.kind === "retained";
  const prefix = retained
    ? `Retained observation${state.asOfLabel ? ` as of ${state.asOfLabel}` : ""}, not current. `
    : "";

  const parts = decompose(reading);
  const paint: PsiBeaconPaint = retained
    ? { mode: "outline", hex: PSI_UNKNOWN_BAND_HEX }
    : { mode: "lit", hex: PSI_HEX_COLORS[reading.band] };
  return {
    ...empty,
    paint,
    beam: { to: reading.score, dashedTip: parts.dashedTip },
    gain: parts.gain,
    drag: parts.drag,
    fog: parts.fog,
    unknown: parts.unknown,
    clamp: parts.clamp,
    avgTick: reading.avg24h !== null ? { value: reading.avg24h, band: reading.avg24hBand } : null,
    plate: { score: reading.score, band: reading.band },
    ariaLabel: `${prefix}${heroAriaLabel(reading, parts)}`,
  };
}

/**
 * Conservation check: lit + fog + drag ± unknown − gain = 100 (the clamp is absorbed by the gain).
 * Exported for tests and for the OG hook point; returns the residual in score points.
 */
export function psiBeaconConservationResidual(model: PsiBeaconModel): number | null {
  if (!model.beam) return null;
  const fog = model.fog.reduce((sum, bank) => sum + (bank.to - bank.from), 0);
  const drag = model.drag ? model.drag.to - model.drag.from : 0;
  const gain = model.gain ? model.gain.to - model.gain.from : 0;
  const unknownLength = model.unknown ? model.unknown.to - model.unknown.from : 0;
  const unknown = model.unknown?.overlapsBeam ? -unknownLength : unknownLength;
  return model.beam.to + fog + drag + unknown - gain - 100;
}
