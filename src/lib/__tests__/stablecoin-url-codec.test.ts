import { describe, expect, it } from "vitest";
import {
  decodeStablecoinUrlToken,
  encodeStablecoinUrlToken,
  isAmbiguousStablecoinSymbol,
} from "../stablecoin-url-codec";

describe("stablecoin URL codec", () => {
  it("encodes canonical ids directly", () => {
    expect(encodeStablecoinUrlToken("usdc-circle")).toBe("usdc-circle");
  });

  it("decodes canonical ids, unique legacy symbols, and llama ids", () => {
    expect(decodeStablecoinUrlToken("usdc-circle")).toBe("usdc-circle");
    expect(decodeStablecoinUrlToken("usdc")).toBe("usdc-circle");
    expect(decodeStablecoinUrlToken("1")).toBe("usdt-tether");
  });

  it("rejects ambiguous legacy symbols", () => {
    expect(isAmbiguousStablecoinSymbol("usdf")).toBe(true);
    expect(decodeStablecoinUrlToken("usdf")).toBeNull();
    expect(decodeStablecoinUrlToken("cUSD")).toBeNull();
  });
});
