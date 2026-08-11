// src/lib/__tests__/stablecoin-detail-client-coin-gating.test.ts
import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types";
import { buildStablecoinDetailClientCoin } from "../stablecoin-detail-mint-authority-view-model";

const CUSTODY_PROFILE = {
  providers: [{ name: "Example Custodian", role: "custodian", sharePct: 100 }],
  segregation: "segregated",
  bankruptcyRemoteness: "contractual-only",
  rehypothecation: "prohibited",
  reviewedAt: "2026-07-17",
  reviewer: "Kimi FIAT-CTRL shard-11",
  confidence: "verified",
  sources: [],
  uncertainty: "",
};

const ORACLE_RISK = {
  tier: "redundant-with-failover",
  summary: "External feeds with response validation.",
};

const RESERVES_WITH_QUALITY = [
  { name: "U.S. Treasury bills", pct: 80, risk: "very-low", assetClass: "treasury-bill", liquidityHorizon: "one-day" },
  { name: "Bank deposits", pct: 20, risk: "low", assetClass: "bank-deposit", liquidityHorizon: "immediate" },
];

const RESERVE_REVIEW = {
  reviewedAt: "2026-07-18",
  reviewer: "Kimi RESERVE shard-3",
  confidence: "verified",
  sources: [],
  rationale: "Server-only rationale.",
  compositionBasis: "Monthly attestation composition table.",
  scope: "full-composition",
  knownUnknownExposure: "No undisclosed obligors.",
  knownUnknownExposurePct: 0,
};

function coinWith(overrides: Record<string, unknown>): StablecoinMeta {
  return {
    id: "test-coin",
    flags: {
      backing: "crypto-backed",
      governance: "decentralized",
      pegCurrency: "USD",
      rwa: false,
      navToken: false,
      yieldBearing: false,
    },
    custodyProfile: CUSTODY_PROFILE,
    oracleRisk: ORACLE_RISK,
    ...overrides,
  } as unknown as StablecoinMeta;
}

describe("buildStablecoinDetailClientCoin display gating", () => {
  it("shows oracle but hides custody for a cdp archetype with no explicit custodyModel", () => {
    const clientCoin = buildStablecoinDetailClientCoin(coinWith({ mechanismArchetype: "cdp" }));
    expect(clientCoin.oracleRiskSummary).toBeDefined();
    expect("custodyProfileSummary" in clientCoin).toBe(false);
  });

  it("shows custody and available oracle data for a fiat-cash archetype with no explicit custodyModel", () => {
    const clientCoin = buildStablecoinDetailClientCoin(coinWith({ mechanismArchetype: "fiat-cash" }));
    expect(clientCoin.custodyProfileSummary).toBeDefined();
    expect(clientCoin.oracleRiskSummary).toBeDefined();
  });

  it("shows custody for a cdp archetype when an explicit centralized custodyModel is set", () => {
    const clientCoin = buildStablecoinDetailClientCoin(
      coinWith({ mechanismArchetype: "cdp", custodyModel: "institutional-regulated" }),
    );
    expect(clientCoin.custodyProfileSummary).toBeDefined();
  });

  it("attaches the reserve quality summary while stripping the server-only reserve review", () => {
    const clientCoin = buildStablecoinDetailClientCoin(
      coinWith({ reserves: RESERVES_WITH_QUALITY, reserveReview: RESERVE_REVIEW }),
    );
    expect(clientCoin.reserveQualitySummary).toBeDefined();
    expect(clientCoin.reserveQualitySummary!.chipLabel).toBe("Highly liquid");
    expect("reserveReview" in clientCoin).toBe(false);
  });

  it("hides reserve quality for reserve slices with no quality attributes", () => {
    const clientCoin = buildStablecoinDetailClientCoin(
      coinWith({ reserves: [{ name: "Cash", pct: 100, risk: "very-low" }], reserveReview: RESERVE_REVIEW }),
    );
    expect("reserveQualitySummary" in clientCoin).toBe(false);
    expect("reserveReview" in clientCoin).toBe(false);
  });
});
