import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../evm-rpc", () => ({
  fetchEvmCallHexAtBlock: vi.fn(),
}));

import { fetchEvmCallHexAtBlock } from "../evm-rpc";
import {
  CHAINLINK_REFERENCE_FEEDS,
  fetchChainlinkReferenceQuotes,
  parseChainlinkLatestRoundData,
  parseSignedInt256Word,
} from "../chainlink-feeds";

const mockFetchEvmCallHexAtBlock = vi.mocked(fetchEvmCallHexAtBlock);

function encodeWord(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

function encodeSignedWord(value: bigint): string {
  const normalized = value >= 0n ? value : (1n << 256n) + value;
  return normalized.toString(16).padStart(64, "0");
}

function buildLatestRoundDataHex(answer: bigint, updatedAt: number): `0x${string}` {
  const words = [
    encodeWord(1n),
    encodeSignedWord(answer),
    encodeWord(0n),
    encodeWord(BigInt(updatedAt)),
    encodeWord(1n),
  ];
  return `0x${words.join("")}`;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("parseSignedInt256Word", () => {
  it("parses positive values", () => {
    expect(parseSignedInt256Word("0".repeat(63) + "5")).toBe(5n);
  });

  it("parses negative values via two's complement", () => {
    expect(parseSignedInt256Word("f".repeat(64))).toBe(-1n);
  });
});

describe("parseChainlinkLatestRoundData", () => {
  it("decodes answer and updatedAt from latestRoundData()", () => {
    const updatedAt = 1_763_888_000;
    const parsed = parseChainlinkLatestRoundData(buildLatestRoundDataHex(115_820_000n, updatedAt));
    expect(parsed.answer).toBe(115_820_000n);
    expect(parsed.updatedAt).toBe(updatedAt);
  });
});

describe("fetchChainlinkReferenceQuotes", () => {
  it("returns fresh quotes for configured feeds", async () => {
    const eurFeed = CHAINLINK_REFERENCE_FEEDS.find((feed) => feed.pegKey === "peggedEUR");
    expect(eurFeed).toBeDefined();

    mockFetchEvmCallHexAtBlock.mockImplementation(async (_chainId, address, data) => {
      if (address === eurFeed!.proxyAddress && data === "0x313ce567") {
        return "0x0000000000000000000000000000000000000000000000000000000000000008";
      }
      if (address === eurFeed!.proxyAddress && data === "0xfeaf968c") {
        return buildLatestRoundDataHex(115_820_000n, 1_763_887_900);
      }
      return null;
    });

    const quotes = await fetchChainlinkReferenceQuotes(undefined, undefined, 1_763_888_000);
    expect(quotes.get("peggedEUR")?.price).toBeCloseTo(1.1582, 4);
  });

  it("skips stale quotes", async () => {
    const eurFeed = CHAINLINK_REFERENCE_FEEDS.find((feed) => feed.pegKey === "peggedEUR");
    expect(eurFeed).toBeDefined();

    mockFetchEvmCallHexAtBlock.mockImplementation(async (_chainId, address, data) => {
      if (address === eurFeed!.proxyAddress && data === "0x313ce567") {
        return "0x0000000000000000000000000000000000000000000000000000000000000008";
      }
      if (address === eurFeed!.proxyAddress && data === "0xfeaf968c") {
        return buildLatestRoundDataHex(115_820_000n, 1_763_800_000);
      }
      return null;
    });

    const quotes = await fetchChainlinkReferenceQuotes(undefined, undefined, 1_763_888_000);
    expect(quotes.has("peggedEUR")).toBe(false);
  });
});
