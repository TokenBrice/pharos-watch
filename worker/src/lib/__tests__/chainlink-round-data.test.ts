import { describe, expect, it } from "vitest";
import {
  parseChainlinkLatestRoundData,
  parseSignedInt256Word,
  requireChainlinkLatestRoundData,
} from "../chainlink-round-data";
import { buildLatestRoundDataHex } from "./chainlink-abi.test-support";

// Hand-written AggregatorV3 vector, independent of the shared encoder: a
// startedAt word distinct from updatedAt proves which word the parser reads.
const LITERAL_ROUND_HEX = "0x"
  + "0000000000000000000000000000000000000000000000000000000000000007" // roundId
  + "000000000000000000000000000000000000000000000000000000003b9aca00" // answer = 1e9
  + "0000000000000000000000000000000000000000000000000000000065a8f000" // startedAt
  + "0000000000000000000000000000000000000000000000000000000065a8f100" // updatedAt
  + "0000000000000000000000000000000000000000000000000000000000000001"; // answeredInRound

describe("parseSignedInt256Word", () => {
  it("parses positive values", () => {
    expect(parseSignedInt256Word("0".repeat(63) + "5")).toBe(5n);
  });

  it("parses negative values via two's complement", () => {
    expect(parseSignedInt256Word("f".repeat(64))).toBe(-1n);
  });
});

describe("parseChainlinkLatestRoundData", () => {
  it("decodes the literal five-word response, taking updatedAt from the fourth word", () => {
    expect(parseChainlinkLatestRoundData(LITERAL_ROUND_HEX, "test-feed")).toEqual({
      roundId: 7n,
      answer: 1_000_000_000n,
      updatedAt: 0x65a8f100,
      invalidReason: null,
    });
  });

  it("decodes a response truncated to the four words it reads", () => {
    const updatedAt = 1_763_888_000;
    const fourWordHex = `0x${buildLatestRoundDataHex(115_820_000n, updatedAt).slice(2, 2 + (64 * 4))}`;
    expect(parseChainlinkLatestRoundData(fourWordHex, "test-feed")).toEqual({
      roundId: 1n,
      answer: 115_820_000n,
      updatedAt,
      invalidReason: null,
    });
  });

  it.each([
    {
      label: "a response shorter than four words",
      hex: `0x${"00".repeat(80)}`,
      message: "test-feed: latestRoundData response too short (160 hex chars)",
    },
    {
      label: "a response with non-hex characters",
      hex: `${buildLatestRoundDataHex(115_820_000n, 1_763_888_000).slice(0, -1)}g`,
      message: "test-feed: latestRoundData response contains malformed hex",
    },
  ])("throws for $label", ({ hex, message }) => {
    expect(() => parseChainlinkLatestRoundData(hex, "test-feed")).toThrow(message);
  });

  // Bad rounds are decodable evidence, not transport failures: consumers that
  // count evidence classes must be able to tell them apart from fetch errors.
  it.each([
    { label: "a zero answer", answer: 0n, updatedAt: 1_763_888_000, reason: "non-positive-answer" },
    { label: "a negative answer", answer: -1n, updatedAt: 1_763_888_000, reason: "non-positive-answer" },
    { label: "a zero updatedAt", answer: 115_820_000n, updatedAt: 0, reason: "non-positive-updated-at" },
  ])("classifies $label as unusable evidence instead of throwing", ({ answer, updatedAt, reason }) => {
    expect(parseChainlinkLatestRoundData(buildLatestRoundDataHex(answer, updatedAt), "test-feed")).toEqual({
      roundId: 1n,
      answer,
      updatedAt,
      invalidReason: reason,
    });
  });
});

describe("requireChainlinkLatestRoundData", () => {
  it("returns the decoded round when the answer and timestamp are usable", () => {
    expect(requireChainlinkLatestRoundData(LITERAL_ROUND_HEX, "test-feed").answer).toBe(1_000_000_000n);
  });

  it.each([
    {
      answer: 0n,
      updatedAt: 1_763_888_000,
      message: "test-feed: latestRoundData returned non-positive answer",
    },
    {
      answer: -1n,
      updatedAt: 1_763_888_000,
      message: "test-feed: latestRoundData returned non-positive answer",
    },
    {
      answer: 115_820_000n,
      updatedAt: 0,
      message: "test-feed: latestRoundData returned non-positive updatedAt",
    },
  ])("fails closed with $message", ({ answer, updatedAt, message }) => {
    expect(() => requireChainlinkLatestRoundData(buildLatestRoundDataHex(answer, updatedAt), "test-feed"))
      .toThrow(message);
  });
});
