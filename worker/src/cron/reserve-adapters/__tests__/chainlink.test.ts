import { describe, expect, it } from "vitest";
import { parseChainlinkLatestRoundData } from "../chainlink";

function word(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

describe("parseChainlinkLatestRoundData", () => {
  it("decodes latestRoundData words into bigint answer and timestamp", () => {
    const encoded = `0x${[
      word(1n),
      word(123_456_789n),
      word(0n),
      word(1_700_000_000n),
      word(1n),
    ].join("")}`;

    expect(parseChainlinkLatestRoundData(encoded, "test-feed")).toEqual({
      roundId: 1n,
      answer: 123_456_789n,
      updatedAt: 1_700_000_000,
    });
  });

  it("rejects non-positive signed answers", () => {
    const negativeOne = (1n << 256n) - 1n;
    const encoded = `0x${[
      word(1n),
      word(negativeOne),
      word(0n),
      word(1_700_000_000n),
      word(1n),
    ].join("")}`;

    expect(() => parseChainlinkLatestRoundData(encoded, "test-feed"))
      .toThrow("test-feed: latestRoundData returned non-positive answer");
  });
});
