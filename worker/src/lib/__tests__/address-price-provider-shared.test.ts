import { describe, expect, it } from "vitest";
import {
  narrowMetadata,
  normalizeAddressForKey,
  parseObservedAt,
} from "../address-price-providers/shared";

describe("address-price provider shared contracts", () => {
  it("normalizes EVM identity without changing case-sensitive addresses", () => {
    expect(normalizeAddressForKey("  0xABCDEF  ")).toBe("0xabcdef");
    expect(normalizeAddressForKey("  SoLaNaAddress  ")).toBe("SoLaNaAddress");
  });

  it("normalizes timestamps and omits null provenance metadata", () => {
    expect(parseObservedAt("1800000000000")).toBe(1_800_000_000);
    expect(narrowMetadata({ source: "pool", liquidityUsd: 75_000, volumeUsd: null })).toEqual({
      source: "pool",
      liquidityUsd: 75_000,
    });
  });
});
