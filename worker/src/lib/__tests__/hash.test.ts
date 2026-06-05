import { describe, expect, it } from "vitest";
import { bytesToHex, sha256Hex } from "../hash";

describe("hash helpers", () => {
  it("encodes bytes as lowercase two-character hex pairs", () => {
    expect(bytesToHex(new Uint8Array([0, 1, 15, 16, 255]))).toBe("00010f10ff");
  });

  it("hashes string and byte inputs to the same SHA-256 hex digest", async () => {
    const expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    await expect(sha256Hex("abc")).resolves.toBe(expected);
    await expect(sha256Hex(new TextEncoder().encode("abc"))).resolves.toBe(expected);
  });
});
