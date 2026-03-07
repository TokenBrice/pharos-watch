import { describe, it, expect } from "vitest";
import {
  scoreResilience,
  isBlacklistable,
  INHERITED_BLACKLIST_THRESHOLD_PCT,
  resolveGovernanceQuality,
  GOVERNANCE_QUALITY_SCORE,
  scoreDependencyRisk,
  computeOverallGrade,
  NO_LIQUIDITY_PENALTY,
  scorePegStability,
  scoreLiquidity,
  chainInfraScore,
  computeCollateralQualityFromReserves,
} from "@shared/lib/report-cards";
import type { ReportCardDimension, PegSummaryCoin } from "@shared/types";
import type { StablecoinMeta } from "@shared/types";

// Minimal meta helper
function makeMeta(overrides: Partial<StablecoinMeta> = {}): StablecoinMeta {
  return {
    id: "test",
    name: "Test Coin",
    symbol: "TST",
    geckoId: null,
    cmcId: null,
    llamaId: null,
    peg: "USD",
    decimals: {},
    contracts: {},
    links: {},
    flags: { governance: "centralized", backing: "rwa-backed", pegCurrency: "USD", yieldBearing: false, rwa: true, navToken: false },
    ...overrides,
  } as StablecoinMeta;
}

function makePeg(overrides: Partial<PegSummaryCoin> = {}): PegSummaryCoin {
  return {
    id: "test",
    symbol: "TST",
    name: "Test Coin",
    pegType: "peggedUSD",
    pegCurrency: "USD",
    governance: "centralized",
    currentDeviationBps: 5,
    pegScore: 90,
    pegPct: 99,
    severityScore: 95,
    spreadPenalty: 0,
    eventCount: 1,
    worstDeviationBps: -200,
    activeDepeg: false,
    lastEventAt: 1700000000,
    trackingSpanDays: 365,
    methodologyVersion: "v1",
    ...overrides,
  };
}

describe("scoreResilience — blacklist sub-factor", () => {
  const meta = makeMeta();

  it("scores 33 for blacklistable coins", () => {
    const result = scoreResilience(meta, true);
    expect(result.detail).toContain("Blacklist: Yes (33)");
  });

  it("scores 66 for possibly blacklistable coins", () => {
    const result = scoreResilience(meta, "possible");
    expect(result.detail).toContain("Blacklist: Possible (mutable contract) (66)");
  });

  it("scores 100 for non-blacklistable coins", () => {
    const result = scoreResilience(meta, false);
    expect(result.detail).toContain("Blacklist: No (100)");
  });
});

describe("resolveGovernanceQuality — regulated-entity auto-promotion", () => {
  it("promotes to regulated-entity when regulator + license + independent-audit", () => {
    const meta = makeMeta({
      jurisdiction: { country: "United States", regulator: "NYDFS", license: "BitLicense" },
      proofOfReserves: { type: "independent-audit", url: "https://example.com", provider: "Deloitte" },
    });
    expect(resolveGovernanceQuality("centralized", meta)).toBe("regulated-entity");
  });

  it("stays single-entity when regulator is missing", () => {
    const meta = makeMeta({
      jurisdiction: { country: "BVI" },
      proofOfReserves: { type: "independent-audit", url: "https://example.com" },
    });
    expect(resolveGovernanceQuality("centralized", meta)).toBe("single-entity");
  });

  it("stays single-entity when PoR is self-reported", () => {
    const meta = makeMeta({
      jurisdiction: { country: "United States", regulator: "NYDFS", license: "BitLicense" },
      proofOfReserves: { type: "self-reported", url: "https://example.com" },
    });
    expect(resolveGovernanceQuality("centralized", meta)).toBe("single-entity");
  });

  it("stays single-entity when no PoR at all", () => {
    const meta = makeMeta({
      jurisdiction: { country: "United States", regulator: "NYDFS", license: "BitLicense" },
    });
    expect(resolveGovernanceQuality("centralized", meta)).toBe("single-entity");
  });

  it("does not promote decentralized governance", () => {
    const meta = makeMeta({
      flags: { governance: "decentralized", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false },
      jurisdiction: { country: "United States", regulator: "NYDFS", license: "BitLicense" },
      proofOfReserves: { type: "independent-audit", url: "https://example.com" },
    });
    expect(resolveGovernanceQuality("decentralized", meta)).toBe("dao-governance");
  });

  it("respects explicit governanceQuality override", () => {
    const meta = makeMeta({
      governanceQuality: "single-entity",
      jurisdiction: { country: "United States", regulator: "NYDFS", license: "BitLicense" },
      proofOfReserves: { type: "independent-audit", url: "https://example.com" },
    });
    expect(resolveGovernanceQuality("centralized", meta)).toBe("single-entity");
  });
});

