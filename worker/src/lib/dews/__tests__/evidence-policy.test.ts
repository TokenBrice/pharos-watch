import { describe, expect, it } from "vitest";
import { EVIDENCE_STRESS_THRESHOLD, type DewsSignalKey } from "@shared/lib/dews-config";
import { classifyEvidenceKinds } from "../evidence-policy";
import { malformedInputDegradesRun } from "../malformed-input";
import { decodeLegacyStressSignals } from "../source-state/legacy-bridge";
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

describe("malformedInputDegradesRun", () => {
  it("degrades the run only for aggregate-scope malformed input", () => {
    expect(malformedInputDegradesRun(true, "aggregate")).toBe(true);
  });

  it("treats a missing stablecoin id as aggregate scope", () => {
    expect(malformedInputDegradesRun(true, "")).toBe(true);
  });

  it("quarantines an asset-scoped malformed input without degrading the run", () => {
    expect(malformedInputDegradesRun(true, "usdc-circle")).toBe(false);
  });

  it("never degrades when the caller did not classify the input as run-degrading", () => {
    expect(malformedInputDegradesRun(false, "aggregate")).toBe(false);
    expect(malformedInputDegradesRun(false, "usdc-circle")).toBe(false);
  });
});

const COMPUTED_AT = 1_700_000_000;

describe("decodeLegacyStressSignals", () => {
  it.each([false, true])("retains readable composite coverage in flat/enveloped rows (wrapped=%s)", (wrapped) => {
    const signals = {
      supply: { value: 65, available: true, componentCoverage: 0.6, delta1d: -5, delta7d: null },
      liq: { value: 0, available: false, componentCoverage: 0, scoreDelta7d: null, tvlDelta7d: null },
      pool: { value: 25, available: true, componentCoverage: 1 },
    };
    expect(decodeLegacyStressSignals(JSON.stringify(wrapped ? { signals } : signals), COMPUTED_AT))
      .toEqual({ ok: true, payload: signals });
  });

  it.each([null, "1", -0.5, 2])("keeps invalid or unknown coverage %s unknown rather than full or calm", (coverage) => {
    expect(decodeLegacyStressSignals(JSON.stringify({
      supply: { value: 10, available: true, componentCoverage: coverage },
    }), COMPUTED_AT)).toEqual({
      ok: true, payload: { supply: { value: 10, available: true, componentCoverage: null } },
    });
  });

  it("passes a pre-envelope flat signals map through unchanged", () => {
    const legacy = {
      supply: { value: 5, available: true },
      pool: { value: 12, delta1d: -0.04 },
    };

    expect(decodeLegacyStressSignals(JSON.stringify(legacy), COMPUTED_AT)).toEqual({
      ok: true,
      payload: legacy,
    });
  });

  it("unwraps the envelope signals and never treats envelope metadata as a signal", () => {
    const wrapped = {
      signals: { supply: { value: 8, available: false } },
      amplifiers: { psi: 1.2, contagion: 1.1 },
      baseScore: 30,
      finalScore: 42,
      evidenceKinds: ["market-price"],
    };

    expect(decodeLegacyStressSignals(JSON.stringify(wrapped), COMPUTED_AT)).toEqual({
      ok: true,
      payload: { supply: { value: 8, available: false } },
    });
  });

  it("reports a missing blob distinctly from a failed parse", () => {
    expect(decodeLegacyStressSignals(null, COMPUTED_AT)).toEqual({ ok: false, reason: "missing" });
    expect(decodeLegacyStressSignals("", COMPUTED_AT)).toEqual({ ok: false, reason: "json-parse-failed" });
    expect(decodeLegacyStressSignals("{not-json", COMPUTED_AT)).toEqual({ ok: false, reason: "json-parse-failed" });
  });

  it.each(["[]", "\"signals\"", "3", "null"])("rejects the non-record root %s as an invalid shape", (payload) => {
    expect(decodeLegacyStressSignals(payload, COMPUTED_AT)).toEqual({ ok: false, reason: "invalid-shape" });
  });

  it("drops malformed signal entries while keeping readable siblings", () => {
    const payload = {
      supply: { value: 5, available: true },
      pool: "unavailable",
      liq: { value: "9" },
      flow: { value: 3, burnSurge: 1.4, warnings: ["partial-coverage"] },
    };

    expect(decodeLegacyStressSignals(JSON.stringify(payload), COMPUTED_AT)).toEqual({
      ok: true,
      payload: {
        supply: { value: 5, available: true },
        flow: { value: 3, burnSurge: 1.4, warnings: ["partial-coverage"] },
      },
    });
  });

  it("drops a non-finite value read from JSON instead of hydrating it", () => {
    expect(decodeLegacyStressSignals('{"supply":{"value":1e400},"pool":{"value":4}}', COMPUTED_AT)).toEqual({
      ok: true,
      payload: { pool: { value: 4 } },
    });
  });

  it("falls back to the flat interpretation when the envelope signals member is not an object", () => {
    expect(decodeLegacyStressSignals(JSON.stringify({ signals: 3 }), COMPUTED_AT)).toEqual({ ok: true, payload: {} });
  });
});
