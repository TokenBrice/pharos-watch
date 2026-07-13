import { describe, it, expect } from "vitest";
import { scoreDecentralization } from "../report-cards";
import { resolveOracleRiskScore } from "../report-card-governance";

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

describe("scoreDecentralization oracle-risk blend (v8.1/v8.11)", () => {
  const makeMeta = (overrides: Record<string, unknown> = {}) => ({
    flags: { backing: "crypto-backed" as const, governance: "decentralized" as const },
    mechanismArchetype: "cdp" as const,
    chainTier: "ethereum" as const,
    deploymentModel: "single-chain" as const,
    collateralQuality: "native" as const,
    custodyModel: "onchain" as const,
    governanceQuality: "immutable-code" as const,
    ...overrides,
  });
  const reviewedOracleRisk = (overrides: Record<string, unknown>) => ({
    reviewedAt: "2026-06-12",
    reviewer: "test",
    confidence: "verified" as const,
    ...overrides,
  });

  it("drags crypto-backed CDP decentralization when oracle setup undercuts it", () => {
    // immutable-code (100), single-source oracle score 45:
    // blended = round(100*0.75 + 45*0.25) = 86
    const meta = makeMeta({
      oracleRisk: reviewedOracleRisk({
        tier: "single-source-or-laggy",
        summary: "Single feed without reviewed failover",
      }),
    });
    const result = scoreDecentralization("decentralized", meta as never);
    expect(result.score).toBe(86);
    expect(result.detail).toContain("Oracle setup: Single-source or laggy feeds");
    expect(result.detailItems?.some((item) => item.label === "Oracle setup" && item.detail === "-14")).toBe(true);
  });

  it("does not lift decentralization when the oracle setup scores above the current score", () => {
    const meta = makeMeta({
      governanceQuality: "dao-governance",
      chainTier: "mature-alt-l1",
      oracleRisk: reviewedOracleRisk({
        tier: "redundant-with-failover",
        summary: "Reviewed redundant feed setup",
      }),
    });
    const result = scoreDecentralization("decentralized", meta as never);
    expect(result.score).toBe(60);
    expect(result.detailItems?.some((item) => item.label === "Oracle setup" && item.detail === "0")).toBe(true);
  });

  it("skips the oracle blend when review provenance is missing", () => {
    const meta = makeMeta({
      oracleRisk: {
        tier: "single-source-or-laggy",
        summary: "Unreviewed oracle metadata must not affect scoring.",
      },
    });
    const result = scoreDecentralization("decentralized", meta as never);
    expect(result.score).toBe(100);
    expect(result.detailItems?.some((item) => item.label === "Oracle setup")).toBe(false);
  });

  it("skips the oracle blend for non-CDP assets even when metadata is present", () => {
    const meta = makeMeta({
      mechanismArchetype: "synthetic-delta-neutral",
      oracleRisk: reviewedOracleRisk({
        tier: "opaque-or-unknown",
        summary: "Not a CDP liquidation oracle profile",
      }),
    });
    const result = scoreDecentralization("decentralized", meta as never);
    expect(result.score).toBe(100);
    expect(result.detailItems?.some((item) => item.label === "Oracle setup")).toBe(false);
  });

  it("skips direct oracle blending for tracked variants", () => {
    const meta = makeMeta({
      variantOf: "parent-cdp",
      oracleRisk: reviewedOracleRisk({
        tier: "opaque-or-unknown",
        summary: "Variant inherits the parent CDP oracle exposure.",
      }),
    });
    const result = scoreDecentralization("decentralized", meta as never);
    expect(result.score).toBe(100);
    expect(result.detailItems?.some((item) => item.label === "Oracle setup")).toBe(false);
  });

  it("applies oracle risk before the Mint Authority blend", () => {
    // dao-governance (85), single-source oracle = 75, MAS 20:
    // round(75*0.65 + 20*0.35) = 56
    const meta = makeMeta({
      governanceQuality: "dao-governance",
      oracleRisk: reviewedOracleRisk({
        tier: "single-source-or-laggy",
        summary: "Single feed without reviewed failover",
      }),
    });
    const result = scoreDecentralization("decentralized", meta as never, { mintAuthorityScore: 20 });
    expect(result.score).toBe(56);
    expect(result.detailItems?.some((item) => item.label === "Oracle setup" && item.detail === "-10")).toBe(true);
    expect(result.detailItems?.some((item) => item.label === "Mint authority" && item.detail === "-19")).toBe(true);
  });

  it("uses the weakest branch score when branch-level oracle profiles are present", () => {
    const meta = makeMeta({
      oracleRisk: reviewedOracleRisk({
        tier: "redundant-with-failover",
        summary: "Most branches have redundant oracle failover.",
        branches: [
          {
            id: "eth",
            label: "ETH branch",
            tier: "redundant-with-failover",
            summary: "ETH branch has redundant failover.",
          },
          {
            id: "lst",
            label: "LST branch",
            tier: "standard-external",
            summary: "LST branch has standard external feeds.",
          },
        ],
      }),
    });
    const result = scoreDecentralization("decentralized", meta as never);

    expect(result.score).toBe(94);
    expect(result.detail).toContain("Oracle setup: LST branch: Standard external feeds");
    expect(result.detailItems?.some((item) => item.label === "Oracle setup" && item.detail === "-6")).toBe(true);
  });

  it("selects equal-tier weakest branches deterministically by branch id", () => {
    const branches = [
      { id: "zeta", label: "Zeta", tier: "standard-external" as const, summary: "Zeta external feed." },
      { id: "alpha", label: "Alpha", tier: "standard-external" as const, summary: "Alpha external feed." },
    ];
    const first = resolveOracleRiskScore(
      makeMeta({
        oracleRisk: reviewedOracleRisk({
          tier: "standard-external",
          summary: "Branch-aware external feeds.",
          branches,
        }),
      }) as never,
    );
    const reordered = resolveOracleRiskScore(
      makeMeta({
        oracleRisk: reviewedOracleRisk({
          tier: "standard-external",
          summary: "Branch-aware external feeds.",
          branches: [...branches].reverse(),
        }),
      }) as never,
    );

    expect(first?.selectedBranch?.id).toBe("alpha");
    expect(reordered?.selectedBranch?.id).toBe("alpha");
  });
});

