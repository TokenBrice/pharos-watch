import { describe, it, expect } from "vitest";
import {
  scoreResilience,
  resolveGovernanceQuality,
  GOVERNANCE_QUALITY_SCORE,
  scoreDependencyRisk,
} from "../report-cards";
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
