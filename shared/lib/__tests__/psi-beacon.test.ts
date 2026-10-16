
import { describe, expect, it } from "vitest";
import { PSI_HEX_COLORS, PSI_UNKNOWN_BAND_HEX } from "../classification";
import {
  PSI_BEACON_SLIVER_FLOOR,
  buildPsiBeaconModel,
  derivePsiBeaconState,
  psiBeaconConservationResidual,
  type PsiBeaconCurrentLike,
  type PsiBeaconState,
} from "../psi-beacon";

/** Live `GET /api/stability-index` current, 2026-10-12. */
const LIVE: PsiBeaconCurrentLike = {
  score: 91.9,
  band: "BEDROCK",
  avg24h: 92.1,
  avg24hBand: "BEDROCK",
  computedAt: 1791782781,
  methodologyVersion: "3.67",
  components: { severity: 0.02, breadth: 6.65, stressBreadth: 1.33, trend: -0.14 },
  inputDegradation: { openDepegNoPrice: false, openDepegsWithoutPrice: null },
};

function fresh(current: PsiBeaconCurrentLike | null): PsiBeaconState {
  return derivePsiBeaconState({ current, isFresh: true });
}

function hero(current: PsiBeaconCurrentLike) {
  return buildPsiBeaconModel(fresh(current));
}

function withComponents(
  score: number,
  band: string,
  components: NonNullable<PsiBeaconCurrentLike["components"]>,
  extra: Partial<PsiBeaconCurrentLike> = {},
): PsiBeaconCurrentLike {
  return { score, band, computedAt: 1, components, ...extra };
}

describe("derivePsiBeaconState", () => {
  it("is loading only while pending without a reading", () => {
    expect(derivePsiBeaconState({ current: null, isLoading: true, isFresh: false })).toEqual({ kind: "loading" });
    expect(derivePsiBeaconState({ current: undefined, isFresh: true, healthMessage: "Data is not yet available." }))
      .toEqual({ kind: "unavailable", reason: "Data is not yet available." });
  });

  it("treats a non-finite or out-of-range score as unavailable, never as zero (R1)", () => {
    for (const score of [Number.NaN, Number.POSITIVE_INFINITY, -1, 100.5]) {
      expect(fresh({ ...LIVE, score }).kind).toBe("unavailable");
    }
  });

  it("treats a band outside the closed vocabulary as unavailable", () => {
    const state = fresh({ ...LIVE, band: "CALM" });
    expect(state).toMatchObject({ kind: "unavailable" });
  });

  it("keeps a fresh reading current and a non-fresh one retained with its as-of (R3)", () => {
    expect(fresh(LIVE).kind).toBe("current");
    const retained = derivePsiBeaconState({
      current: LIVE,
      isFresh: false,
      healthMessage: "Data is stale.",
      asOfLabel: "Oct 12, 2:32 PM",
    });
    expect(retained).toMatchObject({ kind: "retained", reason: "Data is stale.", asOfLabel: "Oct 12, 2:32 PM" });
  });

  it("marks null and API-named components unavailable instead of zero", () => {
    const state = fresh({
      ...LIVE,
      components: { severity: 0.02, breadth: null, stressBreadth: 1.33, trend: -0.14 },
      componentsUnavailable: ["stressBreadth"],
    });
    if (state.kind !== "current") throw new Error("expected current");
    expect(state.reading.components.breadth).toBeNull();
    expect(state.reading.components.stressBreadth).toBeNull();
    expect(state.reading.unavailableComponents).toEqual(["breadth", "stressBreadth"]);
  });

  it("treats an absent legacy stressBreadth as unavailable", () => {
    const state = fresh({ ...LIVE, components: { severity: 1, breadth: 2, trend: 0 } });
    if (state.kind !== "current") throw new Error("expected current");
    expect(state.reading.unavailableComponents).toEqual(["stressBreadth"]);
  });

  it("drops an out-of-range 24h average rather than drawing it", () => {
    const state = fresh({ ...LIVE, avg24h: Number.NaN });
    if (state.kind !== "current") throw new Error("expected current");
    expect(state.reading.avg24h).toBeNull();
  });
});