describe("GOVERNANCE_QUALITY_SCORE", () => {
  it("scores regulated-entity at 40", () => {
    expect(GOVERNANCE_QUALITY_SCORE["regulated-entity"]).toBe(40);
  });

  it("scores single-entity at 20", () => {
    expect(GOVERNANCE_QUALITY_SCORE["single-entity"]).toBe(20);
  });
});

describe("scoreDependencyRisk — reserve-derived dependencies", () => {
  it("scores 95 when no dependencies and no reserves", () => {
    const meta = makeMeta();
    const scores = new Map<string, number>();
    const result = scoreDependencyRisk(meta, scores);
    expect(result.score).toBe(95);
  });

  it("uses coinId-linked reserves instead of manual dependencies", () => {
    const meta = makeMeta({
      dependencies: [{ id: "usdc-circle", weight: 0.1 }], // stale: only 10% USDC
      reserves: [
        { name: "USDtb", pct: 90, risk: "low", coinId: "usdtb-ethena" },
        { name: "USDC", pct: 10, risk: "low", coinId: "usdc-circle" },
      ],
    });
    const scores = new Map([["usdtb-ethena", 85], ["usdc-circle", 95]]);
    const result = scoreDependencyRisk(meta, scores);
    // Blended: 0.9 * 85 + 0.1 * 95 = 86, self-backed = 0
    expect(result.score).toBe(86);
    expect(result.detail).toContain("2 upstream");
  });

  it("falls back to manual dependencies when reserves have no coinId", () => {
    const meta = makeMeta({
      dependencies: [{ id: "usdc-circle", weight: 0.5 }],
      reserves: [
        { name: "U.S. Treasuries", pct: 80, risk: "very-low" },
        { name: "Cash", pct: 20, risk: "very-low" },
      ],
    });
    const scores = new Map([["usdc-circle", 90]]);
    const result = scoreDependencyRisk(meta, scores);
    // 50% USDC (90) + 50% self-backed (95 for centralized) = 92.5 → 93
    expect(result.score).toBe(93);
  });

  it("applies wrapper ceiling from reserve depType", () => {
    const meta = makeMeta({
      flags: { governance: "centralized-dependent", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false },
      reserves: [
        { name: "USDe", pct: 100, risk: "low", coinId: "usde-ethena", depType: "wrapper" },
      ],
    });
    const scores = new Map([["usde-ethena", 80]]);
    const result = scoreDependencyRisk(meta, scores);
    // Wrapper ceiling: 80 - 3 = 77
    expect(result.score).toBe(77);
    expect(result.detail).toContain("wrapper dependency ceiling");
  });
});

