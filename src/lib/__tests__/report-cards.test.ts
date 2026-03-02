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
} from "../report-cards";
import type { ReportCardDimension } from "../types";
import type { StablecoinMeta } from "../types";

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
      dependencies: [{ id: "2", weight: 0.1 }], // stale: only 10% USDC
      reserves: [
        { name: "USDtb", pct: 90, risk: "low", coinId: "221" },
        { name: "USDC", pct: 10, risk: "low", coinId: "2" },
      ],
    });
    const scores = new Map([["221", 85], ["2", 95]]);
    const result = scoreDependencyRisk(meta, scores);
    // Blended: 0.9 * 85 + 0.1 * 95 = 86, self-backed = 0
    expect(result.score).toBe(86);
    expect(result.detail).toContain("2 upstream");
  });

  it("falls back to manual dependencies when reserves have no coinId", () => {
    const meta = makeMeta({
      dependencies: [{ id: "2", weight: 0.5 }],
      reserves: [
        { name: "U.S. Treasuries", pct: 80, risk: "very-low" },
        { name: "Cash", pct: 20, risk: "very-low" },
      ],
    });
    const scores = new Map([["2", 90]]);
    const result = scoreDependencyRisk(meta, scores);
    // 50% USDC (90) + 50% self-backed (95 for centralized) = 92.5 → 93
    expect(result.score).toBe(93);
  });

  it("applies wrapper ceiling from reserve depType", () => {
    const meta = makeMeta({
      flags: { governance: "centralized-dependent", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false },
      reserves: [
        { name: "USDe", pct: 100, risk: "low", coinId: "146", depType: "wrapper" },
      ],
    });
    const scores = new Map([["146", 80]]);
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
        { name: "USDC via PSM", pct: 33, risk: "low", coinId: "2" },
        { name: "ETH", pct: 67, risk: "medium" },
      ],
    });
    const blacklistableIds = new Set(["2"]);
    expect(isBlacklistable(meta, blacklistableIds)).toBe("possible-inherited");
  });

  it("returns false when blacklistable reserve share is below threshold (24%)", () => {
    const meta = makeMeta({
      flags: { governance: "decentralized", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false },
      reserves: [
        { name: "USDC buffer", pct: 24, risk: "low", coinId: "2" },
        { name: "ETH", pct: 76, risk: "medium" },
      ],
    });
    const blacklistableIds = new Set(["2"]);
    expect(isBlacklistable(meta, blacklistableIds)).toBe(false);
  });

  it("explicit canBeBlacklisted: false override wins even with heavy blacklistable reserves", () => {
    const meta = makeMeta({
      canBeBlacklisted: false,
      flags: { governance: "decentralized", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false },
      reserves: [
        { name: "USDC", pct: 100, risk: "low", coinId: "2" },
      ],
    });
    const blacklistableIds = new Set(["2"]);
    expect(isBlacklistable(meta, blacklistableIds)).toBe(false);
  });

  it("returns false when reserves have coinIds but none are in the blacklistable index", () => {
    const meta = makeMeta({
      flags: { governance: "decentralized", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false },
      reserves: [
        { name: "sDAI", pct: 50, risk: "low", coinId: "5" },
        { name: "ETH", pct: 50, risk: "medium" },
      ],
    });
    const blacklistableIds = new Set(["2", "1"]);
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
    const blacklistableIds = new Set(["2"]);
    expect(isBlacklistable(meta, blacklistableIds)).toBe(false);
  });
});
