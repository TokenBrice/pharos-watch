import { describe, expect, it } from "vitest";

import {
  DEX_MEASURED_EXECUTION_SCORE_ELIGIBLE_DEPLOYMENT_KEYS,
  getDexMeasuredExecutionDeployment,
  isDexMeasuredExecutionDeploymentScoreEligible,
} from "../registry";

describe("measured execution deployment registry", () => {
  it("keeps QuoterV2 deployments shadow-only until RPC evidence is authenticated", () => {
    expect(DEX_MEASURED_EXECUTION_SCORE_ELIGIBLE_DEPLOYMENT_KEYS).toEqual([]);
    expect(isDexMeasuredExecutionDeploymentScoreEligible("uniswap-v3-quoter-v2", "ethereum")).toBe(false);
    expect(isDexMeasuredExecutionDeploymentScoreEligible("uniswap-v3-quoter-v2", "Ethereum")).toBe(false);
    expect(isDexMeasuredExecutionDeploymentScoreEligible("pancakeswap-v3-quoter-v2", "bsc")).toBe(false);
  });

  it("keeps unratified deployments shadow-only fail-closed", () => {
    expect(isDexMeasuredExecutionDeploymentScoreEligible("uniswap-v3-quoter-v2", "optimism")).toBe(false);
    expect(isDexMeasuredExecutionDeploymentScoreEligible("raydium", "solana")).toBe(false);
    expect(isDexMeasuredExecutionDeploymentScoreEligible("", "")).toBe(false);
  });

  it("pins the reviewed Optimism Uniswap QuoterV2 runtime", () => {
    expect(getDexMeasuredExecutionDeployment("uniswap-v3-quoter-v2", "Optimism")).toEqual({
      adapterProfileId: "uniswap-v3-quoter-v2",
      protocol: "uniswap-v3",
      chain: "optimism",
      endpointAddress: "0x61ffe014ba17989e743c5f6cb21bf9697530b21e",
      expectedCodeHash: "0xd833dcf44a912014423afa2b637f23b5db5b7dc492494cbe3f46026a6d57b424",
      factoryAddress: "0x1f98431c8ad98523631ae4a59f267346ea31f984",
      expectedFactoryCodeHash: "0x4d7b8525cd5d14343fa67a732fba5b24cddba11620ca88392f4ec6c52f91fd69",
    });
  });
});
