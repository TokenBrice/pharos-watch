import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../evm-rpc", () => ({
  fetchEvmCallHexAtBlock: vi.fn(),
  fetchEtherscanProxyHex: vi.fn(),
  fetchJsonRpcHexAtUrl: vi.fn(),
}));

import { fetchEtherscanProxyHex, fetchEvmCallHexAtBlock, fetchJsonRpcHexAtUrl } from "../evm-rpc";
import {
  CHAINLINK_REFERENCE_FEEDS,
  fetchChainlinkReferenceQuoteSnapshot,
  parseChainlinkLatestRoundData,
  parseSignedInt256Word,
} from "../chainlink-feeds";

const mockFetchEvmCallHexAtBlock = vi.mocked(fetchEvmCallHexAtBlock);
const mockFetchEtherscanProxyHex = vi.mocked(fetchEtherscanProxyHex);
const mockFetchJsonRpcHexAtUrl = vi.mocked(fetchJsonRpcHexAtUrl);

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
  mockFetchEvmCallHexAtBlock.mockReset();
  mockFetchEtherscanProxyHex.mockReset();
  mockFetchJsonRpcHexAtUrl.mockReset();
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

  it("accepts the four latestRoundData() words that the parser reads", () => {
    const updatedAt = 1_763_888_000;
    const fourWordHex = `0x${buildLatestRoundDataHex(115_820_000n, updatedAt).slice(2, 2 + (64 * 4))}`;
    const parsed = parseChainlinkLatestRoundData(fourWordHex);
    expect(parsed.answer).toBe(115_820_000n);
    expect(parsed.updatedAt).toBe(updatedAt);
  });

  it("rejects malformed latestRoundData() hex", () => {
    const malformedHex = `${buildLatestRoundDataHex(115_820_000n, 1_763_888_000).slice(0, -1)}g`;
    expect(() => parseChainlinkLatestRoundData(malformedHex)).toThrow("malformed hex");
  });
});