describe("computeOverallGrade — no-liquidity penalty", () => {
  function makeRatedDim(score: number): ReportCardDimension {
    return { grade: "B", score, detail: "" };
  }
  const nrDim: ReportCardDimension = { grade: "NR", score: null, detail: "" };

  it("applies 0.9x multiplier when liquidity is NR", () => {
    const withLiq = computeOverallGrade({
      pegStability: makeRatedDim(95),
      liquidity: makeRatedDim(80),
      resilience: makeRatedDim(80),
      decentralization: makeRatedDim(80),
      dependencyRisk: makeRatedDim(80),
    });
    const noLiq = computeOverallGrade({
      pegStability: makeRatedDim(95),
      liquidity: nrDim,
      resilience: makeRatedDim(80),
      decentralization: makeRatedDim(80),
      dependencyRisk: makeRatedDim(80),
    });
    expect(noLiq.score).not.toBeNull();
    // No-liq score must be strictly less than with-liq score
    expect(noLiq.score!).toBeLessThan(withLiq.score!);
    // Penalty ratio must be ~0.9 (accounting for rounding)
    expect(noLiq.score! / withLiq.score!).toBeCloseTo(NO_LIQUIDITY_PENALTY, 1);
  });

  it("does not apply the penalty when liquidity is rated", () => {
    const result = computeOverallGrade({
      pegStability: makeRatedDim(95),
      liquidity: makeRatedDim(70),
      resilience: makeRatedDim(80),
      decentralization: makeRatedDim(80),
      dependencyRisk: makeRatedDim(80),
    });
    // Score should NOT be further penalised beyond normal weighting
    expect(result.score).not.toBeNull();
    expect(result.grade).not.toBe("NR");
  });
});

describe("scoreResilience — possible-inherited blacklist label", () => {
  it("scores 66 and labels Possible (inherited) for possible-inherited", () => {
    const result = scoreResilience(makeMeta(), "possible-inherited");
    expect(result.detail).toContain("Blacklist: Possible (inherited) (66)");
  });
});

describe("isBlacklistable — inherited risk from reserves", () => {
  it("exports INHERITED_BLACKLIST_THRESHOLD_PCT as 25", () => {
    expect(INHERITED_BLACKLIST_THRESHOLD_PCT).toBe(25);
  });

  it("returns true for centralized governance (no index needed)", () => {
    const meta = makeMeta({ flags: { governance: "centralized", backing: "rwa-backed", pegCurrency: "USD", yieldBearing: false, rwa: true, navToken: false } });
    expect(isBlacklistable(meta)).toBe(true);
  });

  it("returns false for decentralized governance with no reserves", () => {
    const meta = makeMeta({ flags: { governance: "decentralized", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false } });
    expect(isBlacklistable(meta)).toBe(false);
  });

  it("returns possible-inherited when ≥25% of reserves link to blacklistable coinIds", () => {
    const meta = makeMeta({
      flags: { governance: "decentralized", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false },
      reserves: [
        { name: "USDC via PSM", pct: 33, risk: "low", coinId: "usdc-circle" },
        { name: "ETH", pct: 67, risk: "medium" },
      ],
    });
    const blacklistableIds = new Set(["usdc-circle"]);
    expect(isBlacklistable(meta, blacklistableIds)).toBe("possible-inherited");
  });

  it("returns false when blacklistable reserve share is below threshold (24%)", () => {
    const meta = makeMeta({
      flags: { governance: "decentralized", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false },
      reserves: [
        { name: "USDC buffer", pct: 24, risk: "low", coinId: "usdc-circle" },
        { name: "ETH", pct: 76, risk: "medium" },
      ],
    });
    const blacklistableIds = new Set(["usdc-circle"]);
    expect(isBlacklistable(meta, blacklistableIds)).toBe(false);
  });

  it("explicit canBeBlacklisted: false override wins even with heavy blacklistable reserves", () => {
    const meta = makeMeta({
      canBeBlacklisted: false,
      flags: { governance: "decentralized", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false },
      reserves: [
        { name: "USDC", pct: 100, risk: "low", coinId: "usdc-circle" },
      ],
    });
    const blacklistableIds = new Set(["usdc-circle"]);
    expect(isBlacklistable(meta, blacklistableIds)).toBe(false);
  });

  it("returns false when reserves have coinIds but none are in the blacklistable index", () => {
    const meta = makeMeta({
      flags: { governance: "decentralized", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false },
      reserves: [
        { name: "sDAI", pct: 50, risk: "low", coinId: "dai-makerdao" },
        { name: "ETH", pct: 50, risk: "medium" },
      ],
    });
    const blacklistableIds = new Set(["usdc-circle", "usdt-tether"]);
    expect(isBlacklistable(meta, blacklistableIds)).toBe(false);
  });

  it("ignores reserve slices without coinId when computing inherited share", () => {
    const meta = makeMeta({
      flags: { governance: "decentralized", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false },
      reserves: [
        { name: "USDC (unlabelled)", pct: 30, risk: "low" },
        { name: "ETH", pct: 70, risk: "medium" },
      ],
    });
    const blacklistableIds = new Set(["usdc-circle"]);
    expect(isBlacklistable(meta, blacklistableIds)).toBe(false);
  });
});

