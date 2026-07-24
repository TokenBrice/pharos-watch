import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Hex, sha256HexFromBytes, sha256HexFromUtf8Chunks } from "../sha256";
import {
  stableJsonStringifyChunksV1,
  stableJsonStringifyV1,
} from "../stable-json";

function nodeSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("incremental SHA-256", () => {
  it("hashes raw bytes without UTF-8 re-encoding", () => {
    const bytes = Uint8Array.from([0, 127, 128, 255]);
    expect(sha256HexFromBytes(bytes)).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
  });

  it.each([
    "",
    "abc",
    "a".repeat(55),
    "a".repeat(56),
    "a".repeat(63),
    "a".repeat(64),
    "a".repeat(65),
    "hello world",
    "price \u20ac100",
    "split \ud83d\ude00 surrogate",
    "lone high \ud83d",
    "lone low \ude00",
  ])("matches Node crypto for %j", (value) => {
    const expected = nodeSha256(value);
    expect(sha256Hex(value)).toBe(expected);
    expect(sha256HexFromUtf8Chunks([...value])).toBe(expected);
    for (let width = 1; width <= Math.max(1, value.length); width += 1) {
      const chunks = Array.from(
        { length: Math.ceil(value.length / width) },
        (_, index) => value.slice(index * width, (index + 1) * width),
      );
      expect(sha256HexFromUtf8Chunks(chunks)).toBe(expected);
    }
  });
});

describe("streamed stable JSON", () => {
  it.each([
    null,
    true,
    42,
    "unicode \ud83d\ude00",
    [1, "two", null, { z: false }],
    { z: [3, 2, 1], a: { included: true, omitted: undefined } },
    Object.fromEntries(Array.from({ length: 1_000 }, (_, index) => [`key-${index}`, index])),
  ])("emits the exact canonical V1 string", (value) => {
    expect([...stableJsonStringifyChunksV1(value)].join("")).toBe(
      stableJsonStringifyV1(value),
    );
  });

  it("preserves stable JSON validation errors", () => {
    const invalid = { values: [1, undefined] };
    expect(() => stableJsonStringifyV1(invalid)).toThrow(
      "Cannot serialize undefined array entry at $.values[1]",
    );
    expect(() => stableJsonStringifyChunksV1(invalid)).toThrow(
      "Cannot serialize undefined array entry at $.values[1]",
    );
  });
});
