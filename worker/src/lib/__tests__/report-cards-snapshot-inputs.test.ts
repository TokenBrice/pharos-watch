import { describe, expect, it } from "vitest";
import { computeDexDeploymentSupplyCoverage } from "../report-cards-snapshot-inputs";

function supplyPoint(current: number) {
  return {
    current,
    circulatingPrevDay: current,
    circulatingPrevWeek: current,
    circulatingPrevMonth: current,
  };
}

describe("report-card DEX deployment supply join", () => {
  it("weights exact deployment outcomes by current chain supply", () => {
    const coverage = computeDexDeploymentSupplyCoverage(
      {
        chainCirculating: {
          Ethereum: supplyPoint(80_000_000),
          Base: supplyPoint(20_000_000),
        },
        contracts: [
          { chain: "ethereum", address: "0x111", decimals: 18 },
          { chain: "base", address: "0x222", decimals: 18 },
        ],
      },
      [
        { chain: "Ethereum", contractAddress: "0x111", outcome: "observed_pools" },
        { chain: "Base", contractAddress: "0x222", outcome: "provider_inaccessible" },
      ],
      new Map([
        ["ethereum", 5_000_000],
        ["base", 0],
      ]),
    );

    expect(coverage).toMatchObject({
      totalSupplyUsd: 100_000_000,
      observedSupplyUsd: 80_000_000,
      providerInaccessibleSupplyUsd: 20_000_000,
      observedSupplyRatio: 0.8,
      providerInaccessibleSupplyRatio: 0.2,
      unknownSupplyUsd: 0,
    });
  });

  it("keeps same-chain multi-contract supply unknown", () => {
    const coverage = computeDexDeploymentSupplyCoverage(
      {
        chainCirculating: { Ethereum: supplyPoint(10_000_000) },
        contracts: [
          { chain: "ethereum", address: "0x111", decimals: 18 },
          { chain: "ethereum", address: "0x222", decimals: 18 },
        ],
      },
      [
        { chain: "ethereum", contractAddress: "0x111", outcome: "observed_pools" },
        { chain: "ethereum", contractAddress: "0x222", outcome: "verified_no_pools" },
      ],
      new Map([["ethereum", 1_000_000]]),
    );

    expect(coverage).toMatchObject({
      unknownSupplyUsd: 10_000_000,
      unknownSupplyRatio: 1,
      unknownChains: ["ethereum"],
    });
  });

  it("treats contradictory observed-pool and chain-TVL evidence as unknown", () => {
    const coverage = computeDexDeploymentSupplyCoverage(
      {
        chainCirculating: { Ethereum: supplyPoint(10_000_000) },
        contracts: [{ chain: "ethereum", address: "0x111", decimals: 18 }],
      },
      [{ chain: "ethereum", contractAddress: "0x111", outcome: "observed_pools" }],
      new Map([["ethereum", 0]]),
    );

    expect(coverage).toMatchObject({
      observedSupplyUsd: 0,
      unknownSupplyUsd: 10_000_000,
      unknownChains: ["ethereum"],
    });
  });

  it("keeps stale deployment outcomes unknown at a fixed scoring clock", () => {
    const coverage = computeDexDeploymentSupplyCoverage(
      {
        chainCirculating: { Ethereum: supplyPoint(10_000_000) },
        contracts: [{ chain: "ethereum", address: "0x111", decimals: 18 }],
      },
      [
        {
          chain: "ethereum",
          contractAddress: "0x111",
          outcome: "observed_pools",
          observedAt: 1_000,
        },
      ],
      new Map([["ethereum", 1_000_000]]),
      { asOfSec: 10_000, maxOutcomeAgeSec: 1_000 },
    );

    expect(coverage).toMatchObject({
      observedSupplyUsd: 0,
      unknownSupplyUsd: 10_000_000,
      unknownChains: ["ethereum"],
    });
  });

  it("keeps future-dated deployment outcomes unknown at a fixed scoring clock", () => {
    const coverage = computeDexDeploymentSupplyCoverage(
      {
        chainCirculating: { Ethereum: supplyPoint(10_000_000) },
        contracts: [{ chain: "ethereum", address: "0x111", decimals: 18 }],
      },
      [
        {
          chain: "ethereum",
          contractAddress: "0x111",
          outcome: "observed_pools",
          observedAt: 10_001,
        },
      ],
      new Map([["ethereum", 1_000_000]]),
      { asOfSec: 10_000, maxOutcomeAgeSec: 1_000 },
    );

    expect(coverage).toMatchObject({
      observedSupplyUsd: 0,
      unknownSupplyUsd: 10_000_000,
      unknownChains: ["ethereum"],
    });
  });

  it("supersedes an older lowercase non-EVM deployment outcome after identity correction", () => {
    const solanaMint = "EPjFWdd5AufqSSqeM2qA5N8Y7W5a4d8nQv1F6P5a6X1";
    const coverage = computeDexDeploymentSupplyCoverage(
      {
        chainCirculating: { Solana: supplyPoint(10_000_000) },
        contracts: [{ chain: "solana", address: solanaMint, decimals: 6 }],
      },
      [
        {
          chain: "solana",
          contractAddress: solanaMint.toLowerCase(),
          outcome: "verified_no_pools",
          observedAt: 1_000,
        },
        {
          chain: "Solana",
          contractAddress: solanaMint,
          outcome: "observed_pools",
          observedAt: 2_000,
        },
      ],
      new Map([["solana", 1_000_000]]),
      { asOfSec: 2_100, maxOutcomeAgeSec: 10_000 },
    );

    expect(coverage).toMatchObject({
      observedSupplyUsd: 10_000_000,
      unknownSupplyUsd: 0,
      unknownChains: [],
    });
  });

  it("distinguishes verified empty supply from provider-inaccessible supply", () => {
    const coverage = computeDexDeploymentSupplyCoverage(
      {
        chainCirculating: {
          Ethereum: supplyPoint(60),
          Base: supplyPoint(40),
        },
        contracts: [
          { chain: "ethereum", address: "0x111", decimals: 18 },
          { chain: "base", address: "0x222", decimals: 18 },
        ],
      },
      [
        { chain: "ethereum", contractAddress: "0x111", outcome: "verified_no_pools" },
        { chain: "base", contractAddress: "0x222", outcome: "provider_inaccessible" },
      ],
      new Map(),
    );

    expect(coverage).toMatchObject({
      verifiedNoPoolsSupplyRatio: 0.6,
      providerInaccessibleSupplyRatio: 0.4,
      observedSupplyRatio: 0,
      unknownSupplyRatio: 0,
    });
  });

  it("clamps floating-point ratio noise at the serialized contract boundary", () => {
    const coverage = computeDexDeploymentSupplyCoverage(
      {
        chainCirculating: {
          Ethereum: supplyPoint(0.1),
          Base: supplyPoint(0.2),
        },
        contracts: [
          { chain: "ethereum", address: "0x111", decimals: 18 },
          { chain: "base", address: "0x222", decimals: 18 },
        ],
      },
      [],
      new Map(),
    );

    expect(coverage?.unknownSupplyRatio).toBe(1);
  });
});