describe("scorePegStability", () => {
  // --- NR cases ---

  it("returns NR for NAV tokens", () => {
    const meta = makeMeta({ flags: { governance: "centralized", backing: "rwa-backed", pegCurrency: "USD", yieldBearing: false, rwa: true, navToken: true } });
    const result = scorePegStability(makePeg({ pegScore: 95 }), meta);
    expect(result.grade).toBe("NR");
    expect(result.score).toBeNull();
    expect(result.detail).toContain("NAV token");
  });

  it("returns NR when peg is undefined", () => {
    const result = scorePegStability(undefined, makeMeta());
    expect(result.grade).toBe("NR");
    expect(result.score).toBeNull();
  });

  it("returns NR when pegScore is null", () => {
    const result = scorePegStability(makePeg({ pegScore: null }), makeMeta());
    expect(result.grade).toBe("NR");
    expect(result.score).toBeNull();
  });

  it("returns NR when no price data and no events", () => {
    const result = scorePegStability(
      makePeg({ currentDeviationBps: null, eventCount: 0, pegScore: 80 }),
      makeMeta(),
    );
    expect(result.grade).toBe("NR");
    expect(result.score).toBeNull();
    expect(result.detail).toContain("No price data");
  });

  // --- Score clamping ---

  it("clamps score to 0-100 range", () => {
    const over = scorePegStability(makePeg({ pegScore: 110 }), makeMeta());
    expect(over.score).toBe(100);

    const under = scorePegStability(makePeg({ pegScore: -5 }), makeMeta());
    expect(under.score).toBe(0);
  });

  it("rounds pegScore to nearest integer", () => {
    const result = scorePegStability(makePeg({ pegScore: 87.6 }), makeMeta());
    expect(result.score).toBe(88);
  });

  // --- Active depeg cap ---

  it("caps score at 65 during active depeg", () => {
    const result = scorePegStability(
      makePeg({ pegScore: 90, activeDepeg: true }),
      makeMeta(),
    );
    expect(result.score).toBe(65);
    expect(result.detail).toContain("active depeg");
    expect(result.detail).toContain("capped at C");
  });

  it("does not raise score to 65 when pegScore is already below 65 during active depeg", () => {
    const result = scorePegStability(
      makePeg({ pegScore: 40, activeDepeg: true }),
      makeMeta(),
    );
    expect(result.score).toBe(40);
  });

  // --- Grade mapping ---

  it("maps score to correct grade via scoreToGrade", () => {
    const high = scorePegStability(makePeg({ pegScore: 95 }), makeMeta());
    expect(high.grade).toBe("A+");

    const mid = scorePegStability(makePeg({ pegScore: 72 }), makeMeta());
    expect(mid.grade).toBe("B");

    const low = scorePegStability(makePeg({ pegScore: 30 }), makeMeta());
    expect(low.grade).toBe("F");
  });

  // --- Detail string ---

  it("includes event count in detail", () => {
    const single = scorePegStability(makePeg({ eventCount: 1 }), makeMeta());
    expect(single.detail).toContain("1 depeg event");
    expect(single.detail).not.toContain("events");

    const multi = scorePegStability(makePeg({ eventCount: 3 }), makeMeta());
    expect(multi.detail).toContain("3 depeg events");
  });

  it("includes worst deviation when present", () => {
    const result = scorePegStability(makePeg({ worstDeviationBps: -500 }), makeMeta());
    expect(result.detail).toContain("-500 bps");
  });

  it("notes 'No depeg events' when eventCount is 0 but has price data", () => {
    const result = scorePegStability(
      makePeg({ eventCount: 0, currentDeviationBps: 5, worstDeviationBps: null }),
      makeMeta(),
    );
    expect(result.detail).toContain("No depeg events");
  });

  it("appends yield-bearing annotation when flag is set", () => {
    const meta = makeMeta({ flags: { governance: "centralized", backing: "rwa-backed", pegCurrency: "USD", yieldBearing: true, rwa: true, navToken: false } });
    const result = scorePegStability(makePeg(), meta);
    expect(result.detail).toContain("yield-bearing");
  });

  it("does not append yield-bearing annotation when flag is false", () => {
    const result = scorePegStability(makePeg(), makeMeta());
    expect(result.detail).not.toContain("yield-bearing");
  });
});

