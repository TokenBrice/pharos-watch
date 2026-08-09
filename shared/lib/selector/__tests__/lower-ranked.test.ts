import { describe, expect, it } from "vitest";
import { selectLowerRanked, userEmphasizedDimension } from "../lower-ranked";
import type {
  ExclusionRecord,
  MergedRow,
  SelectorComponent,
  SelectorInput,
} from "../types";

function makeRow(id: string, overrides: Partial<MergedRow> = {}): MergedRow {
  return {
    id,
    symbol: id.toUpperCase(),
    name: id,
    protocolSlug: id,
    variantOf: null,
    isYieldBearing: false,
    pegCurrency: "USD",
    lifecycle: "active",
    governance: "decentralized",
    canBeBlacklisted: false,
    mechanismArchetype: null,
    supplyUsd: 100_000_000,
    pegScore: 90,
    activeDepeg: false,
    currentDeviationBps: 10,
    depegEventCount: 0,
    lastEventAt: null,
    dewsScore: 25,
    safetyGrade: "A",
    safetyScore: 80,
    safetyProvenance: "safety-score-v9",
    safetyResilienceScore: 80,
    safetyDecentralizationScore: 80,
    safetyLiquidityScore: 80,
    custodyModel: "onchain",
    bluechipGrade: "A",
    liquidityScore: 80,
    effectiveTvlUsd: 50_000_000,
    concentrationHhi: 0.3,
    chainTvl: { ethereum: 40_000_000 },
    pharosYieldScore: 80,
    apy30d: 5,
    apyVariance30d: 0.5,
    benchmarkRate: 4.5,
    sourceRiskScore: 20,
    venueRiskTier: "low",
    warningSignals: [],
    deploymentPlace: "native-wrapper",
    sourceSwitch: false,
    yieldProtocolSlug: null,
    yieldVenueChain: null,
    yieldHistoryDays: 365,
    yieldFreshness: null,
    trackingSpanDays: 365,
    isRecentListing: false,
    pegSummaryAgeSec: null,
    dexTvlAgeSec: null,
    dewsAgeSec: null,
    ...overrides,
  };
}

function input(overrides: Partial<SelectorInput> = {}): SelectorInput {
  return {
    profile: "treasury",
    pegCurrency: "USD",
    horizon: "1to6m",
    depegTolerance: "tight",
    composability: "moderate",
    exitSpeed: "any",
    minApy: null,
    yieldNativeOnly: false,
    decentralization: "any",
    custodyOk: "any",
    ...overrides,
  };
}

function comp(key: SelectorComponent["key"], normalized: number): SelectorComponent {
  return {
    key,
    weight: 10,
    rawValue: normalized,
    normalizedValue: normalized,
    contribution: 0,
    redistributed: false,
  };
}

describe("userEmphasizedDimension", () => {
  it("zero tolerance + treasury → pegStabilityHistory", () => {
    expect(userEmphasizedDimension(input({ depegTolerance: "zero" }))).toBe(
      "pegStabilityHistory",
    );
  });
  it("zero tolerance + trading → pegStabilityLive", () => {
    expect(
      userEmphasizedDimension(
        input({ profile: "trading", depegTolerance: "zero" }),
      ),
    ).toBe("pegStabilityLive");
  });
  it("composability=high → liquidity", () => {
    expect(userEmphasizedDimension(input({ composability: "high" }))).toBe("liquidity");
  });
  it("exitSpeed=1h → liquidity", () => {
    expect(userEmphasizedDimension(input({ exitSpeed: "1h" }))).toBe("liquidity");
  });
  it("treasury × 6mplus → safetyOverall", () => {
    expect(
      userEmphasizedDimension(input({ profile: "treasury", horizon: "6mplus" })),
    ).toBe("safetyOverall");
  });
  it("yield + minApy set → pharosYieldScore", () => {
    expect(
      userEmphasizedDimension(input({ profile: "yield", minApy: 5 })),
    ).toBe("pharosYieldScore");
  });
  it("default → safetyOverall", () => {
    expect(userEmphasizedDimension(input())).toBe("safetyOverall");
  });
});

