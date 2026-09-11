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

  it("rejects invalid Base58 alphabets and altered checksums", async () => {
    await expect(tronBase58ToHex("TCtVtrdy8sSXGMx1QYUjMrAvau1pduC2A0")).resolves.toBeNull();
    await expect(tronBase58ToHex("TCtVtrdy8sSXGMx1QYUjMrAvau1pduC2Ab")).resolves.toBeNull();
  });

  it("rejects valid-checksum payloads with the wrong network or length", async () => {
    // Independently Base58Check-encoded: 0x42 + 20 bytes, and 0x41 + 19 bytes.
    await expect(tronBase58ToHex("TcE6sxwFr3uQ5o66Rxp3qySiDQGmGF16bz")).resolves.toBeNull();
    await expect(tronBase58ToHex("6wMH4bMcNinf8777tZ47RfL1p6ttPeGYP")).resolves.toBeNull();
  });

  it("normalizes whitespace and hex case without changing the address", async () => {
    await expect(normalizeTronAddress("  0X2004662F694F30FD269E4CCCBA222654B5F0538B  "))
      .resolves.toBe("0x2004662f694f30fd269e4cccba222654b5f0538b");
    await expect(normalizeTronAddress(" TCtVtrdy8sSXGMx1QYUjMrAvau1pduC2Aa "))
      .resolves.toBe("0x2004662f694f30fd269e4cccba222654b5f0538b");
  });

  it("rejects invalid hex lengths", async () => {
    for (const address of ["0x" + "a".repeat(39), "41" + "a".repeat(41)]) {
      await expect(tronHexAddressToBase58(address)).resolves.toBeNull();
      await expect(normalizeTronAddress(address)).resolves.toBeNull();
    }
  });

  it("rejects correctly sized non-hex addresses before normalization or encoding", async () => {
    for (const prefix of ["0x", "41"]) {
      const address = prefix + "g".repeat(40);
      await expect(normalizeTronAddress(address)).resolves.toBeNull();
      await expect(tronHexAddressToBase58(address)).resolves.toBeNull();
    }
  });
});