describe("scoreLiquidity", () => {
  // --- NR case ---

  it("returns NR when liq is undefined", () => {
    const result = scoreLiquidity(undefined);
    expect(result.grade).toBe("NR");
    expect(result.score).toBeNull();
    expect(result.detail).toBe("No DEX liquidity data");
  });

  it("returns NR when liquidityScore is null", () => {
    const result = scoreLiquidity({ liquidityScore: null, concentrationHhi: null, poolCount: 0, chainCount: 0 });
    expect(result.grade).toBe("NR");
    expect(result.score).toBeNull();
  });

  // --- Score clamping ---

  it("clamps score to 0-100 range", () => {
    const over = scoreLiquidity({ liquidityScore: 105, concentrationHhi: 0.2, poolCount: 5, chainCount: 2 });
    expect(over.score).toBe(100);

    const under = scoreLiquidity({ liquidityScore: -3, concentrationHhi: 0.2, poolCount: 1, chainCount: 1 });
    expect(under.score).toBe(0);
  });

  it("rounds to nearest integer", () => {
    const result = scoreLiquidity({ liquidityScore: 74.6, concentrationHhi: 0.3, poolCount: 3, chainCount: 1 });
    expect(result.score).toBe(75);
    expect(result.grade).toBe("B+");
  });

  // --- Grade mapping ---

  it("maps high score to A+ grade", () => {
    const result = scoreLiquidity({ liquidityScore: 92, concentrationHhi: 0.1, poolCount: 20, chainCount: 5 });
    expect(result.grade).toBe("A+");
  });

  it("maps low score to F grade", () => {
    const result = scoreLiquidity({ liquidityScore: 15, concentrationHhi: 0.8, poolCount: 1, chainCount: 1 });
    expect(result.grade).toBe("F");
  });

  // --- Detail string ---

  it("includes pool and chain counts with correct pluralization", () => {
    const single = scoreLiquidity({ liquidityScore: 80, concentrationHhi: 0.2, poolCount: 1, chainCount: 1 });
    expect(single.detail).toContain("1 pool across 1 chain");

    const multi = scoreLiquidity({ liquidityScore: 80, concentrationHhi: 0.2, poolCount: 12, chainCount: 3 });
    expect(multi.detail).toContain("12 pools across 3 chains");
  });

  // --- HHI concentration warning ---

  it("includes concentration warning when HHI > 0.5", () => {
    const result = scoreLiquidity({ liquidityScore: 70, concentrationHhi: 0.75, poolCount: 3, chainCount: 1 });
    expect(result.detail).toContain("high concentration");
    expect(result.detail).toContain("HHI: 0.75");
  });

  it("does not include concentration warning when HHI <= 0.5", () => {
    const result = scoreLiquidity({ liquidityScore: 70, concentrationHhi: 0.5, poolCount: 3, chainCount: 2 });
    expect(result.detail).not.toContain("concentration");
  });

  it("does not include concentration warning when HHI is null", () => {
    const result = scoreLiquidity({ liquidityScore: 70, concentrationHhi: null, poolCount: 3, chainCount: 2 });
    expect(result.detail).not.toContain("concentration");
  });
});

