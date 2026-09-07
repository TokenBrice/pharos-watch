import { describe, expect, it } from "vitest";
import {
  LegacyPublicSnapshotEnvelopeV1Schema,
  PublicSnapshotEnvelopeSchema,
  PublicSnapshotEnvelopeV2Schema,
} from "../public-snapshot";

const IDENTITY = {
  model: "v8" as const,
  schemaVersion: 1 as const,
  methodologyVersion: "7.25",
  evaluationBuildDigest: "a".repeat(64),
  baseInputGenerationId: `report-cards-input:v1:${"b".repeat(64)}`,
  publicationGenerationId: "report-cards:7.25:1779105600",
};

const V2_ENVELOPE = {
  version: 2 as const,
  snapshotDate: "2026-05-16",
  generatedAt: 1779105600,
  methodologyVersions: { reportCard: "7.25" },
  safetyScoreIdentity: IDENTITY,
  stablecoins: [{
    id: "usdc-circle",
    name: "USD Coin",
    symbol: "USDC",
    pegType: "peggedUSD",
    pegMechanism: "fiat-backed",
    price: 1,
    circulating: { peggedUSD: 50_000_000_000 },
    chains: ["Ethereum"],
  }],
  fxFallbackRates: null,
  reportCards: { scores: {} },
  psi: {
    computedAt: 1779062400,
    score: 87.4,
    band: "STEADY",
    components: {},
    methodologyVersion: "3.3",
  },
  dews: [{
    stablecoinId: "usdc-circle",
    computedAt: 1779105000,
    score: 18,
    band: "CALM",
    signals: {},
  }],
  liquidity: [{
    stablecoinId: "usdc-circle",
    totalTvlUsd: 1_500_000_000,
    totalVolume24hUsd: 800_000_000,
    poolCount: 124,
    liquidityScore: 9.2,
    durabilityScore: 8.6,
    coverageClass: "deep",
    updatedAt: 1779105600,
  }],
};

describe("PublicSnapshotEnvelopeSchema", () => {
  it("accepts the strict v2 producer contract", () => {
    expect(PublicSnapshotEnvelopeV2Schema.parse(V2_ENVELOPE)).toEqual(V2_ENVELOPE);
  });

  it("accepts versionless v1 rows with historically optional sections", () => {
    const legacy = { snapshotDate: "2026-05-16", stablecoins: [{ id: "usdc-circle" }] };

    expect(LegacyPublicSnapshotEnvelopeV1Schema.parse(legacy)).toEqual(legacy);
    expect(PublicSnapshotEnvelopeSchema.parse(legacy)).toEqual(legacy);
  });

  it("does not let an explicit unsupported version enter the legacy path", () => {
    expect(PublicSnapshotEnvelopeSchema.safeParse({ ...V2_ENVELOPE, version: 3 }).success).toBe(false);
  });

  it.each([{ generatedAt: "now" }, { snapshotDate: "2026-02-31" }])("rejects malformed versioned field %o", (field) => {
    expect(PublicSnapshotEnvelopeSchema.safeParse({ ...V2_ENVELOPE, ...field }).success).toBe(false);
  });
});
