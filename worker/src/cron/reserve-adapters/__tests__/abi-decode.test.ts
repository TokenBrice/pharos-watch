import { describe, expect, it } from "vitest";
import {
  decodeAbiWordAt,
  decodeStrictAddressArrayWord,
  decodeStrictAddressWord,
} from "../abi-decode";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const STRATEGY_A = "0x1111111111111111111111111111111111111111";
const STRATEGY_B = "0x2222222222222222222222222222222222222222";

function word(hex: string): string {
  return hex.padStart(64, "0");
}

function addressWord(address: string): string {
  return word(address.slice(2));
}

function payload(...words: string[]): string {
  return `0x${words.join("")}`;
}

function addressArrayPayload(...addresses: string[]): string {
  return payload(
    word("20"),
    word(addresses.length.toString(16)),
    ...addresses.map(addressWord),
  );
}

describe("decodeAbiWordAt", () => {
  it("reads words by index from a whole-word payload", () => {
    const raw = payload(word("01"), word("ff"));
    expect(decodeAbiWordAt(raw, 0)).toBe(`0x${word("01")}`);
    expect(decodeAbiWordAt(raw, 1)).toBe(`0x${word("ff")}`);
  });

  it("rejects payloads that are not a non-empty multiple of 32 bytes", () => {
    expect(decodeAbiWordAt("0x", 0)).toBeNull();
    expect(decodeAbiWordAt(`0x${"00".repeat(31)}`, 0)).toBeNull();
    expect(decodeAbiWordAt(`0x${word("01")}00`, 0)).toBeNull();
  });

  it("rejects non-hex payloads, missing prefixes, negative and out-of-range indexes", () => {
    expect(decodeAbiWordAt(`0x${"z".repeat(64)}`, 0)).toBeNull();
    expect(decodeAbiWordAt(word("01"), 0)).toBeNull();
    expect(decodeAbiWordAt(null, 0)).toBeNull();
    expect(decodeAbiWordAt(payload(word("01")), -1)).toBeNull();
    expect(decodeAbiWordAt(payload(word("01")), 1)).toBeNull();
  });
});

describe("decodeStrictAddressWord", () => {
  it("decodes the zero address instead of rejecting it", () => {
    expect(decodeStrictAddressWord(`0x${addressWord(ZERO_ADDRESS)}`)).toBe(ZERO_ADDRESS);
  });

  it("rejects words whose upper 12 bytes carry dirty padding", () => {
    const dirty = `0x${"00".repeat(11)}de${STRATEGY_A.slice(2)}`;
    expect(dirty).toHaveLength(66);
    expect(decodeStrictAddressWord(dirty)).toBeNull();
  });

  it("lowercases the decoded address and rejects non-word input", () => {
    expect(decodeStrictAddressWord(`0x${addressWord(STRATEGY_A.toUpperCase())}`)).toBe(
      STRATEGY_A,
    );
    expect(decodeStrictAddressWord(`0x${"00".repeat(31)}`)).toBeNull();
    expect(decodeStrictAddressWord(null)).toBeNull();
  });
});

describe("decodeStrictAddressArrayWord", () => {
  it("decodes an address array within the item cap", () => {
    expect(
      decodeStrictAddressArrayWord(addressArrayPayload(STRATEGY_A, STRATEGY_B), {
        maxItems: 10,
      }),
    ).toEqual([STRATEGY_A, STRATEGY_B]);
  });

  it("keeps zero-address entries", () => {
    expect(
      decodeStrictAddressArrayWord(addressArrayPayload(ZERO_ADDRESS), { maxItems: 10 }),
    ).toEqual([ZERO_ADDRESS]);
  });

  it("rejects an entry with dirty padding rather than truncating it to 20 bytes", () => {
    const raw = payload(
      word("20"),
      word("1"),
      `${"00".repeat(11)}de${STRATEGY_A.slice(2)}`,
    );
    expect(decodeStrictAddressArrayWord(raw, { maxItems: 10 })).toBeNull();
  });

  it("rejects a declared length above the item cap", () => {
    expect(
      decodeStrictAddressArrayWord(addressArrayPayload(STRATEGY_A, STRATEGY_B), {
        maxItems: 1,
      }),
    ).toBeNull();
  });

  it("rejects head offsets that are not a whole number of words past the head", () => {
    const misaligned = payload(word("21"), word("1"), addressWord(STRATEGY_A));
    const selfReferential = payload(word("0"), word("1"), addressWord(STRATEGY_A));
    expect(decodeStrictAddressArrayWord(misaligned, { maxItems: 10 })).toBeNull();
    expect(decodeStrictAddressArrayWord(selfReferential, { maxItems: 10 })).toBeNull();
  });

  it("rejects a payload truncated before every declared entry", () => {
    const truncated = payload(word("20"), word("2"), addressWord(STRATEGY_A));
    expect(decodeStrictAddressArrayWord(truncated, { maxItems: 10 })).toBeNull();
  });
});