describe("selectLowerRanked — Slot A", () => {
  const scorer = (row: MergedRow) => row.safetyScore ?? 0;

  it("picks by declaration-order priority, then by hypothetical score", () => {
    const allMerged = [
      makeRow("nearMissA", { safetyScore: 70 }),
      makeRow("nearMissB", { safetyScore: 60 }),
    ];
    const excluded: ExclusionRecord[] = [
      { id: "nearMissA", reason: "dews-ceiling", severity: "hard" },
      { id: "nearMissB", reason: "safety-resilience-floor", severity: "hard" },
    ];
    const result = selectLowerRanked([], excluded, input(), allMerged, new Set(), scorer);
    expect(result).toHaveLength(1);
    expect(result[0]!.slot).toBe("A");
    // Treasury PROFILE_DEFINING_EXCLUSIONS declares safety-resilience-floor before
    // dews-ceiling, so nearMissB wins on priority even with a lower hypothetical.
    expect(result[0]!.id).toBe("nearMissB");
  });

  it("within the same priority, higher hypothetical wins", () => {
    const allMerged = [
      makeRow("hi", { safetyScore: 75 }),
      makeRow("lo", { safetyScore: 50 }),
    ];
    const excluded: ExclusionRecord[] = [
      { id: "hi", reason: "dews-ceiling", severity: "hard" },
      { id: "lo", reason: "dews-ceiling", severity: "hard" },
    ];
    const result = selectLowerRanked([], excluded, input(), allMerged, new Set(), scorer);
    expect(result[0]!.id).toBe("hi");
  });

  it("Yield priority: venue-on-c-tier beats peg-score-floor", () => {
    const allMerged = [
      makeRow("hotVenue", { safetyScore: 60 }),
      makeRow("pegMiss", { safetyScore: 90 }),
    ];
    const excluded: ExclusionRecord[] = [
      { id: "hotVenue", reason: "high-venue-on-c-tier", severity: "hard" },
      { id: "pegMiss", reason: "peg-score-floor", severity: "hard" },
    ];
    const result = selectLowerRanked(
      [],
      excluded,
      input({ profile: "yield" }),
      allMerged,
      new Set(),
      scorer,
    );
    expect(result[0]!.id).toBe("hotVenue");
    expect(result[0]!.reasonKey).toBe("high-venue-on-c-tier");
  });

  it("skips coverage-too-thin (anti-rule)", () => {
    const allMerged = [makeRow("thin", { safetyScore: 95 })];
    const excluded: ExclusionRecord[] = [
      { id: "thin", reason: "coverage-too-thin", severity: "info" },
    ];
    expect(
      selectLowerRanked([], excluded, input(), allMerged, new Set(), scorer),
    ).toHaveLength(0);
  });

  it("skips shortlisted coins", () => {
    const allMerged = [makeRow("excludedShortlist", { safetyScore: 70 })];
    const excluded: ExclusionRecord[] = [
      { id: "excludedShortlist", reason: "dews-ceiling", severity: "hard" },
    ];
    const result = selectLowerRanked(
      [],
      excluded,
      input(),
      allMerged,
      new Set(["excludedShortlist"]),
      scorer,
    );
    expect(result).toHaveLength(0);
  });
});

describe("selectLowerRanked — Slot B", () => {
  const scorer = (row: MergedRow) => row.safetyScore ?? 0;

  function buildScored(rows: MergedRow[]) {
    return rows.map((row) => ({
      row,
      score: row.safetyScore ?? 0,
      confidence: 100,
      components: [
        comp("safetyOverall", row.safetyScore ?? 0),
        comp("liquidity", row.liquidityScore ?? 0),
      ],
    }));
  }

  it("picks bottom-quartile on the user-emphasized dimension among rank 4..N", () => {
    // 6 survivors; top 3 are #1-3. Among #4-6 the one with lowest safetyOverall
    // sits in the bottom quartile; we pick highest-scoring within that set.
    const rows = [
      makeRow("r1", { safetyScore: 90 }),
      makeRow("r2", { safetyScore: 88 }),
      makeRow("r3", { safetyScore: 86 }),
      // Rank 4-6 (input default emphasizes safetyOverall)
      makeRow("r4", { safetyScore: 50 }), // bottom-quartile candidate
      makeRow("r5", { safetyScore: 80 }),
      makeRow("r6", { safetyScore: 75 }),
    ];
    const scored = buildScored(rows);
    const result = selectLowerRanked(
      scored,
      [],
      input(),
      rows,
      new Set(["r1", "r2", "r3"]),
      scorer,
    );
    const slotB = result.find((r) => r.slot === "B");
    expect(slotB).toBeDefined();
    expect(slotB!.id).toBe("r4");
  });

  it("returns 0 when scored.length < 5 (insufficient candidates)", () => {
    const rows = [makeRow("a"), makeRow("b"), makeRow("c"), makeRow("d")];
    const scored = buildScored(rows);
    const result = selectLowerRanked(
      scored,
      [],
      input(),
      rows,
      new Set(),
      scorer,
    );
    // No slot B since scored.length < 5
    expect(result.filter((r) => r.slot === "B")).toHaveLength(0);
  });

  it("anti-rule: shared protocolSlug with shortlist → tries the next eligible Slot B candidate", () => {
    const rows = [
      makeRow("r1", { safetyScore: 90, protocolSlug: "circle" }),
      makeRow("r2", { safetyScore: 88, protocolSlug: "tether" }),
      makeRow("r3", { safetyScore: 86, protocolSlug: "sky" }),
      makeRow("r4", { safetyScore: 51, protocolSlug: "circle" }), // shares with r1
      makeRow("r5", { safetyScore: 50, protocolSlug: "novel" }),
      makeRow("r6", { safetyScore: 52, protocolSlug: "novel2" }),
      makeRow("r7", { safetyScore: 80, protocolSlug: "novel3" }),
      makeRow("r8", { safetyScore: 78, protocolSlug: "novel4" }),
    ];
    const scored = buildScored(rows);
    const result = selectLowerRanked(
      scored,
      [],
      input(),
      rows,
      new Set(["r1", "r2", "r3"]),
      scorer,
    );
    const slotB = result.find((r) => r.slot === "B");
    // r4 would be the bottom-quartile pick by score, but shares protocolSlug with r1.
    expect(slotB?.id).toBe("r5");
    expect(slotB?.teachingText).not.toContain("weak-");
  });
});