describe("buildPsiBeaconModel (hero)", () => {
  it("draws the live 2026-10-12 sample exactly", () => {
    const model = hero(LIVE);
    expect(model.state).toBe("current");
    expect(model.paint).toEqual({ mode: "lit", hex: PSI_HEX_COLORS.BEDROCK });
    expect(model.beam).toEqual({ to: 91.9, dashedTip: false });
    expect(model.fog.map((bank) => [bank.key, bank.value])).toEqual([
      ["severity", 0.02],
      ["breadth", 6.65],
      ["stressBreadth", 1.33],
    ]);
    expect(model.drag?.value).toBe(-0.14);
    expect(model.drag!.to - model.drag!.from).toBeCloseTo(0.14, 10);
    expect(model.gain).toBeNull();
    expect(model.unknown).toBeNull();
    expect(model.clamp).toBeNull();
    expect(model.avgTick).toEqual({ value: 92.1, band: "BEDROCK" });
    expect(Math.abs(psiBeaconConservationResidual(model)!)).toBeLessThanOrEqual(0.05);
  });

  it("stacks fog from 100 inward: severity, breadth, stress breadth, then the drag", () => {
    const model = hero(LIVE);
    const [severity, breadth, stress] = model.fog;
    expect(severity.to).toBe(100);
    expect(breadth.to).toBeCloseTo(severity.from, 10);
    expect(stress.to).toBeCloseTo(breadth.from, 10);
    expect(model.drag!.to).toBeCloseTo(stress.from, 10);
  });

  it("floors a tiny bank to a flagged sliver without changing its exact extent (R7)", () => {
    const [severity] = hero(LIVE).fog;
    expect(severity.belowFloor).toBe(true);
    expect(severity.to - severity.from).toBeCloseTo(0.02, 10);
    expect(severity.drawTo - severity.drawFrom).toBeCloseTo(PSI_BEACON_SLIVER_FLOOR, 10);
    expect(hero(LIVE).fog[1].belowFloor).toBe(false);
  });

  it("omits zero banks but keeps them in the aria string", () => {
    const model = hero(withComponents(97, "BEDROCK", { severity: 0, breadth: 3, stressBreadth: 0, trend: 0 }));
    expect(model.fog.map((bank) => bank.key)).toEqual(["breadth"]);
    expect(model.ariaLabel).toContain("severity 0.0, breadth 3.0, stress breadth 0.0");
  });

  it("draws a positive trend as a gain at the tip overlapping the innermost fog", () => {
    const model = hero(withComponents(93.5, "BEDROCK", { severity: 1, breadth: 6, stressBreadth: 2, trend: 2.5 }));
    expect(model.gain).toMatchObject({ from: 91, to: 93.5, value: 2.5 });
    expect(model.drag).toBeNull();
    expect(model.beam!.to).toBe(93.5);
    expect(psiBeaconConservationResidual(model)).toBeCloseTo(0, 10);
  });

  it("shows the formula clamp at 100 rather than hiding it", () => {
    const model = hero(withComponents(100, "BEDROCK", { severity: 0, breadth: 1, stressBreadth: 0, trend: 3 }));
    expect(model.clamp).toEqual({ at: 100, rawScore: 102 });
    expect(model.gain).toMatchObject({ from: 99, to: 100 });
    expect(psiBeaconConservationResidual(model)).toBeCloseTo(0, 10);
    expect(model.ariaLabel).toContain("clamped at 100");
  });

  it("draws a real score of 0 as a zero-length lit beam, distinct from unavailable", () => {
    const model = hero(withComponents(0, "MELTDOWN", { severity: 68, breadth: 17, stressBreadth: 5, trend: -5 }));
    expect(model.beam).toEqual({ to: 0, dashedTip: true });
    expect(model.paint).toEqual({ mode: "lit", hex: PSI_HEX_COLORS.MELTDOWN });
    expect(model.clamp).toBeNull();
    // Capped penalties cannot reach 0 (100 − 68 − 17 − 5 − 5 = 5), so this sample is unreconciled.
    expect(model.unknown?.unreconciled).toBe(true);
  });

  it("leaves the gap unattributed with a dashed tip when one component is null (R1)", () => {
    const model = hero({ ...LIVE, components: { severity: 0.02, breadth: null, stressBreadth: 1.33, trend: -0.14 } });
    expect(model.fog.map((bank) => bank.key)).toEqual(["severity", "stressBreadth"]);
    expect(model.unknown).toMatchObject({ keys: ["breadth"], unreconciled: false, overlapsBeam: false });
    expect(model.unknown!.to - model.unknown!.from).toBeCloseTo(6.65, 1);
    expect(model.beam!.dashedTip).toBe(true);
    expect(model.ariaLabel).toContain("breadth unavailable");
    expect(Math.abs(psiBeaconConservationResidual(model)!)).toBeLessThanOrEqual(0.05);
  });

  it("keeps a known gain at the tip when a penalty is unknown", () => {
    const model = hero(withComponents(93.5, "BEDROCK", { severity: 1, breadth: null, stressBreadth: 2, trend: 2.5 }));
    expect(model.gain).toMatchObject({ from: 91, to: 93.5 });
    expect(model.unknown).toMatchObject({ from: 91, to: 97, overlapsBeam: false });
    expect(psiBeaconConservationResidual(model)).toBeCloseTo(0, 10);
  });

  it("places an unknown positive trend under the beam", () => {
    const model = hero(withComponents(95, "BEDROCK", { severity: 1, breadth: 6, stressBreadth: 1, trend: null }));
    expect(model.unknown).toMatchObject({ from: 92, to: 95, keys: ["trend"], overlapsBeam: true });
    expect(model.ariaLabel).toContain("trend unavailable");
    expect(psiBeaconConservationResidual(model)).toBeCloseTo(0, 10);
  });

  it("does not explain a score whose components do not reconcile", () => {
    const model = hero(withComponents(80, "STEADY", { severity: 1, breadth: 1, stressBreadth: 1, trend: 0 }));
    expect(model.fog).toEqual([]);
    expect(model.unknown).toMatchObject({ from: 80, to: 100, unreconciled: true });
    expect(model.ariaLabel).toContain("do not reconcile");
  });

  it("marks severity as a lower bound when open depegs were unpriced", () => {
    const model = hero({ ...LIVE, inputDegradation: { openDepegNoPrice: true, openDepegsWithoutPrice: 2 } });
    expect(model.fog[0].lowerBound).toEqual({ unpricedCount: 2 });
    expect(model.fog[1].lowerBound).toBeNull();
    expect(model.ariaLabel).toContain("severity 0.0 (lower bound)");
  });

});

describe("buildPsiBeaconModel states", () => {
  it("draws retained data as a neutral outline with the as-of, keeping score and band as text (R3)", () => {
    const state = derivePsiBeaconState({ current: LIVE, isFresh: false, healthMessage: "Data is stale.", asOfLabel: "Oct 12, 2:32 PM" });
    const model = buildPsiBeaconModel(state);
    expect(model.paint).toEqual({ mode: "outline", hex: PSI_UNKNOWN_BAND_HEX });
    expect(model.plate).toEqual({ score: 91.9, band: "BEDROCK" });
    expect(model.beam).not.toBeNull();
    expect(model.ariaLabel.startsWith("Retained observation as of Oct 12, 2:32 PM, not current.")).toBe(true);
  });

  it("draws no beam, no avg tick and no hue when unavailable", () => {
    const model = buildPsiBeaconModel(fresh({ ...LIVE, score: Number.NaN }));
    expect(model.beam).toBeNull();
    expect(model.avgTick).toBeNull();
    expect(model.fog).toEqual([]);
    expect(model.paint).toEqual({ mode: "dark" });
    expect(model.ariaLabel).toContain("PSI unavailable");
    expect(model.rings).toHaveLength(6);
  });

});
