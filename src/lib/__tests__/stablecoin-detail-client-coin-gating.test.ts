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

  it("shows custody but hides oracle for a fiat-cash archetype with no explicit custodyModel", () => {
    const clientCoin = buildStablecoinDetailClientCoin(coinWith({ mechanismArchetype: "fiat-cash" }));
    expect(clientCoin.custodyProfileSummary).toBeDefined();
    expect("oracleRiskSummary" in clientCoin).toBe(false);
  });

  it("shows custody for a cdp archetype when an explicit centralized custodyModel is set", () => {
    const clientCoin = buildStablecoinDetailClientCoin(
      coinWith({ mechanismArchetype: "cdp", custodyModel: "institutional-regulated" }),
    );
    expect(clientCoin.custodyProfileSummary).toBeDefined();
  });
});
