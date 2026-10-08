import { describe, expect, it } from "vitest";
import type { DepegSignal } from "@shared/lib/depeg-signals";
import { makeAsset, makeDepegRow } from "../../../test-helpers/__shared/fixtures";
import {
  applyNativeQuoteVeto,
  recoveryPriceForEvent,
  resolveDirectRecovery,
  resolvePeakUpdateCommand,
} from "../native-quote-policy";
import type { DepegDetectionRow } from "../types";

function signal(rawBps: number): DepegSignal {
  const bps = Math.round(rawBps);
  return { bps, absBps: Math.abs(bps), rawBps, absRawBps: Math.abs(rawBps), direction: rawBps >= 0 ? "above" : "below" };
}
function event(native = true): DepegDetectionRow {
  return {
    ...makeDepegRow({ id: 7, stablecoin_id: "brz-transfero", symbol: "BRZ", peg_type: native ? "peggedBRL" : "peggedUSD",
      source: "live", peg_reference: 1, direction: "below", peak_deviation_bps: -200 }),
    confirmation_sources: null, pending_reason: null,
  };
}
const context = {
  trackedCoinId: "brz-transfero", now: 1_780_358_400,
  asset: makeAsset({ id: "brz-transfero", symbol: "BRZ", pegType: "peggedBRL" }),
  bps: -200, absBps: 200, rawAbsBps: 200, direction: "below" as const,
  threshold: 100, recoveryThreshold: 50, nativeSignal: signal(-200),
  nativePegPrice: 0.98, nativePegCurrency: "BRL",
};

describe("native quote mutation policy", () => {
  it("uses native prices for native peaks and rejects missing, opposite-direction and non-increasing evidence", () => {
    const input = { existing: event(), nativeSignal: signal(-250), nativePegPrice: 0.975,
      primarySignal: signal(-900), primaryPrice: 0.18, primaryTrust: "authoritative" as const, dexSupportsDirection: false };
    expect(resolvePeakUpdateCommand(input)).toEqual({ type: "update-peak", id: 7, peakDeviationBps: -250, peakPrice: 0.975 });
    for (const nativeSignal of [null, signal(250), signal(-200), signal(-199)]) {
      expect(resolvePeakUpdateCommand({ ...input, nativeSignal })).toBeNull();
    }
    expect(resolvePeakUpdateCommand({ ...input, nativePegPrice: null })).toBeNull();
    const primary = { ...input, existing: event(false), primaryTrust: "confirm_required" as const };
    expect(resolvePeakUpdateCommand(primary)).toBeNull();
    expect(resolvePeakUpdateCommand({ ...primary, dexSupportsDirection: true }))
      .toEqual({ type: "update-peak", id: 7, peakDeviationBps: -900, peakPrice: 0.18 });
  });

  it("requires an available native quote at the inclusive raw recovery boundary", () => {
    const input = { existing: event(), nativeSignal: signal(-50), nativePegPrice: 0.995,
      primaryPrice: 1, recoveryThreshold: 50, primarySupportsRecovery: true, primaryRecoveryContradicted: false };
    expect(resolveDirectRecovery(input)).toEqual({ recoveryPrice: 0.995, closeReason: "recovered-native" });
    expect(resolveDirectRecovery({ ...input, nativeSignal: signal(-50.01) })).toBeNull();
    expect(resolveDirectRecovery({ ...input, nativeSignal: null })).toBeNull();
    expect(resolveDirectRecovery({ ...input, nativePegPrice: null })).toBeNull();
    const primary = { ...input, existing: event(false) };
    expect(resolveDirectRecovery(primary)).toEqual({ recoveryPrice: 1, closeReason: "recovered-primary" });
    expect(resolveDirectRecovery({ ...primary, primarySupportsRecovery: false })).toBeNull();
    expect(resolveDirectRecovery({ ...primary, primaryRecoveryContradicted: true })).toBeNull();
    expect(recoveryPriceForEvent(event(), 0.18)).toBeNull();
    expect(recoveryPriceForEvent(event(false), 1)).toBe(1);
  });

  it("vetoes a false opening but passes an existing event to native recovery handling", () => {
    const recovered = { ...context, nativeSignal: signal(-50), nativePegPrice: 0.995 };
    expect(applyNativeQuoteVeto(recovered, undefined)).toMatchObject({
      trackedCoinId: "brz-transfero", seenEventIds: [], commands: [], diagnostics: [{ level: "warn" }],
    });
    expect(applyNativeQuoteVeto(recovered, event())).toBeNull();
    expect(applyNativeQuoteVeto({ ...context, nativeSignal: null }, undefined)).toBeNull();
    expect(applyNativeQuoteVeto(context, undefined)).toBeNull();
  });

  it("retains existing events and clears recovery when native evidence contradicts primary recovery or direction", () => {
    const recovering = { ...event(), recovery_first_seen_at: 1_780_358_000, recovery_last_seen_at: 1_780_358_100 };
    const contradictory = applyNativeQuoteVeto({ ...context, nativeSignal: signal(150) }, recovering);
    expect(contradictory).toMatchObject({ seenEventIds: [7], commands: [{ type: "clear-recovery", id: 7 }] });
    const atOpeningBoundary = applyNativeQuoteVeto({ ...context, bps: 0, absBps: 0, rawAbsBps: 0, nativeSignal: signal(-100) }, recovering);
    expect(atOpeningBoundary).toMatchObject({ seenEventIds: [7], commands: [{ type: "clear-recovery", id: 7 }] });
    expect(applyNativeQuoteVeto({ ...context, bps: 0, rawAbsBps: 0, nativeSignal: signal(-99.99) }, recovering)).toBeNull();
    expect(applyNativeQuoteVeto({ ...context, nativeSignal: signal(150) }, event())?.commands).toEqual([]);
  });
});
