import { describe, expect, it } from "vitest";
import {
  decodeStablecoinUrlToken,
  encodeStablecoinUrlToken,
} from "../stablecoin-url-codec";

describe("stablecoin URL codec", () => {
  it("encodes canonical ids directly", () => {
    expect(encodeStablecoinUrlToken("usdc-circle")).toBe("usdc-circle");
  });

  it("decodes canonical ids only", () => {
    expect(decodeStablecoinUrlToken("usdc-circle")).toBe("usdc-circle");
  });

  it("rejects non-canonical tokens", () => {
    expect(decodeStablecoinUrlToken("usdc")).toBeNull();
    expect(decodeStablecoinUrlToken("1")).toBeNull();
    expect(decodeStablecoinUrlToken("usdf")).toBeNull();
    expect(decodeStablecoinUrlToken("cUSD")).toBeNull();
  });
});
