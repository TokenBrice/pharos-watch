import { describe, it, expect } from "vitest";
import { scoreDecentralization } from "../report-cards";

describe("scoreDecentralization (v6 — 5-band penalty)", () => {
  const makeMeta = (chainTier: string, deploymentModel: string, governanceQuality?: string) => ({
    flags: { backing: "crypto-backed" as const, governance: "decentralized" as const },
    chainTier,
    deploymentModel,
    collateralQuality: "native" as const,
    custodyModel: "onchain" as const,
    ...(governanceQuality ? { governanceQuality } : {}),
  });

  it("applies -10 penalty for infraScore 60-79", () => {
    // stage1-l2 (66) × canonical-bridge (0.90) = 59 → band 40-59 → -25
    // Actually 59.4 rounds to 59, so >= 40 → -25. Let me use a better example.
    // mature-alt-l1 (45) × single-chain (1.0) = 45 → band 40-59 → -25
    // For 60-79: stage1-l2 (66) × single-chain (1.0) = 66 → band 60-79 → -10
    const meta = makeMeta("stage1-l2", "single-chain");
    const result = scoreDecentralization("decentralized", meta as never);
    // dao-governance (85) + (-10) = 75
    expect(result.score).toBe(75);
  });

  it("applies -25 penalty for infraScore 40-59", () => {
    // mature-alt-l1 (45) × single-chain (1.0) = 45 → band 40-59 → -25
    const meta = makeMeta("mature-alt-l1", "single-chain");
    const result = scoreDecentralization("decentralized", meta as never);
    // dao-governance (85) + (-25) = 60
    expect(result.score).toBe(60);
  });

  it("applies -40 penalty for infraScore 20-39", () => {
    // established-alt-l1 (20) × single-chain (1.0) = 20 → band 20-39 → -40
    const meta = makeMeta("established-alt-l1", "single-chain");
    const result = scoreDecentralization("decentralized", meta as never);
    // dao-governance (85) + (-40) = 45
    expect(result.score).toBe(45);
  });

  it("applies -60 penalty for infraScore 0-19", () => {
    // unproven (0) × single-chain (1.0) = 0 → band <20 → -60
    const meta = makeMeta("unproven", "single-chain");
    const result = scoreDecentralization("decentralized", meta as never);
    // dao-governance (85) + (-60) = 25
    expect(result.score).toBe(25);
  });

  it("exempts wrapper governance from chain penalty", () => {
    const meta = makeMeta("unproven", "single-chain", "wrapper");
    const result = scoreDecentralization("centralized-dependent", meta as never);
    // wrapper (10) with no penalty applied
    expect(result.score).toBe(10);
  });

  it("inherits tracked variant wrapper decentralization from the parent with the variant haircut", () => {
    const meta = {
      ...makeMeta("unproven", "native-multichain", "wrapper"),
      variantOf: "bold-liquity",
      variantKind: "strategy-vault",
    };
    const result = scoreDecentralization("centralized-dependent", meta as never, {
      wrappedAssetId: "bold-liquity",
      wrappedAssetDecentralizationScore: 100,
      variantKind: "strategy-vault",
    });

    expect(result.score).toBe(95);
    expect(result.grade).toBe("A+");
    expect(result.detail).toContain("Wrapped asset: bold-liquity");
    expect(result.detail).toContain("parent 100 - 5");
  });
});
