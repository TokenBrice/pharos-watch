import { describe, expect, it } from "vitest";
import { buildChainRpcs } from "../chain-registry";

describe("buildChainRpcs", () => {
  it("includes public-only Tempo RPC resolution", () => {
    const tempo = buildChainRpcs().get("tempo");

    expect(tempo).toMatchObject({
      chainId: "tempo",
      chainName: "Tempo",
      type: "evm",
      rpcUrl: "https://rpc.tempo.xyz",
      explorerUrl: "https://explorer.tempo.xyz",
    });
    expect(tempo?.alchemyPrimary).toBeUndefined();
  });
});
