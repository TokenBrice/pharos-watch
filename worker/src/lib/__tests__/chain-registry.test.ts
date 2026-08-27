import { describe, expect, it } from "vitest";
import { buildChainRpcs, getAlchemyAuthHeaders } from "../chain-registry";

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

  it("keeps Alchemy API keys out of RPC URLs", () => {
    const ethereum = buildChainRpcs("test-key").get("ethereum");

    expect(ethereum?.rpcUrl).toBe("https://eth-mainnet.g.alchemy.com/v2/");
  });

  it("prepends keyed Solana RPCs in Alchemy then dRPC order", () => {
    const solana = buildChainRpcs("alchemy-key", "drpc-key").get("solana");

    expect(solana).toMatchObject({
      chainId: "solana",
      chainName: "Solana",
      type: "other",
      rpcUrl: "https://solana-mainnet.g.alchemy.com/v2/",
      fallbackRpcUrl: "https://lb.drpc.org/ogrpc?network=solana&dkey=drpc-key",
      explorerUrl: "https://solscan.io",
    });
  });

  it("keeps the Alchemy key out of the Solana RPC URL and serves it as an auth header", () => {
    const solana = buildChainRpcs("alchemy-key", "drpc-key").get("solana");

    expect(solana?.rpcUrl).not.toContain("alchemy-key");
    expect(getAlchemyAuthHeaders(solana!.rpcUrl)).toEqual({ Authorization: "Bearer alchemy-key" });
  });
});
