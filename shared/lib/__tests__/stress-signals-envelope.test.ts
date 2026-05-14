import { describe, expect, it } from "vitest";
import { unwrapStressSignalsEnvelope } from "../stress-signals-envelope";

describe("unwrapStressSignalsEnvelope", () => {
  it("returns null for null / non-record inputs", () => {
    expect(unwrapStressSignalsEnvelope(null)).toBeNull();
    expect(unwrapStressSignalsEnvelope(undefined)).toBeNull();
    expect(unwrapStressSignalsEnvelope([1, 2, 3])).toBeNull();
    expect(unwrapStressSignalsEnvelope("string")).toBeNull();
    expect(unwrapStressSignalsEnvelope(42)).toBeNull();
  });

  it("unwraps the new { signals, amplifiers } wrapped shape", () => {
    const result = unwrapStressSignalsEnvelope({
      signals: { supply: { value: 40, available: true } },
      amplifiers: { psi: 1.2, contagion: 1.15 },
    });
    expect(result).not.toBeNull();
    expect(result!.signals).toEqual({ supply: { value: 40, available: true } });
    expect(result!.amplifiers).toEqual({ psi: 1.2, contagion: 1.15 });
  });

  it("treats legacy flat shape as signals map with default amplifiers", () => {
    const result = unwrapStressSignalsEnvelope({
      supply: { value: 10, available: true },
      pool: { value: 0, available: false },
    });
    expect(result).not.toBeNull();
    expect(result!.signals).toEqual({
      supply: { value: 10, available: true },
      pool: { value: 0, available: false },
    });
    expect(result!.amplifiers).toEqual({ psi: 1, contagion: 1 });
  });

  it("falls back to default amplifiers when wrapped shape has malformed amplifiers", () => {
    const result = unwrapStressSignalsEnvelope({
      signals: { supply: { value: 5, available: true } },
      amplifiers: "bad",
    });
    expect(result!.amplifiers).toEqual({ psi: 1, contagion: 1 });
  });

  it("uses default for any missing amplifier field while preserving the present one", () => {
    const result = unwrapStressSignalsEnvelope({
      signals: { supply: { value: 5, available: true } },
      amplifiers: { psi: 1.2 },
    });
    expect(result!.amplifiers).toEqual({ psi: 1.2, contagion: 1 });
  });

  it("unwraps v6 explainability metadata while preserving legacy compatibility", () => {
    const result = unwrapStressSignalsEnvelope({
      signals: { diverg: { value: 75, available: true } },
      amplifiers: { psi: 1, contagion: 1 },
      baseScore: 44.5,
      finalScore: 45,
      availableWeight: 0.55,
      effectiveWeights: { supply: 0.45, diverg: 0.27, bad: "ignored" },
      evidenceKinds: ["market-price"],
      insufficientEvidenceReason: null,
      dataQualityScore: 0,
      sourceAges: { dexLiquidity: 120, previousSignals: null, bad: "ignored" },
      staleFlags: { dexLiquidity: false, previousSignals: true, bad: 1 },
      topContributors: [
        {
          key: "diverg",
          label: "Cross-Source Divergence",
          value: 75,
          effectiveWeight: 0.27,
          contribution: 20.25,
        },
      ],
    });

    expect(result).toEqual(
      expect.objectContaining({
        baseScore: 44.5,
        finalScore: 45,
        availableWeight: 0.55,
        evidenceKinds: ["market-price"],
        insufficientEvidenceReason: null,
        dataQualityScore: 0,
        effectiveWeights: { supply: 0.45, diverg: 0.27 },
        sourceAges: { dexLiquidity: 120, previousSignals: null },
        staleFlags: { dexLiquidity: false, previousSignals: true },
        topContributors: [expect.objectContaining({ key: "diverg", contribution: 20.25 })],
      }),
    );
  });
});
