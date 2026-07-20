import { normalizePegType } from "@shared/lib/peg-rates";
import type { PegAssetBase } from "@shared/types/core";
import type { DepegRow } from "../../lib/depeg-helpers";
import {
  signalCrossesThreshold,
  signalIsWithinThreshold,
  signalsShareDirection,
  type DepegDirection,
  type DepegSignal,
} from "../../lib/depeg-signals";
import type { DepegAssetDecision, DepegPersistenceCommand } from "./types";

interface NativeQuotePolicyContext {
  trackedCoinId: string;
  now: number;
  asset: PegAssetBase;
  bps: number;
  absBps: number;
  rawAbsBps: number;
  direction: DepegDirection;
  threshold: number;
  recoveryThreshold: number;
  nativeSignal: DepegSignal | null;
  nativePegPrice: number | null;
  nativePegCurrency: string | undefined;
}

export function isNativePegEvent(event: DepegRow): boolean {
  return event.source === "live" &&
    event.peg_reference === 1 &&
    normalizePegType(event.peg_type) !== "peggedUSD";
}

export function recoveryPriceForEvent(event: DepegRow, price: number): number | null {
  return isNativePegEvent(event) ? null : price;
}

export function resolvePeakUpdateCommand(params: {
  existing: DepegRow;
  nativeSignal: DepegSignal | null;
  nativePegPrice: number | null;
  primarySignal: DepegSignal;
  primaryPrice: number;
  primaryTrust: "authoritative" | "confirm_required";
  dexSupportsDirection: boolean;
  dexSupportsSecondaryBarDirection: boolean;
}): Extract<DepegPersistenceCommand, { type: "update-peak" }> | null {
  const nativeEvent = isNativePegEvent(params.existing);
  const signal = nativeEvent ? params.nativeSignal : params.primarySignal;
  const price = nativeEvent ? params.nativePegPrice : params.primaryPrice;
  const canUpdate = nativeEvent
    ? signal != null && signal.direction === params.existing.direction && price != null
    : params.primaryTrust === "authoritative" ||
      params.dexSupportsDirection ||
      (params.primaryTrust === "confirm_required" && params.dexSupportsSecondaryBarDirection);
  if (!canUpdate || !signal || signal.absBps <= Math.abs(params.existing.peak_deviation_bps)) return null;
  return {
    type: "update-peak",
    id: params.existing.id,
    peakDeviationBps: signal.bps,
    peakPrice: price,
  };
}

export function resolveDirectRecovery(params: {
  existing: DepegRow;
  nativeSignal: DepegSignal | null;
  nativePegPrice: number | null;
  primaryPrice: number;
  recoveryThreshold: number;
  primarySupportsRecovery: boolean;
  primaryRecoveryContradicted: boolean;
}): Pick<Extract<DepegPersistenceCommand, { type: "close-event" }>, "recoveryPrice" | "closeReason"> | null {
  if (signalIsWithinThreshold(params.nativeSignal, params.recoveryThreshold)) {
    return {
      recoveryPrice: isNativePegEvent(params.existing) ? params.nativePegPrice : null,
      closeReason: "recovered-native",
    };
  }
  if (!params.primarySupportsRecovery || params.primaryRecoveryContradicted) return null;
  return {
    recoveryPrice: recoveryPriceForEvent(params.existing, params.primaryPrice),
    closeReason: "recovered-primary",
  };
}

function emptyDecision(trackedCoinId: string): DepegAssetDecision {
  return { trackedCoinId, seenEventIds: [], commands: [], diagnostics: [] };
}

function suppressionMessage(ctx: NativeQuotePolicyContext): string {
  return `[depeg] Suppressed live depeg mutation for ${ctx.asset.symbol}: ` +
    `primary=${ctx.bps}bps but ${ctx.nativePegCurrency} quote=${ctx.nativeSignal?.bps ?? "n/a"}bps`;
}

export function applyNativeQuoteVeto(
  ctx: NativeQuotePolicyContext,
  existing: DepegRow | undefined,
): DepegAssetDecision | null {
  const nativeSupportsPrimaryDirection =
    ctx.nativeSignal != null &&
    signalCrossesThreshold(ctx.nativeSignal, ctx.threshold) &&
    signalsShareDirection(ctx.nativeSignal, ctx.direction);
  const nativeShowsRecovery = signalIsWithinThreshold(ctx.nativeSignal, ctx.recoveryThreshold);
  const nativeSupportsExistingDirection =
    existing != null &&
    ctx.nativeSignal != null &&
    signalCrossesThreshold(ctx.nativeSignal, ctx.threshold) &&
    signalsShareDirection(ctx.nativeSignal, existing.direction as DepegDirection);

  if (ctx.rawAbsBps >= ctx.threshold && ctx.nativeSignal != null && !nativeSupportsPrimaryDirection) {
    const decision = emptyDecision(ctx.trackedCoinId);
    if (nativeShowsRecovery && !existing) {
      decision.diagnostics.push({ level: "warn", message: suppressionMessage(ctx) });
      return decision;
    }

    if (nativeShowsRecovery) return null;

    if (existing) {
      decision.seenEventIds.push(existing.id);
      if (existing.recovery_first_seen_at != null) {
        decision.commands.push({ type: "clear-recovery", id: existing.id });
      }
    }
    decision.diagnostics.push({ level: "warn", message: suppressionMessage(ctx) });
    return decision;
  }

  if (ctx.rawAbsBps < ctx.threshold && existing && nativeSupportsExistingDirection) {
    const decision = emptyDecision(ctx.trackedCoinId);
    decision.seenEventIds.push(existing.id);
    if (existing.recovery_first_seen_at != null) {
      decision.commands.push({ type: "clear-recovery", id: existing.id });
    }
    decision.diagnostics.push({
      level: "warn",
      message: `[depeg] Kept ${ctx.asset.symbol} open despite primary recovery: ` +
        `primary=${ctx.bps}bps but ${ctx.nativePegCurrency} quote=${ctx.nativeSignal?.bps ?? "n/a"}bps`,
    });
    return decision;
  }

  return null;
}
