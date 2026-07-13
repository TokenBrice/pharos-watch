import { describe, expect, it } from "vitest";

import { buildChainAddressKey, resolveStablecoinToken } from "../token-resolution";

describe("DEX token identity resolution", () => {
  it("preserves case-distinct Solana mint identities", () => {
    const chainAddressToId = new Map([
      ["solana:MintCase", "coin-upper"],
      ["solana:mintCase", "coin-lower"],
    ]);
    const lookups = { chainAddressToId, symbolToChainScopedIds: new Map() };

    expect(buildChainAddressKey("Solana", "MintCase")).toBe("solana:MintCase");
    expect(buildChainAddressKey("solana", "mintCase")).toBe("solana:mintCase");
    expect(resolveStablecoinToken("Solana", { address: "MintCase", symbol: "" }, lookups).stablecoinId).toBe(
      "coin-upper",
    );
    expect(resolveStablecoinToken("Solana", { address: "mintCase", symbol: "" }, lookups).stablecoinId).toBe(
      "coin-lower",
    );
  });

  it("collapses EVM checksum variants", () => {
    const chainAddressToId = new Map([["ethereum:0xabcd000000000000000000000000000000000001", "coin"]]);
    const lookups = { chainAddressToId, symbolToChainScopedIds: new Map() };

    expect(buildChainAddressKey("Ethereum", "0xAbCd000000000000000000000000000000000001")).toBe(
      "ethereum:0xabcd000000000000000000000000000000000001",
    );
    expect(
      resolveStablecoinToken("Ethereum", { address: "0xAbCd000000000000000000000000000000000001", symbol: "" }, lookups)
        .stablecoinId,
    ).toBe("coin");
  });
});
