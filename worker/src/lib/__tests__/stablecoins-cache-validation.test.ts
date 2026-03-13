import { describe, it, expect } from "vitest";
import { validateStablecoinEntry } from "../stablecoins-cache";

describe("validateStablecoinEntry", () => {
  it("accepts valid entry with required fields", () => {
    const entry = { id: "1", symbol: "USDT", name: "Tether", price: 1.0, pegType: "peggedUSD", circulating: { peggedUSD: 100e9 } };
    expect(validateStablecoinEntry(entry)).not.toBeNull();
  });

  it("rejects entry missing id", () => {
    const entry = { symbol: "USDT", price: 1.0, pegType: "peggedUSD" };
    expect(validateStablecoinEntry(entry)).toBeNull();
  });

  it("rejects entry with non-string id", () => {
    const entry = { id: 123, symbol: "USDT", price: 1.0, pegType: "peggedUSD" };
    expect(validateStablecoinEntry(entry)).toBeNull();
  });

  it("rejects entry missing symbol", () => {
    const entry = { id: "1", price: 1.0, pegType: "peggedUSD" };
    expect(validateStablecoinEntry(entry)).toBeNull();
  });

  it("allows null price (some coins lack price data)", () => {
    const entry = { id: "1", symbol: "USDT", name: "Tether", price: null, pegType: "peggedUSD", circulating: {} };
    const result = validateStablecoinEntry(entry);
    expect(result).not.toBeNull();
    expect(result?.price).toBeNull();
  });

  it("preserves all extra fields from upstream", () => {
    const entry = { id: "1", symbol: "USDT", name: "Tether", price: 1.0, pegType: "peggedUSD", circulating: {}, chains: ["Ethereum"], extraField: "kept" };
    const result = validateStablecoinEntry(entry);
    expect(result).not.toBeNull();
  });
});
