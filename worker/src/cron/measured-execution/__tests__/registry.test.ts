import { describe, expect, it } from "vitest";

import {
  getDexMeasuredExecutionDeployment,
  isDexMeasuredExecutionDeploymentScoreEligible,
} from "../registry";

describe("measured execution deployment registry", () => {
  it("activates the owner-ratified QuoterV2 cohorts", () => {
    expect(isDexMeasuredExecutionDeploymentScoreEligible("uniswap-v3-quoter-v2", "ethereum")).toBe(true);
    expect(isDexMeasuredExecutionDeploymentScoreEligible("uniswap-v3-quoter-v2", "Ethereum")).toBe(true);
    expect(isDexMeasuredExecutionDeploymentScoreEligible("uniswap-v3-quoter-v2", "CeLo")).toBe(true);
    expect(isDexMeasuredExecutionDeploymentScoreEligible("uniswap-v3-quoter-v2", "optimism")).toBe(false);
    expect(isDexMeasuredExecutionDeploymentScoreEligible("pancakeswap-v3-quoter-v2", "bsc")).toBe(true);
    expect(isDexMeasuredExecutionDeploymentScoreEligible("aerodrome-slipstream-quoter-v2", "base")).toBe(true);
  });

  it("keeps unratified deployments shadow-only fail-closed", () => {
    expect(isDexMeasuredExecutionDeploymentScoreEligible("uniswap-v3-quoter-v2", "linea")).toBe(false);
    expect(isDexMeasuredExecutionDeploymentScoreEligible("uniswap-v3-quoter-v2", "bsc")).toBe(false);
    expect(isDexMeasuredExecutionDeploymentScoreEligible("uniswap-v3-quoter-v2", "base")).toBe(false);
    expect(isDexMeasuredExecutionDeploymentScoreEligible("raydium", "solana")).toBe(false);
    expect(isDexMeasuredExecutionDeploymentScoreEligible("", "")).toBe(false);
  });

  it("keeps the retired Optimism Uniswap QuoterV2 lane unscheduled", () => {
    expect(getDexMeasuredExecutionDeployment("uniswap-v3-quoter-v2", "Optimism")).toBeNull();
  });

  it("pins the reviewed Monad Uniswap deployment without granting score eligibility", () => {
    expect(getDexMeasuredExecutionDeployment("uniswap-v3-quoter-v2", "MoNaD")).toEqual({
      adapterProfileId: "uniswap-v3-quoter-v2",
      protocol: "uniswap-v3",
      chain: "monad",
      endpointAddress: "0x661e93cca42afacb172121ef892830ca3b70f08d",
      expectedCodeHash: "0xad90650112df6d1329f20af88a7ad67de8249cae2092e2660ced24e647a9a5be",
      factoryAddress: "0x204faca1764b154221e35c0d20abb3c525710498",
      expectedFactoryCodeHash: "0x343475d01b14fa838452aebbc1b600ef871a46233c97effb3260bb9a2597d519",
    });
    expect(isDexMeasuredExecutionDeploymentScoreEligible("uniswap-v3-quoter-v2", "monad")).toBe(false);
  });

  it("pins the reviewed Monad Pancake deployment without granting score eligibility", () => {
    expect(getDexMeasuredExecutionDeployment("pancakeswap-v3-quoter-v2", "MoNaD")).toEqual({
      adapterProfileId: "pancakeswap-v3-quoter-v2",
      protocol: "pancakeswap",
      chain: "monad",
      endpointAddress: "0xb048bbc1ee6b733fffcfb9e9cef7375518e25997",
      expectedCodeHash: "0x66711e04817b6da9499b9320b3c61c2d492ca4d78c58a798a7b453ba65feb5a6",
      factoryAddress: "0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865",
      expectedFactoryCodeHash: "0xf6105f5817b3f67dd0f060fa27c1e23a14d9fca13c6ebd695545ca4d5c0fbe06",
    });
    expect(isDexMeasuredExecutionDeploymentScoreEligible("pancakeswap-v3-quoter-v2", "monad")).toBe(false);
  });
});
