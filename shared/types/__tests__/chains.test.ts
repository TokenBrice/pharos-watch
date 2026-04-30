import { describe, expect, it } from "vitest";
import { ChainsResponseSchema } from "../chains";

const validChainsPayload = {
  chains: [
    {
      id: "ethereum",
      name: "Ethereum",
      logoPath: "/chains/ethereum.png",
      type: "evm",
      totalUsd: 1000,
      change24h: 10,
      change24hPct: 0.01,
      change7d: 20,
      change7dPct: 0.02,
      change30d: 30,
      change30dPct: 0.03,
      stablecoinCount: 2,
      dominantStablecoin: {
        id: "usdc-circle",
        symbol: "USDC",
        share: 0.6,
      },
      topStablecoins: [
        {
          id: "usdc-circle",
          symbol: "USDC",
          share: 0.6,
          supplyUsd: 600,
        },
      ],
      dominanceShare: 0.8,
      healthScore: 82,
      healthBand: "robust",
      healthFactors: {
        concentration: 80,
        quality: null,
        pegStability: 90,
        backingDiversity: 70,
        chainEnvironment: 85,
      },
    },
  ],
  globalTotalUsd: 1250,
  chainAttributedTotalUsd: 1000,
  unattributedTotalUsd: 250,
  globalChange24hPct: 0.01,
  globalChange7dPct: 0.02,
  globalChange30dPct: 0.03,
  updatedAt: 1777555000,
  healthMethodologyVersion: "v1.0",
};

describe("ChainsResponseSchema", () => {
  it("parses the public chains endpoint payload", () => {
    const parsed = ChainsResponseSchema.parse(validChainsPayload);

    expect(parsed.chains[0].id).toBe("ethereum");
    expect(parsed.chains[0].healthFactors.quality).toBeNull();
  });

  it("rejects unknown chain runtime types", () => {
    expect(ChainsResponseSchema.safeParse({
      ...validChainsPayload,
      chains: [{ ...validChainsPayload.chains[0], type: "solana" }],
    }).success).toBe(false);
  });

  it("rejects unknown health bands", () => {
    expect(ChainsResponseSchema.safeParse({
      ...validChainsPayload,
      chains: [{ ...validChainsPayload.chains[0], healthBand: "excellent" }],
    }).success).toBe(false);
  });
});
