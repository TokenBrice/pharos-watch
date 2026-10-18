import { describe, expect, it } from "vitest";
import { EVIDENCE_STRESS_THRESHOLD, type DewsSignalKey } from "@shared/lib/dews-config";
import { classifyEvidenceKinds } from "../evidence-policy";
import type { SignalResult } from "../types";

function observed(value: number): SignalResult {
  return { value, available: true };
}

function unavailable(value = 0): SignalResult {
  return { value, available: false };
}

function withSignals(overrides: Partial<Record<DewsSignalKey, SignalResult>>): Record<DewsSignalKey, SignalResult> {
  return {
    supply: unavailable(),
    pool: unavailable(),
    liq: unavailable(),
    price: unavailable(),
    diverg: unavailable(),
    black: unavailable(),
    flow: unavailable(),
    yield: unavailable(),
    ...overrides,
  };
}

describe("classifyEvidenceKinds", () => {
  it("ignores unavailable readings even when their values clear the threshold", () => {
    const signals = withSignals({
      diverg: unavailable(100),
      pool: unavailable(100),
      liq: unavailable(100),
      flow: unavailable(100),
      black: unavailable(100),
      yield: unavailable(100),
    });
    expect(classifyEvidenceKinds(signals, 1)).toEqual([]);
  });

  it("requires an available divergence value at or above the evidence threshold", () => {
    expect(classifyEvidenceKinds(withSignals({ diverg: observed(EVIDENCE_STRESS_THRESHOLD - 0.01) }), 1)).toEqual([]);
    expect(classifyEvidenceKinds(withSignals({ diverg: observed(EVIDENCE_STRESS_THRESHOLD) }), 1)).toEqual([
      "market-price",
    ]);
  });

  it("groups pool or liquidity stress under one dex-liquidity kind", () => {
    expect(classifyEvidenceKinds(withSignals({ pool: observed(EVIDENCE_STRESS_THRESHOLD) }), 1)).toEqual([
      "dex-liquidity",
    ]);
    expect(classifyEvidenceKinds(withSignals({ liq: observed(EVIDENCE_STRESS_THRESHOLD) }), 1)).toEqual([
      "dex-liquidity",
    ]);
    expect(
      classifyEvidenceKinds(
        withSignals({ pool: observed(100), liq: observed(100) }),
        1,
      ),
    ).toEqual(["dex-liquidity"]);
  });

  it("maps flow, issuer-control, and yield without borrowing supply or price evidence", () => {
    const signals = withSignals({
      supply: observed(100),
      price: observed(100),
      flow: observed(EVIDENCE_STRESS_THRESHOLD),
      black: observed(EVIDENCE_STRESS_THRESHOLD),
      yield: observed(EVIDENCE_STRESS_THRESHOLD),
    });
    expect(classifyEvidenceKinds(signals, 1)).toEqual(["flow", "issuer-control", "yield"]);
  });

  it("adds systemic evidence only for a PSI amplifier strictly above one", () => {
    expect(classifyEvidenceKinds(withSignals({}), 0.5)).toEqual([]);
    expect(classifyEvidenceKinds(withSignals({}), 1)).toEqual([]);
    expect(classifyEvidenceKinds(withSignals({}), 1.001)).toEqual(["systemic"]);
  });

  it("returns all kinds in canonical order", () => {
    const signals = withSignals({
      diverg: observed(EVIDENCE_STRESS_THRESHOLD),
      pool: observed(EVIDENCE_STRESS_THRESHOLD),
      flow: observed(EVIDENCE_STRESS_THRESHOLD),
      black: observed(EVIDENCE_STRESS_THRESHOLD),
      yield: observed(EVIDENCE_STRESS_THRESHOLD),
    });
    expect(classifyEvidenceKinds(signals, 1.2)).toEqual([
      "market-price",
      "dex-liquidity",
      "flow",
      "issuer-control",
      "yield",
      "systemic",
    ]);
  });
});
