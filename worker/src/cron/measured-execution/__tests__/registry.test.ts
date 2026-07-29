import { describe, expect, it } from "vitest";

import {
  DEX_MEASURED_EXECUTION_SCORE_ELIGIBLE_DEPLOYMENT_KEYS,
  getDexMeasuredExecutionDeployment,
  isDexMeasuredExecutionDeploymentScoreEligible,
} from "../registry";

describe("measured execution deployment registry", () => {
  it("activates exactly the owner-ratified QuoterV2 cohorts", () => {
    expect([...DEX_MEASURED_EXECUTION_SCORE_ELIGIBLE_DEPLOYMENT_KEYS].sort()).toEqual([
      "aerodrome-slipstream-quoter-v2:base",
      "pancakeswap-v3-quoter-v2:base",
      "pancakeswap-v3-quoter-v2:bsc",
      "pancakeswap-v3-quoter-v2:ethereum",
      "uniswap-v3-quoter-v2:arbitrum",
      "uniswap-v3-quoter-v2:ethereum",
      "uniswap-v3-quoter-v2:polygon",
    ]);
    expect(isDexMeasuredExecutionDeploymentScoreEligible("uniswap-v3-quoter-v2", "ethereum")).toBe(true);
    expect(isDexMeasuredExecutionDeploymentScoreEligible("uniswap-v3-quoter-v2", "Ethereum")).toBe(true);
    expect(isDexMeasuredExecutionDeploymentScoreEligible("uniswap-v3-quoter-v2", "optimism")).toBe(false);
    expect(isDexMeasuredExecutionDeploymentScoreEligible("pancakeswap-v3-quoter-v2", "bsc")).toBe(true);
    expect(isDexMeasuredExecutionDeploymentScoreEligible("aerodrome-slipstream-quoter-v2", "base")).toBe(true);
  });

  it("keeps unratified deployments shadow-only fail-closed", () => {
    expect(isDexMeasuredExecutionDeploymentScoreEligible("uniswap-v3-quoter-v2", "linea")).toBe(false);
    expect(isDexMeasuredExecutionDeploymentScoreEligible("raydium", "solana")).toBe(false);
    expect(isDexMeasuredExecutionDeploymentScoreEligible("", "")).toBe(false);
  });

  it("keeps the retired Optimism Uniswap QuoterV2 lane unscheduled", () => {
    expect(getDexMeasuredExecutionDeployment("uniswap-v3-quoter-v2", "Optimism")).toBeNull();
  });

  it("pins the active Base Aerodrome Slipstream factory and QuoterV2", () => {
    expect(getDexMeasuredExecutionDeployment("aerodrome-slipstream-quoter-v2", "Base")).toEqual({
      adapterProfileId: "aerodrome-slipstream-quoter-v2",
      protocol: "aerodrome-slipstream",
      chain: "base",
      endpointAddress: "0x254cf9e1e6e233aa1ac962cb9b05b2cfeaae15b0",
      expectedCodeHash: "0xfb0ab713266d089d5b6ac48d50455c4fadc9cd49a1efcc83a091e7c2e48dad0e",
      factoryAddress: "0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a",
      expectedFactoryCodeHash: "0x7340cf80843bd721bcaefbfc050e38304cb4174c239e6e914e3056f27f39b11c",
    });
  });
});
