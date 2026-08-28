import { describe, expect, it } from "vitest";
import {
  encodeAddress,
  encodeAddressCallData,
  encodeBalanceOfCallData,
  encodeUint256,
  normalizeEvmAddress,
} from "../evm-selectors";

describe("evm selector ABI encoders", () => {
  it("encodes a 20-byte address as a left-padded ABI word", () => {
    expect(encodeAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")).toBe(
      "000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    );
  });

  it("rejects non-20-byte or non-hex addresses", () => {
    expect(() => encodeAddress("0x1111")).toThrow(/expected 20-byte hex address/);
    expect(() => encodeAddress("0xzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz")).toThrow(
      /expected 20-byte hex address/,
    );
  });

  it("encodes uint256 words and rejects invalid values", () => {
    expect(encodeUint256(42n)).toBe("000000000000000000000000000000000000000000000000000000000000002a");
    expect(encodeUint256(0)).toBe("0000000000000000000000000000000000000000000000000000000000000000");
    expect(() => encodeUint256(-1n)).toThrow(/value out of range/);
    expect(() => encodeUint256(Number.MAX_SAFE_INTEGER + 1)).toThrow(/non-negative safe integer/);
    expect(() => encodeUint256(1n << 256n)).toThrow(/value out of range/);
  });

  it("builds balanceOf calldata through the canonical address encoder", () => {
    expect(encodeBalanceOfCallData("0xf89615f75c8161dc185c03020240905f6b66bad9")).toBe(
      "0x70a08231000000000000000000000000f89615f75c8161dc185c03020240905f6b66bad9",
    );
    expect(() => encodeBalanceOfCallData("0x1234")).toThrow(/expected 20-byte hex address/);
  });

  it("pins single- and multi-address calldata byte for byte", () => {
    const first = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
    const second = "0xf89615f75c8161dc185c03020240905f6b66bad9";
    expect(encodeAddressCallData("0x70a08231", first)).toBe(
      "0x70a08231000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    );
    expect(encodeAddressCallData("0xdd62ed3e", first, second)).toBe(
      `0xdd62ed3e${encodeAddress(first)}${encodeAddress(second)}`,
    );
  });

  it("rejects malformed selectors and owns non-throwing address normalization", () => {
    expect(() => encodeAddressCallData("0x1234", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"))
      .toThrow(/expected 4-byte hex selector/);
    expect(normalizeEvmAddress(" 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 ")).toBe(
      "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    );
    expect(normalizeEvmAddress("0x1234")).toBeNull();
  });
});
