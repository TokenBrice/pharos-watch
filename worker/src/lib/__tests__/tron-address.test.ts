import { describe, expect, it } from "vitest";
import { normalizeTronAddress, tronBase58ToHex, tronHexAddressToBase58 } from "../tron-address";

describe("tron-address", () => {
  it("encodes Tron hex addresses to base58", async () => {
    await expect(tronHexAddressToBase58("0x2004662f694f30fd269e4cccba222654b5f0538b")).resolves.toBe(
      "TCtVtrdy8sSXGMx1QYUjMrAvau1pduC2Aa",
    );
  });

  it("decodes Tron base58 addresses to normalized hex", async () => {
    await expect(tronBase58ToHex("TCtVtrdy8sSXGMx1QYUjMrAvau1pduC2Aa")).resolves.toBe(
      "0x2004662f694f30fd269e4cccba222654b5f0538b",
    );
  });

  it("normalizes 41-prefixed hex addresses", async () => {
    await expect(normalizeTronAddress("412004662f694f30fd269e4cccba222654b5f0538b")).resolves.toBe(
      "0x2004662f694f30fd269e4cccba222654b5f0538b",
    );
  });
});
