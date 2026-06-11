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

describe("scoreDecentralization mint-authority blend (v8)", () => {
  const makeMeta = (chainTier: string, deploymentModel: string, governanceQuality?: string) => ({
    flags: { backing: "crypto-backed" as const, governance: "decentralized" as const },
    chainTier,
    deploymentModel,
    collateralQuality: "native" as const,
    custodyModel: "onchain" as const,
    ...(governanceQuality ? { governanceQuality } : {}),
  });

  it("drags the dimension when the MAS undercuts it (penalty-only)", () => {
    // dao-governance (85), ethereum/single-chain (no penalty), MAS 20:
    // blended = round(85*0.65 + 20*0.35) = 62
    const meta = makeMeta("ethereum", "single-chain");
    const result = scoreDecentralization("decentralized", meta as never, { mintAuthorityScore: 20 });
    expect(result.score).toBe(62);
    expect(result.detail).toContain("Mint authority: 20/100 (Exposed)");
    expect(result.detailItems?.some((item) => item.label === "Mint authority" && item.detail === "-23")).toBe(true);
  });

  it("never lifts the dimension when the MAS exceeds it", () => {
    // single-entity (20), MAS 80: blended = round(20*0.65 + 80*0.35) = 41 > 20 → unchanged
    const meta = makeMeta("ethereum", "single-chain", "single-entity");
    const result = scoreDecentralization("centralized", meta as never, { mintAuthorityScore: 80 });
    expect(result.score).toBe(20);
    expect(result.detailItems?.some((item) => item.label === "Mint authority")).toBe(false);
  });

  it("skips the blend when the MAS is null, absent, or not finite", () => {
    const meta = makeMeta("ethereum", "single-chain");
    expect(scoreDecentralization("decentralized", meta as never, { mintAuthorityScore: null }).score).toBe(85);
    expect(scoreDecentralization("decentralized", meta as never, {}).score).toBe(85);
    expect(scoreDecentralization("decentralized", meta as never, { mintAuthorityScore: Number.NaN }).score).toBe(85);
  });

  it("applies the blend after wrapper inheritance", () => {
    // wrapper inherits parent 100 - 5 = 95 (chain penalty exempt), MAS 25:
    // blended = round(95*0.65 + 25*0.35) = 71
    const meta = {
      ...makeMeta("unproven", "native-multichain", "wrapper"),
      variantOf: "bold-liquity",
      variantKind: "strategy-vault",
    };
    const result = scoreDecentralization("centralized-dependent", meta as never, {
      wrappedAssetId: "bold-liquity",
      wrappedAssetDecentralizationScore: 100,
      variantKind: "strategy-vault",
      mintAuthorityScore: 25,
    });
    expect(result.score).toBe(71);
    expect(result.detail).toContain("parent 100 - 5");
    expect(result.detail).toContain("Mint authority: 25/100 (Exposed)");
  });

  it("caps an inherited wrapper at the parent's blended score when the wrapper MAS is unrated", () => {
    // Parent pre-blend 75, blended 56 (its own MAS drag). Wrapper inherits
    // 75 - 5 = 70 but has no rated MAS: without the ceiling it would
    // out-score its dragged parent; the ceiling holds it at 56.
    const meta = {
      ...makeMeta("ethereum", "single-chain", "wrapper"),
      variantOf: "parent-coin",
      variantKind: "strategy-vault",
    };
    const result = scoreDecentralization("centralized-dependent", meta as never, {
      wrappedAssetId: "parent-coin",
      wrappedAssetDecentralizationScore: 75,
      wrappedAssetBlendedDecentralizationScore: 56,
      variantKind: "strategy-vault",
    });
    expect(result.score).toBe(56);
  });

  it("applies the blend after the chain penalty", () => {
    // dao-governance (85) - 25 (mature-alt-l1) = 60, MAS 30:
    // blended = round(60*0.65 + 30*0.35) = 50 (rounding: 39 + 10.5 = 49.5 -> 50)
    const meta = makeMeta("mature-alt-l1", "single-chain");
    const result = scoreDecentralization("decentralized", meta as never, { mintAuthorityScore: 30 });
    expect(result.score).toBe(50);
    expect(result.detailItems?.some((item) => item.label === "Chain")).toBe(true);
    expect(result.detailItems?.some((item) => item.label === "Mint authority" && item.detail === "-10")).toBe(true);
  });
});
