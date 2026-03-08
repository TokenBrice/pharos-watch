import { describe, it, expect } from "vitest";
import { buildBriefing, type BriefingInput } from "../build-briefing";

const CALM_INPUT: BriefingInput = {
  psi: { score: 82, band: "STEADY", delta24h: 3, delta7d: 5, daysInBand: 14 },
  depegs: {
    activeCount: 0,
    activeCoins: [],
    lastClosedCoin: "TUSD",
    lastClosedDaysAgo: 6,
    lastClosedBps: 47,
  },
  dews: {
    dangerCount: 0,
    alertCount: 0,
    warningCount: 2,
    topStressed: [],
  },
  flows: {
    net24hUsd: 340_000_000,
    direction: "minting" as const,
    isStrongestIn7d: true,
    ftqTriggered: false,
    bankRunElevated: false,
  },
};

const STRESSED_INPUT: BriefingInput = {
  psi: {
    score: 55,
    band: "FRACTURE",
    delta24h: -8,
    delta7d: -15,
    daysInBand: 2,
  },
  depegs: {
    activeCount: 2,
    activeCoins: [
      { symbol: "TUSD", bps: 120 },
      { symbol: "FDUSD", bps: 85 },
    ],
    lastClosedCoin: null,
    lastClosedDaysAgo: null,
    lastClosedBps: null,
  },
  dews: {
    dangerCount: 1,
    alertCount: 2,
    warningCount: 3,
    topStressed: [{ symbol: "TUSD", band: "DANGER" }],
  },
  flows: {
    net24hUsd: -520_000_000,
    direction: "burning" as const,
    isStrongestIn7d: true,
    ftqTriggered: true,
    bankRunElevated: false,
  },
};

describe("buildBriefing", () => {
  it("produces 3 lines in calm market", () => {
    const result = buildBriefing(CALM_INPUT);
    expect(result.lines.length).toBeGreaterThanOrEqual(3);
    expect(result.lines.length).toBeLessThanOrEqual(4);
  });

  it("includes PSI band and score in headline", () => {
    const result = buildBriefing(CALM_INPUT);
    expect(result.headline).toContain("STEADY");
    expect(result.headline).toContain("82");
  });

  it("includes temporal context in headline", () => {
    const result = buildBriefing(CALM_INPUT);
    expect(result.headline).toContain("day 14");
  });

  it("uses 'over a month' for daysInBand > 30", () => {
    const input = {
      ...CALM_INPUT,
      psi: { ...CALM_INPUT.psi, daysInBand: 45 },
    };
    const result = buildBriefing(input);
    expect(result.headline).toContain("over a month");
    expect(result.headline).not.toContain("day 45");
  });

  it("mentions last closed depeg when no active depegs", () => {
    const result = buildBriefing(CALM_INPUT);
    const depegLine = result.lines.find((l) => l.type === "depegs");
    expect(depegLine?.text).toContain("TUSD");
    expect(depegLine?.text).toContain("6 days ago");
  });

  it("collapses depegs + stress into one line when all calm", () => {
    const allCalm = {
      ...CALM_INPUT,
      depegs: {
        ...CALM_INPUT.depegs,
        lastClosedCoin: null,
        lastClosedDaysAgo: null,
        lastClosedBps: null,
      },
      dews: {
        dangerCount: 0,
        alertCount: 0,
        warningCount: 0,
        topStressed: [],
      },
    };
    const result = buildBriefing(allCalm);
    const collapsed = result.lines.find((l) => l.type === "calm-summary");
    expect(collapsed).toBeDefined();
  });

  it("produces 5 lines in stressed market", () => {
    const result = buildBriefing(STRESSED_INPUT);
    expect(result.lines.length).toBeGreaterThanOrEqual(4);
    expect(result.lines.length).toBeLessThanOrEqual(5);
  });

  it("lists active depeg coins in stressed market", () => {
    const result = buildBriefing(STRESSED_INPUT);
    const depegLine = result.lines.find((l) => l.type === "depegs");
    expect(depegLine?.text).toContain("TUSD");
    expect(depegLine?.text).toContain("FDUSD");
  });

  it("includes FTQ line when triggered", () => {
    const result = buildBriefing(STRESSED_INPUT);
    const ftqLine = result.lines.find((l) => l.type === "extra");
    expect(ftqLine?.text).toContain("Flight-to-quality");
  });

  it("includes flow comparative anchor", () => {
    const result = buildBriefing(CALM_INPUT);
    const flowLine = result.lines.find((l) => l.type === "flows");
    expect(flowLine?.text).toContain("strongest");
  });

  it("sets tone based on PSI band", () => {
    expect(buildBriefing(CALM_INPUT).tone).toBe("calm");
    expect(buildBriefing(STRESSED_INPUT).tone).toBe("alert");
  });
});
