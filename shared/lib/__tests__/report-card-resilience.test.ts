import { describe, it, expect } from "vitest";
import { scoreResilience, chainInfraScore } from "../report-cards";

describe("chainInfraScore", () => {
  it("scores mature-alt-l1 single-chain at 45", () => {
    expect(chainInfraScore("mature-alt-l1", "single-chain")).toBe(45);
  });

  it("scores ethereum single-chain at 100", () => {
    expect(chainInfraScore("ethereum", "single-chain")).toBe(100);
  });
});

describe("scoreResilience (v6 — 2-factor)", () => {
  const makeMeta = (overrides: Record<string, unknown>) => ({
    flags: { backing: "rwa-backed" as const, governance: "centralized" as const },
    ...overrides,
  });

  it("uses (collateral + custody) / 2, not 3-factor", () => {
    // On-chain custody (100) + native collateral via reserves
    const meta = makeMeta({
      custodyModel: "onchain" as const,
      reserves: [{ name: "ETH", pct: 100, risk: "very-low" as const }],
    });
    const result = scoreResilience(meta as never, false);
    // collateral = 100 (very-low risk), custody = 100 → avg = 100
    expect(result.score).toBe(100);
  });

  it("blacklist detail says 'descriptive only'", () => {
    const meta = makeMeta({
      custodyModel: "institutional-top" as const,
      reserves: [{ name: "T-bills", pct: 100, risk: "very-low" as const }],
    });
    const result = scoreResilience(meta as never, true);
    expect(result.detail).toContain("descriptive only");
    expect(result.detailItems).toEqual([
      { label: "Collateral", value: "Very low risk", detail: "100" },
      { label: "Custody", value: "Top-tier custodian", detail: "80" },
      { label: "Blacklist", value: "Yes", detail: "descriptive only" },
    ]);
  });

  it("produces correct scores for all 6 custody model tiers", () => {
    const expected: Record<string, number> = {
      onchain: 100,
      "institutional-top": 80,
      "institutional-regulated": 55,
      "institutional-unregulated": 30,
      "institutional-sanctioned": 5,
      cex: 0,
    };
    for (const [model, custodyScore] of Object.entries(expected)) {
      const meta = makeMeta({
        custodyModel: model,
        reserves: [{ name: "Asset", pct: 100, risk: "very-low" as const }],
      });
      const result = scoreResilience(meta as never, false);
      // collateral = 100, custody = custodyScore → avg
      expect(result.score).toBe(Math.round((100 + custodyScore) / 2));
    }
  });

  it("USDC Resilience > A7A5 Resilience", () => {
    const usdc = makeMeta({
      custodyModel: "institutional-top" as const,
      reserves: [{ name: "T-bills", pct: 100, risk: "very-low" as const }],
    });
    const a7a5 = makeMeta({
      custodyModel: "institutional-sanctioned" as const,
      reserves: [{ name: "RUB deposits (sanctioned)", pct: 100, risk: "very-high" as const }],
    });
    const usdcResult = scoreResilience(usdc as never, true);
    const a7a5Result = scoreResilience(a7a5 as never, true);
    expect(usdcResult.score).toBeGreaterThan(a7a5Result.score!);
  });

  it("LUSD-like fully on-chain coin scores 100", () => {
    const meta = makeMeta({
      flags: { backing: "crypto-backed" as const, governance: "decentralized" as const },
      custodyModel: "onchain" as const,
      reserves: [{ name: "ETH", pct: 100, risk: "very-low" as const }],
    });
    const result = scoreResilience(meta as never, false);
    expect(result.score).toBe(100);
  });
});
