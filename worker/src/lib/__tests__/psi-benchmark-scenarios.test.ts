import { describe, expect, it } from "vitest";
import { computeStabilityIndex } from "../stability-index";

type Scenario = {
  label: string;
  input: Parameters<typeof computeStabilityIndex>[0];
  expectedBand: string;
  maxScoreExclusive?: number;
};

const SCENARIOS: Scenario[] = [
  {
    label: "Tether Scare",
    input: {
      depegs: [{ bps: -450, mcapUsd: 2.8e9 }],
      totalMcapUsd: 3.0e9,
      mcap7dChangePct: -3.5,
      dewsStressBreadth: 3,
    },
    expectedBand: "CRISIS",
    maxScoreExclusive: 25,
  },
  {
    label: "Quadriga Flight To Quality",
    input: {
      depegs: [
        { bps: 625, mcapUsd: 250e6 },
        { bps: -4000, mcapUsd: 80e6 },
      ],
      totalMcapUsd: 1.5e9,
      mcap7dChangePct: -4,
      dewsStressBreadth: 2.5,
    },
    expectedBand: "FRACTURE",
    maxScoreExclusive: 60,
  },
  {
    label: "IRON Finance",
    input: {
      depegs: [{ bps: -7500, mcapUsd: 800e6 }],
      totalMcapUsd: 12e9,
      mcap7dChangePct: -3.5,
      dewsStressBreadth: 2,
    },
    expectedBand: "CRISIS",
    maxScoreExclusive: 25,
  },
  {
    label: "Fed Crash",
    input: {
      depegs: [
        { bps: -450, mcapUsd: 4e9 },
        { bps: 350, mcapUsd: 2.2e9 },
      ],
      totalMcapUsd: 180e9,
      mcap7dChangePct: -4.2,
      dewsStressBreadth: 5,
    },
    expectedBand: "TREMOR",
    maxScoreExclusive: 65,
  },
  {
    label: "UST Collapse",
    input: {
      depegs: [{ bps: -9900, mcapUsd: 18e9 }],
      totalMcapUsd: 190e9,
      mcap7dChangePct: -5,
      dewsStressBreadth: 4.5,
    },
    expectedBand: "MELTDOWN",
    maxScoreExclusive: 20,
  },
  {
    label: "SVB Weekend",
    input: {
      depegs: [{ bps: -1200, mcapUsd: 43e9 }],
      totalMcapUsd: 135e9,
      mcap7dChangePct: -1.8,
      dewsStressBreadth: 2.2,
    },
    expectedBand: "MELTDOWN",
    maxScoreExclusive: 20,
  },
];

describe("psi benchmark scenarios", () => {
  it.each(SCENARIOS)("$label remains a sharp PSI deterioration", ({ input, expectedBand, maxScoreExclusive }) => {
    const result = computeStabilityIndex(input);

    expect(result).not.toBeNull();
    expect(result?.band).toBe(expectedBand);
    if (maxScoreExclusive != null) {
      expect(result?.score ?? Infinity).toBeLessThan(maxScoreExclusive);
    }
  });

  it("keeps broad multi-asset stress worse than an isolated wobble", () => {
    const isolated = computeStabilityIndex({
      depegs: [{ bps: -80, mcapUsd: 3e9 }],
      totalMcapUsd: 180e9,
      mcap7dChangePct: -0.5,
    });
    const broad = computeStabilityIndex({
      depegs: [
        { bps: -80, mcapUsd: 3e9 },
        { bps: -120, mcapUsd: 2e9 },
        { bps: -150, mcapUsd: 1.5e9 },
      ],
      totalMcapUsd: 180e9,
      mcap7dChangePct: -0.5,
      dewsStressBreadth: 4,
    });

    expect(isolated).not.toBeNull();
    expect(broad).not.toBeNull();
    expect((broad?.score ?? 100)).toBeLessThan(isolated?.score ?? 0);
  });
});