describe("scoreDecentralization bridge-route blend (v8.12)", () => {
  const makeMeta = (overrides: Record<string, unknown> = {}) => ({
    flags: { backing: "crypto-backed" as const, governance: "decentralized" as const },
    chainTier: "ethereum" as const,
    deploymentModel: "single-chain" as const,
    collateralQuality: "native" as const,
    custodyModel: "onchain" as const,
    governanceQuality: "dao-governance" as const,
    ...overrides,
  });

  it("keeps missing bridge-route reviews neutral", () => {
    const result = scoreDecentralization("decentralized", makeMeta() as never);
    expect(result.score).toBe(85);
    expect(result.detailItems?.some((item) => item.label === "Bridge route")).toBe(false);
  });

  it("never lifts the dimension when the reviewed route scores above the current score", () => {
    const result = scoreDecentralization(
      "centralized",
      makeMeta({
        governanceQuality: "single-entity",
        bridgeRouteRisk: {
          tier: "issuer-native-burn-mint",
          summary: "Issuer-native burn/mint route.",
          reviewedAt: "2026-06-12",
          reviewer: "test",
          confidence: "verified",
        },
      }) as never,
    );

    expect(result.score).toBe(20);
    expect(result.detailItems?.some((item) => item.label === "Bridge route" && item.detail === "0")).toBe(true);
  });

  it("drags decentralization when a reviewed external lock/mint route undercuts it", () => {
    // dao-governance (85), external lock/mint score 40:
    // round(85*0.8 + 40*0.2) = 76
    const result = scoreDecentralization(
      "decentralized",
      makeMeta({
        bridgeRouteRisk: {
          tier: "external-lock-mint",
          summary: "External bridge route with lock/mint supply.",
          reviewedAt: "2026-06-12",
          reviewer: "test",
          confidence: "verified",
        },
      }) as never,
    );

    expect(result.score).toBe(76);
    expect(result.detail).toContain("Bridge route: External lock/mint bridge");
    expect(result.detailItems?.some((item) => item.label === "Bridge route" && item.detail === "-9")).toBe(true);
  });

  it("applies bridge-route risk after oracle setup and before Mint Authority", () => {
    // immutable-code 100 -> oracle single-source 86 -> bridge route 77 -> MAS 20 => 57.
    const result = scoreDecentralization(
      "decentralized",
      makeMeta({
        governanceQuality: "immutable-code",
        mechanismArchetype: "cdp",
        oracleRisk: {
          tier: "single-source-or-laggy",
          summary: "Single feed without reviewed failover.",
          reviewedAt: "2026-06-12",
          reviewer: "test",
          confidence: "verified",
        },
        bridgeRouteRisk: {
          tier: "external-lock-mint",
          summary: "External bridge route with lock/mint supply.",
          reviewedAt: "2026-06-12",
          reviewer: "test",
          confidence: "verified",
        },
      }) as never,
      { mintAuthorityScore: 20 },
    );

    expect(result.score).toBe(57);
    expect(result.detailItems?.some((item) => item.label === "Oracle setup" && item.detail === "-14")).toBe(true);
    expect(result.detailItems?.some((item) => item.label === "Bridge route" && item.detail === "-9")).toBe(true);
    expect(result.detailItems?.some((item) => item.label === "Mint authority" && item.detail === "-20")).toBe(true);
  });
});
