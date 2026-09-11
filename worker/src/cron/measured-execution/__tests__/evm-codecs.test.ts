import { describe, expect, it } from "vitest";
import {
  canonicalEvmAddress,
  canonicalEvmHash,
  decodeAddressResult,
} from "../evm-codecs";

describe("measured-execution EVM codecs", () => {
  it.each([
    ["checksum address", "0xAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCd", "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"],
    ["uppercase hash", `0x${"AB".repeat(32)}`, `0x${"ab".repeat(32)}`],
  ])("canonicalizes %s", (_label, value, expected) => {
    expect(value.length === 42 ? canonicalEvmAddress(value) : canonicalEvmHash(value)).toBe(expected);
  });

  it.each([
    ["short address", "0x1234", canonicalEvmAddress],
    ["long address", `0x${"11".repeat(21)}`, canonicalEvmAddress],
    ["nonhex address", `0x${"gg".repeat(20)}`, canonicalEvmAddress],
    ["malformed hash", "0xnot-a-hash", canonicalEvmHash],
  ] as const)("rejects %s", (_label, value, validate) => {
    expect(validate(value)).toBeNull();
  });

  it("accepts the zero address and safely rejects malformed ABI results", () => {
    expect(canonicalEvmAddress(`  0x${"00".repeat(20)}  `)).toBe(`0x${"00".repeat(20)}`);
    expect(decodeAddressResult({ decode: () => `0x${"12".repeat(19)}` })).toBeNull();
    expect(decodeAddressResult({ decode: () => { throw new Error("malformed ABI return"); } })).toBeNull();
  });
});
