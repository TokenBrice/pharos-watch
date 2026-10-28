import { describe, expect, it } from "vitest";
import { buildContractDeploymentParts } from "@/lib/contract-deployment-summary";
import type { StablecoinMeta } from "@shared/types";

type ContractDeployment = NonNullable<StablecoinMeta["contracts"]>[number];

function deployment(chain: string, address: string, decimals: number | null = 18): ContractDeployment {
  return { chain, address, decimals } as ContractDeployment;
}

describe("buildContractDeploymentParts", () => {
  it("keeps the existing summary source output unchanged", () => {
    const contracts = [
      deployment("ethereum", "0x1111111111111111111111111111111111111111"),
      deployment("arbitrum", "0x2222222222222222222222222222222222222222"),
      deployment("base", "0x3333333333333333333333333333333333333333"),
      deployment("optimism", "0x4444444444444444444444444444444444444444"),
      deployment("polygon", "0x5555555555555555555555555555555555555555"),
      deployment("base", "0x6666666666666666666666666666666666666666"),
    ];

    expect(buildContractDeploymentParts(contracts)).toMatchObject({
      count: 6,
      chainNames: ["Ethereum", "Arbitrum", "Base", "Optimism"],
      remaining: 2,
      deploymentLabel: "deployments",
    });
    expect(buildContractDeploymentParts(contracts).sample).toHaveLength(4);
  });

  it("labels a single deployment singularly and treats absent contracts as empty", () => {
    const parts = buildContractDeploymentParts([deployment("ethereum", "0x1111111111111111111111111111111111111111")]);
    expect(parts).toMatchObject({ count: 1, remaining: 0, deploymentLabel: "deployment" });
    expect(buildContractDeploymentParts(undefined)).toMatchObject({ count: 0, chainNames: [], remaining: 0 });
  });
});
