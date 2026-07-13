import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import { buildYieldIdentityLookups, canUseSymbolOnlyYieldMatch, resolveYieldCandidateStablecoinId } from "../identity";

/**
 * Audit Q-146: the identity disambiguation resolver decides whether an
 * auto-discovered yield pool is attributed to a tracked stablecoin. The
 * ambiguity-vs-unique boundary is the exact cross-wiring risk the lending
 * collision blocklist guards against, so it is covered here directly.
 */
function makeCoin(id: string, symbol: string, contracts: Array<{ chain: string; address: string }>): StablecoinMeta {
  return { id, symbol, contracts } as unknown as StablecoinMeta;
}

describe("resolveYieldCandidateStablecoinId", () => {
  it("prefers an exact chain-address match even when the symbol is ambiguous", () => {
    const lookups = buildYieldIdentityLookups([
      makeCoin("usdx-a", "USDX", [{ chain: "ethereum", address: "0xAAA" }]),
      makeCoin("usdx-b", "USDX", [{ chain: "arbitrum", address: "0xBBB" }]),
    ]);

    const result = resolveYieldCandidateStablecoinId({ symbol: "USDX", chain: "ethereum", address: "0xAAA" }, lookups);

    expect(result).toEqual({
      status: "matched",
      stablecoinId: "usdx-a",
      matchType: "chain-address",
    });
  });

  it("preserves mixed-case Solana mint identity before ambiguous symbol fallback", () => {
    const targetMint = "EPjFWdd5AufqSSqeM2qA5N8Y7W5a4d8nQv1F6P5a6X1";
    const lookups = buildYieldIdentityLookups([
      makeCoin("usdx-a", "USDX", [{ chain: "solana", address: targetMint }]),
      makeCoin("usdx-b", "USDX", [{ chain: "solana", address: "Es9vMFrzaCERmJfrF4H2FY6q2JvE4YJzS83p2wM8wus" }]),
    ]);

    expect(
      resolveYieldCandidateStablecoinId({ symbol: "USDX", chain: "Solana", address: targetMint }, lookups),
    ).toEqual({
      status: "matched",
      stablecoinId: "usdx-a",
      matchType: "chain-address",
    });
    expect(
      resolveYieldCandidateStablecoinId(
        { symbol: "USDX", chain: "solana", address: targetMint.toLowerCase() },
        lookups,
      ),
    ).toEqual({ status: "ambiguous" });
  });

  it("resolves a unique chain-scoped symbol when two coins share the symbol on different chains", () => {
    const lookups = buildYieldIdentityLookups([
      makeCoin("usdx-a", "USDX", [{ chain: "ethereum", address: "0xAAA" }]),
      makeCoin("usdx-b", "USDX", [{ chain: "arbitrum", address: "0xBBB" }]),
    ]);

    const result = resolveYieldCandidateStablecoinId(
      { symbol: "USDX", chain: "arbitrum", address: "0xUNKNOWN" },
      lookups,
    );

    expect(result).toEqual({
      status: "matched",
      stablecoinId: "usdx-b",
      matchType: "unique-chain-symbol",
    });
  });

  it("returns ambiguous when two coins share the symbol on the same chain", () => {
    const lookups = buildYieldIdentityLookups([
      makeCoin("usdx-a", "USDX", [{ chain: "ethereum", address: "0xAAA" }]),
      makeCoin("usdx-b", "USDX", [{ chain: "ethereum", address: "0xBBB" }]),
    ]);

    const result = resolveYieldCandidateStablecoinId(
      { symbol: "USDX", chain: "ethereum", address: "0xUNKNOWN" },
      lookups,
    );

    expect(result).toEqual({ status: "ambiguous" });
  });

  it("resolves a unique symbol globally when no chain is provided", () => {
    const lookups = buildYieldIdentityLookups([
      makeCoin("solo-usd", "SOLO", [{ chain: "ethereum", address: "0xCCC" }]),
    ]);

    const result = resolveYieldCandidateStablecoinId({ symbol: "SOLO", chain: null, address: null }, lookups);

    expect(result).toEqual({
      status: "matched",
      stablecoinId: "solo-usd",
      matchType: "unique-symbol",
    });
  });

  it("returns ambiguous when two coins share a symbol globally and no chain narrows it", () => {
    const lookups = buildYieldIdentityLookups([
      makeCoin("usdx-a", "USDX", [{ chain: "ethereum", address: "0xAAA" }]),
      makeCoin("usdx-b", "USDX", [{ chain: "arbitrum", address: "0xBBB" }]),
    ]);

    const result = resolveYieldCandidateStablecoinId({ symbol: "USDX", chain: null, address: null }, lookups);

    expect(result).toEqual({ status: "ambiguous" });
  });

  it("is unresolved when the candidate symbol is empty", () => {
    const lookups = buildYieldIdentityLookups([
      makeCoin("solo-usd", "SOLO", [{ chain: "ethereum", address: "0xCCC" }]),
    ]);

    const result = resolveYieldCandidateStablecoinId({ symbol: "", chain: "ethereum", address: "0xNOPE" }, lookups);

    expect(result).toEqual({ status: "unresolved" });
  });
});

describe("canUseSymbolOnlyYieldMatch", () => {
  it("is false when another coin shares the symbol globally", () => {
    const coinA = makeCoin("usdx-a", "USDX", [{ chain: "ethereum", address: "0xAAA" }]);
    const coinB = makeCoin("usdx-b", "USDX", [{ chain: "arbitrum", address: "0xBBB" }]);
    const lookups = buildYieldIdentityLookups([coinA, coinB]);

    expect(canUseSymbolOnlyYieldMatch(coinA, lookups, null)).toBe(false);
  });

  it("is true for a globally unique symbol with no chain", () => {
    const coin = makeCoin("solo-usd", "SOLO", [{ chain: "ethereum", address: "0xCCC" }]);
    const lookups = buildYieldIdentityLookups([coin]);

    expect(canUseSymbolOnlyYieldMatch(coin, lookups, null)).toBe(true);
  });

  it("is true when the coin is the unique holder of the symbol on the given chain", () => {
    const coinA = makeCoin("usdx-a", "USDX", [{ chain: "ethereum", address: "0xAAA" }]);
    const coinB = makeCoin("usdx-b", "USDX", [{ chain: "arbitrum", address: "0xBBB" }]);
    const lookups = buildYieldIdentityLookups([coinA, coinB]);

    expect(canUseSymbolOnlyYieldMatch(coinA, lookups, "ethereum")).toBe(true);
  });

  it("is false on a chain where another same-symbol coin also lives", () => {
    const coinA = makeCoin("usdx-a", "USDX", [{ chain: "ethereum", address: "0xAAA" }]);
    const coinB = makeCoin("usdx-b", "USDX", [{ chain: "ethereum", address: "0xBBB" }]);
    const lookups = buildYieldIdentityLookups([coinA, coinB]);

    expect(canUseSymbolOnlyYieldMatch(coinA, lookups, "ethereum")).toBe(false);
  });
});