describe("fetchChainlinkReferenceQuoteSnapshot", () => {
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

    const quotes = (await fetchChainlinkReferenceQuoteSnapshot(undefined, undefined, 1_763_888_000)).quotes;
    expect(quotes.get("peggedEUR")?.price).toBeCloseTo(1.1582, 4);
  });

  it("falls back to the Etherscan proxy when RPC calls return null", async () => {
    const eurFeed = CHAINLINK_REFERENCE_FEEDS.find((feed) => feed.pegKey === "peggedEUR");
    expect(eurFeed).toBeDefined();

    mockFetchEvmCallHexAtBlock.mockResolvedValue(null);
    mockFetchJsonRpcHexAtUrl.mockResolvedValue(null);
    mockFetchEtherscanProxyHex.mockImplementation(async ({ evmChainId, to, data }) => {
      expect(evmChainId).toBe(8453);
      if (to === eurFeed!.proxyAddress && data === "0x313ce567") {
        return "0x0000000000000000000000000000000000000000000000000000000000000008";
      }
      if (to === eurFeed!.proxyAddress && data === "0xfeaf968c") {
        return buildLatestRoundDataHex(115_820_000n, 1_763_887_900);
      }
      return null;
    });

    const quotes = (await fetchChainlinkReferenceQuoteSnapshot(undefined, undefined, 1_763_888_000, undefined, "etherscan-key")).quotes;
    expect(quotes.get("peggedEUR")?.price).toBeCloseTo(1.1582, 4);
    expect(mockFetchEtherscanProxyHex).toHaveBeenCalled();
  });

  it("prefers dRPC before shared RPC and Etherscan fallbacks", async () => {
    const eurFeed = CHAINLINK_REFERENCE_FEEDS.find((feed) => feed.pegKey === "peggedEUR");
    expect(eurFeed).toBeDefined();

    mockFetchJsonRpcHexAtUrl.mockImplementation(async (_url, _method, params) => {
      const [callObj] = params as [{ to: string; data: string }];
      if (callObj.to === eurFeed!.proxyAddress && callObj.data === "0x313ce567") {
        return "0x0000000000000000000000000000000000000000000000000000000000000008";
      }
      if (callObj.to === eurFeed!.proxyAddress && callObj.data === "0xfeaf968c") {
        return buildLatestRoundDataHex(115_820_000n, 1_763_887_900);
      }
      return null;
    });

    const quotes = (await fetchChainlinkReferenceQuoteSnapshot(undefined, undefined, 1_763_888_000, "drpc-key")).quotes;
    expect(quotes.get("peggedEUR")?.price).toBeCloseTo(1.1582, 4);
    expect(mockFetchJsonRpcHexAtUrl).toHaveBeenCalled();
    expect(mockFetchEvmCallHexAtBlock).not.toHaveBeenCalledWith(
      "base",
      eurFeed!.proxyAddress,
      "0x313ce567",
      "latest",
      expect.anything(),
    );
    expect(mockFetchEvmCallHexAtBlock).not.toHaveBeenCalledWith(
      "base",
      eurFeed!.proxyAddress,
      "0xfeaf968c",
      "latest",
      expect.anything(),
    );
    expect(mockFetchEtherscanProxyHex).not.toHaveBeenCalled();
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

    const quotes = (await fetchChainlinkReferenceQuoteSnapshot(undefined, undefined, 1_763_888_000)).quotes;
    expect(quotes.has("peggedEUR")).toBe(false);
  });

  it("reports summary counts for unavailable and stale feeds", async () => {
    const eurFeed = CHAINLINK_REFERENCE_FEEDS.find((feed) => feed.pegKey === "peggedEUR");
    const gbpFeed = CHAINLINK_REFERENCE_FEEDS.find((feed) => feed.pegKey === "peggedGBP");
    expect(eurFeed).toBeDefined();
    expect(gbpFeed).toBeDefined();

    mockFetchEvmCallHexAtBlock.mockImplementation(async (_chainId, address, data) => {
      if (address === eurFeed!.proxyAddress && data === "0x313ce567") {
        return "0x0000000000000000000000000000000000000000000000000000000000000008";
      }
      if (address === eurFeed!.proxyAddress && data === "0xfeaf968c") {
        return buildLatestRoundDataHex(115_820_000n, 1_763_800_000);
      }
      if (address === gbpFeed!.proxyAddress && data === "0x313ce567") {
        return "0x0000000000000000000000000000000000000000000000000000000000000008";
      }
      return null;
    });

    const snapshot = await fetchChainlinkReferenceQuoteSnapshot(undefined, undefined, 1_763_888_000);
    expect(snapshot.quotes.size).toBe(0);
    expect(snapshot.summary.usableQuotes).toBe(0);
    expect(snapshot.summary.staleQuotes).toBe(1);
    expect(snapshot.summary.roundDataUnavailable).toBeGreaterThanOrEqual(1);
  });

  it("counts malformed decimals words as unavailable", async () => {
    mockFetchEvmCallHexAtBlock.mockImplementation(async (_chainId, _address, data) => {
      if (data === "0x313ce567") {
        return `0x${"g".repeat(64)}` as `0x${string}`;
      }
      return buildLatestRoundDataHex(115_820_000n, 1_763_887_900);
    });

    const snapshot = await fetchChainlinkReferenceQuoteSnapshot(undefined, undefined, 1_763_888_000);
    expect(snapshot.quotes.size).toBe(0);
    expect(snapshot.summary.decimalsUnavailable).toBe(CHAINLINK_REFERENCE_FEEDS.length);
    expect(snapshot.summary.fetchErrors).toBe(0);
  });

  it("bounds parallel feed fetches to the cron connection budget", async () => {
    let activeCalls = 0;
    let maxActiveCalls = 0;

    mockFetchJsonRpcHexAtUrl.mockImplementation(async (_url, _method, params) => {
      activeCalls++;
      maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
      await new Promise((resolve) => setTimeout(resolve, 1));
      activeCalls--;

      const [callObj] = params as [{ to: string; data: string }];
      const feed = CHAINLINK_REFERENCE_FEEDS.find((candidate) => candidate.proxyAddress === callObj.to);
      if (!feed) {
        return null;
      }
      if (callObj.data === "0x313ce567") {
        return "0x0000000000000000000000000000000000000000000000000000000000000008";
      }
      if (callObj.data === "0xfeaf968c") {
        return buildLatestRoundDataHex(115_820_000n, 1_763_887_900);
      }
      return null;
    });

    const snapshot = await fetchChainlinkReferenceQuoteSnapshot(undefined, undefined, 1_763_888_000);

    expect(snapshot.summary.usableQuotes).toBe(CHAINLINK_REFERENCE_FEEDS.length);
    expect(maxActiveCalls).toBeLessThanOrEqual(3);
  });

  it("skips the legacy dRPC endpoint after premium and public failures", async () => {
    const eurFeed = CHAINLINK_REFERENCE_FEEDS.find((feed) => feed.pegKey === "peggedEUR");
    expect(eurFeed).toBeDefined();

    mockFetchJsonRpcHexAtUrl.mockResolvedValue(null);
    mockFetchEvmCallHexAtBlock.mockResolvedValue(null);
    mockFetchEtherscanProxyHex.mockResolvedValue(null);

    await fetchChainlinkReferenceQuoteSnapshot(undefined, undefined, 1_763_888_000, "drpc-key");

    const calledUrls = mockFetchJsonRpcHexAtUrl.mock.calls.map(([url]) => String(url));
    const eurCallsForDecimals = calledUrls.filter(
      (url) => url.includes("drpc") && (url.includes("/base") || url.includes("network=base")),
    );
    expect(eurCallsForDecimals.some((url) => url.includes("lb.drpc.live/base/"))).toBe(true);
    expect(eurCallsForDecimals.some((url) => url === "https://base.drpc.org")).toBe(true);
    // Legacy ogrpc endpoint must no longer be attempted.
    expect(eurCallsForDecimals.some((url) => url.includes("lb.drpc.org/ogrpc"))).toBe(false);
  });

  it("tracks per-feed outcomes and consecutive failing runs", async () => {
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

    const priorFailingRuns: Record<string, number> = {
      peggedEUR: 2,
      peggedGBP: 0,
    };
    const snapshot = await fetchChainlinkReferenceQuoteSnapshot(
      undefined,
      undefined,
      1_763_888_000,
      undefined,
      undefined,
      priorFailingRuns,
    );

    expect(snapshot.perFeedOutcomes.peggedEUR).toBe("success");
    expect(snapshot.perFeedOutcomes.peggedGBP).toBe("failure");
    // Success resets counter to zero.
    expect(snapshot.failingRuns.peggedEUR).toBe(0);
    // Failure increments from prior.
    expect(snapshot.failingRuns.peggedGBP).toBe(1);
  });

  it("logs a warning when a feed has been failing more than 3 consecutive runs", async () => {
    mockFetchEvmCallHexAtBlock.mockResolvedValue(null);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const priorFailingRuns: Record<string, number> = {
      peggedEUR: 3,
    };
    const snapshot = await fetchChainlinkReferenceQuoteSnapshot(
      undefined,
      undefined,
      1_763_888_000,
      undefined,
      undefined,
      priorFailingRuns,
    );

    expect(snapshot.failingRuns.peggedEUR).toBe(4);
    const warningLogged = warnSpy.mock.calls.some((args) => {
      const msg = args.map((a) => String(a)).join(" ");
      return msg.includes("peggedEUR") && msg.includes("4");
    });
    expect(warningLogged).toBe(true);
    warnSpy.mockRestore();
  });
});
