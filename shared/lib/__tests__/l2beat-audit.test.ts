import { describe, expect, it } from "vitest";
import {
  getL2BeatInfrastructureContext,
} from "../chains/l2beat-audit";

describe("L2BEAT audit helpers", () => {
  it("exposes host-chain context for layer 3 deployments", () => {
    expect(getL2BeatInfrastructureContext("apechain")).toMatchObject({
      projectId: "apechain",
      layer: "layer3",
      hostChain: "Arbitrum One",
      hostChainId: "arbitrum",
    });
  });

});
