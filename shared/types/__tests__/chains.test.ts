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
      chainEnvironmentEvidence: {
        source: "pharos-chain-tier",
        score: 85,
        resilienceTier: 2,
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
  safetyScoreIdentity: ({
    model: "v8" as const,
    schemaVersion: 1 as const,
    evaluationBuildDigest: "38477f3ae65a8e0a553b4e9648dd3f8c808c18b1af63e9901bd324b995daafea",
    methodologyVersion: "v8-test",
    baseInputGenerationId: `report-cards-input:v1:${"a".repeat(64)}`,
    publicationGenerationId: "report-cards:v8-test:1777555000",
  }),
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

  it("keeps the ratio fields as plain JSON numbers on the wire", () => {
    // The six change fields are branded `Ratio` so a 0-1 value cannot be passed where a
    // 0-100 percentage is expected (chain OG images once printed a ratio with a "%"
    // suffix). The brand is type-only: it must not alter the published contract, because
    // `/api/chains` is documented and OpenAPI-specified for external consumers.
    const parsed = ChainsResponseSchema.parse(validChainsPayload);
    for (const key of ["globalChange24hPct", "globalChange7dPct", "globalChange30dPct"] as const) {
      expect(typeof parsed[key]).toBe("number");
      expect(parsed[key]).toBe(validChainsPayload[key]);
    }
    for (const key of ["change24hPct", "change7dPct", "change30dPct"] as const) {
      expect(typeof parsed.chains[0][key]).toBe("number");
      expect(parsed.chains[0][key]).toBe(validChainsPayload.chains[0][key]);
    }
    // Round-trips through JSON unchanged — no wrapper object, no string coercion.
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(JSON.parse(JSON.stringify(validChainsPayload)));
  });
});
