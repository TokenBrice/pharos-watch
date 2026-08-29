import { describe, expect, it } from "vitest";
import { canonicalEvmAddress } from "../evm-address";

const ADDRESS = `0x${"ab".repeat(20)}`;
const ZERO_ADDRESS = `0x${"00".repeat(20)}`;

describe("canonicalEvmAddress", () => {
  it("trims and lowercases valid EVM addresses", () => {
    expect(canonicalEvmAddress(`  0x${"AB".repeat(20)}  `)).toBe(ADDRESS);
  });

  it("returns null for non-strings and malformed addresses", () => {
    expect(canonicalEvmAddress(null)).toBeNull();
    expect(canonicalEvmAddress(undefined)).toBeNull();
    expect(canonicalEvmAddress("SolanaMintAddress")).toBeNull();
    expect(canonicalEvmAddress("0x1234")).toBeNull();
    expect(canonicalEvmAddress(`0x${"ab".repeat(19)}g0`)).toBeNull();
  });

  it("admits zero by default and supports an explicit zero-address rejection", () => {
    expect(canonicalEvmAddress(ZERO_ADDRESS)).toBe(ZERO_ADDRESS);
    expect(canonicalEvmAddress(ZERO_ADDRESS, { allowZero: true })).toBe(ZERO_ADDRESS);
    expect(canonicalEvmAddress(ZERO_ADDRESS, { allowZero: false })).toBeNull();
  });
});
