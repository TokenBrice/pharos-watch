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
      "uniswap-v3-quoter-v2:celo",
      "uniswap-v3-quoter-v2:ethereum",
      "uniswap-v3-quoter-v2:polygon",
    ]);
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

  it("pins the active Celo Uniswap V3 factory and QuoterV2 case-insensitively", () => {
    expect(getDexMeasuredExecutionDeployment("UnIsWaP-V3-QuOtEr-V2", "CeLo")).toEqual({
      adapterProfileId: "uniswap-v3-quoter-v2",
      protocol: "uniswap-v3",
      chain: "celo",
      endpointAddress: "0x82825d0554fa07f7fc52ab63c961f330fdefa8e8",
      expectedCodeHash: "0x557b5bc80c7000c05bac66693aff2264927a0a22ea1f80d590449b52d515aa34",
      factoryAddress: "0xafe208a311b21f13ef87e33a90049fc17a7acdec",
      expectedFactoryCodeHash: "0x5960f2f785dd273f0eeb9624f32a9f93bd1560dc1335171d22411d48296d79b3",
    });
  });

  it("pins BSC Uniswap V3 while keeping the deployment shadow-only", () => {
    expect(getDexMeasuredExecutionDeployment("uniswap-v3-quoter-v2", "BSC")).toEqual({
      adapterProfileId: "uniswap-v3-quoter-v2",
      protocol: "uniswap-v3",
      chain: "bsc",
      endpointAddress: "0x78d78e420da98ad378d7799be8f4af69033eb077",
      expectedCodeHash: "0xb6652d71ca265e7b2b5f066661fec38c8c22eb9a9c17b8a5c0fae62ec401bc55",
      factoryAddress: "0xdb1d10011ad0ff90774d0c6bb92e5c5c8b4461f7",
      expectedFactoryCodeHash: "0x34b1009d0f004e58da791225992645e2df7697ac71ac89dc5e80469c4ef7e322",
    });
    expect(isDexMeasuredExecutionDeploymentScoreEligible("uniswap-v3-quoter-v2", "bsc")).toBe(false);
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
