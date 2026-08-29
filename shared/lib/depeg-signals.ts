import type { DepegDirection } from "../types/market";

export type { DepegDirection } from "../types/market";

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
): DirectionalSignalStatus {
  if (signal == null) return "insufficient";
  if ((signal.absRawBps ?? signal.absBps) < thresholdBps) return "recover";
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
