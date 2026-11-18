import type { DepegDirection } from "../types/peg";
import type { AdmittedDeviationBps, ReferenceAdmission } from "../types/reference-admission";

interface PublishedDeviationEvidence {
  referenceAdmission?: ReferenceAdmission | null;
  admittedDeviationBps?: AdmittedDeviationBps;
  currentPriceUnavailable?: boolean;
  pegReferenceUnavailable?: boolean;
}

export function hasPublishedDeviation(row: PublishedDeviationEvidence | null | undefined): boolean {
  return row?.referenceAdmission !== undefined || row?.admittedDeviationBps !== undefined;
}

/** Only omission selects the caller's legacy comparison. A withheld or unpaired projection returns null. */
export function readDeviationProjection(
  row: PublishedDeviationEvidence | null | undefined,
  fixedUsd: boolean,
  quoteObservedAtSec: number | null | undefined,
): AdmittedDeviationBps | undefined {
  if (!hasPublishedDeviation(row)) return undefined;
  const verdict = row?.referenceAdmission;
  const bps = row?.admittedDeviationBps;
  const paired = verdict === undefined ? fixedUsd : verdict?.status === "admitted" &&
    quoteObservedAtSec != null && quoteObservedAtSec === verdict.quoteObservedAtSec;
  return paired && !row?.currentPriceUnavailable && !row?.pegReferenceUnavailable &&
    typeof bps === "number" && Number.isFinite(bps) ? bps : null;
}

export type { DepegDirection } from "../types/peg";

export interface RelativeBpsResult {
  bps: number;
  absBps: number;
  rawBps: number;
  absRawBps: number;
}

export interface DepegSignal extends RelativeBpsResult {
  direction: DepegDirection;
}

export type DirectionalSignalStatus = "confirm" | "recover" | "contradict" | "insufficient";

function toDirection(bps: number): DepegDirection {
  return bps >= 0 ? "above" : "below";
}

export function relativeBps(value: number, reference: number): RelativeBpsResult | null {
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(reference) || reference <= 0) {
    return null;
  }

  const rawBps = ((value / reference) - 1) * 10000;
  if (!Number.isFinite(rawBps)) return null;
  const bps = Math.round(rawBps);
  return {
    bps,
    absBps: Math.abs(bps),
    rawBps,
    absRawBps: Math.abs(rawBps),
  };
}

export function deriveDepegSignal(price: number, pegRef: number): DepegSignal | null {
  const relative = relativeBps(price, pegRef);
  return relative == null
    ? null
    : { ...relative, direction: toDirection(relative.rawBps) };
}

export function coerceDepegDirection(
  direction: string | null | undefined,
  fallbackBps?: number | null,
): DepegDirection {
  if (direction === "above" || direction === "below") {
    return direction;
  }
  return (fallbackBps ?? 0) >= 0 ? "above" : "below";
}

export function signalsShareDirection(
  left: Pick<DepegSignal, "direction"> | DepegDirection,
  right: Pick<DepegSignal, "direction"> | DepegDirection,
): boolean {
  const leftDirection = typeof left === "string" ? left : left.direction;
  const rightDirection = typeof right === "string" ? right : right.direction;
  return leftDirection === rightDirection;
}

export function signalCrossesThreshold(
  signal: Pick<DepegSignal, "absBps" | "absRawBps"> | null | undefined,
  thresholdBps: number,
): boolean {
  return signal != null && (signal.absRawBps ?? signal.absBps) >= thresholdBps;
}

export function signalIsWithinThreshold(
  signal: Pick<DepegSignal, "absBps" | "absRawBps"> | null | undefined,
  thresholdBps: number,
): boolean {
  return signal != null && (signal.absRawBps ?? signal.absBps) <= thresholdBps;
}

export function classifyDirectionalSignal(
  signal: DepegSignal | null | undefined,
  thresholdBps: number,
  expectedDirection: DepegDirection,
  recoveryThresholdBps?: number,
): DirectionalSignalStatus {
  if (signal == null) return "insufficient";
  const magnitude = signal.absRawBps ?? signal.absBps;
  if (recoveryThresholdBps == null ? magnitude < thresholdBps : magnitude <= recoveryThresholdBps) return "recover";
  if (magnitude < thresholdBps) return "insufficient";
  return signal.direction === expectedDirection ? "confirm" : "contradict";
}

export function pickMoreSevereBps(...bpsValues: Array<number | null | undefined>): number | null {
  let winner: number | null = null;
  for (const value of bpsValues) {
    if (value == null || !Number.isFinite(value)) continue;
    if (winner == null || Math.abs(value) > Math.abs(winner)) {
      winner = value;
    }
  }
  return winner;
}
