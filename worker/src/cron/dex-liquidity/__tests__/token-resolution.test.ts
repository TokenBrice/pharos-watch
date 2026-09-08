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

  const fallbackLookups = {
    chainAddressToId: new Map([["ethereum:0xabcd000000000000000000000000000000000001", "address-owner"]]),
    symbolToChainScopedIds: new Map([["USD", new Map([
      ["ethereum", ["symbol-owner"]],
      ["base", ["other-chain-owner"]],
    ])]]),
  };

  it("prefers a known address over a conflicting symbol", () => {
    expect(resolveStablecoinToken("ethereum", {
      address: "0xabcd000000000000000000000000000000000001", symbol: "USD",
    }, fallbackLookups)).toEqual({ status: "matched", stablecoinId: "address-owner", matchType: "chain-address" });
  });

  it("does not fall back from an unknown supplied address by default", () => {
    expect(resolveStablecoinToken("ethereum", { address: "0xunknown", symbol: "USD" }, fallbackLookups))
      .toEqual({ status: "unresolved" });
  });

  it("allows explicit address-present fallback only to the same chain", () => {
    expect(resolveStablecoinToken("Ethereum", { address: "0xunknown", symbol: "USD" }, fallbackLookups, {
      allowSymbolFallbackWhenAddressPresent: true,
    })).toEqual({ status: "matched", stablecoinId: "symbol-owner", matchType: "unique-chain-symbol" });
  });

  it("keeps disabled symbol fallback unresolved", () => {
    expect(resolveStablecoinToken("ethereum", { address: "", symbol: "USD" }, fallbackLookups, {
      allowSymbolFallback: false,
    })).toEqual({ status: "unresolved" });
  });

  it("rejects ambiguous same-chain symbols without borrowing another chain's unique match", () => {
    expect(resolveStablecoinToken("ethereum", { address: "", symbol: "USD" }, {
      ...fallbackLookups,
      symbolToChainScopedIds: new Map([["USD", new Map([
        ["ethereum", ["first", "second"]], ["base", ["other-chain-owner"]],
      ])]]),
    })).toEqual({ status: "ambiguous" });
  });
});