describe("chainInfraScore", () => {
  // --- Exact milestone values ---

  it("returns 100 for ethereum + single-chain", () => {
    expect(chainInfraScore("ethereum", "single-chain")).toBe(100);
  });

  it("returns 85 for ethereum + canonical-bridge", () => {
    expect(chainInfraScore("ethereum", "canonical-bridge")).toBe(85);
  });

  it("returns 60 for ethereum + third-party-bridge", () => {
    expect(chainInfraScore("ethereum", "third-party-bridge")).toBe(60);
  });

  it("returns 40 for ethereum + native-multichain", () => {
    expect(chainInfraScore("ethereum", "native-multichain")).toBe(40);
  });

  it("returns 66 for stage1-l2 + single-chain", () => {
    expect(chainInfraScore("stage1-l2", "single-chain")).toBe(66);
  });

  it("returns 56 for stage1-l2 + canonical-bridge", () => {
    // 66 * 0.85 = 56.1, rounded to 56
    expect(chainInfraScore("stage1-l2", "canonical-bridge")).toBe(56);
  });

  it("returns 26 for stage1-l2 + native-multichain", () => {
    // 66 * 0.40 = 26.4, rounded to 26
    expect(chainInfraScore("stage1-l2", "native-multichain")).toBe(26);
  });

  it("returns 20 for established-alt-l1 + single-chain", () => {
    expect(chainInfraScore("established-alt-l1", "single-chain")).toBe(20);
  });

  it("returns 0 for unproven + any deployment model", () => {
    expect(chainInfraScore("unproven", "single-chain")).toBe(0);
    expect(chainInfraScore("unproven", "canonical-bridge")).toBe(0);
    expect(chainInfraScore("unproven", "native-multichain")).toBe(0);
  });

  // --- Rounding ---

  it("rounds to nearest integer (stage1-l2 + third-party-bridge)", () => {
    // 66 * 0.60 = 39.6, rounded to 40
    expect(chainInfraScore("stage1-l2", "third-party-bridge")).toBe(40);
  });
});

describe("computeCollateralQualityFromReserves", () => {
  it("returns 0 for empty reserves array", () => {
    expect(computeCollateralQualityFromReserves([])).toBe(0);
  });

  it("returns 100 for 100% very-low risk reserves", () => {
    const reserves = [{ name: "US Treasuries", pct: 100, risk: "very-low" as const }];
    expect(computeCollateralQualityFromReserves(reserves)).toBe(100);
  });

  it("returns 5 for 100% very-high risk reserves", () => {
    const reserves = [{ name: "Algo backing", pct: 100, risk: "very-high" as const }];
    expect(computeCollateralQualityFromReserves(reserves)).toBe(5);
  });

  it("computes weighted average for mixed reserves", () => {
    const reserves = [
      { name: "Treasuries", pct: 60, risk: "very-low" as const },  // 60% * 100 = 6000
      { name: "Corporate bonds", pct: 40, risk: "medium" as const }, // 40% * 50  = 2000
    ];
    // (6000 + 2000) / 100 = 80
    expect(computeCollateralQualityFromReserves(reserves)).toBe(80);
  });

  it("handles reserves that don't sum to 100%", () => {
    const reserves = [
      { name: "USDC", pct: 30, risk: "low" as const },     // 30 * 75 = 2250
      { name: "ETH", pct: 20, risk: "high" as const },      // 20 * 25 = 500
    ];
    // totalPct = 50, weighted = 2750, result = 2750/50 = 55
    expect(computeCollateralQualityFromReserves(reserves)).toBe(55);
  });

  it("rounds to nearest integer", () => {
    const reserves = [
      { name: "Treasuries", pct: 70, risk: "very-low" as const },  // 70 * 100 = 7000
      { name: "Crypto", pct: 30, risk: "high" as const },           // 30 * 25  = 750
    ];
    // (7000 + 750) / 100 = 77.5, rounded to 78
    expect(computeCollateralQualityFromReserves(reserves)).toBe(78);
  });

  it("returns 0 when all pct values are 0", () => {
    const reserves = [{ name: "Ghost", pct: 0, risk: "very-low" as const }];
    expect(computeCollateralQualityFromReserves(reserves)).toBe(0);
  });
});
