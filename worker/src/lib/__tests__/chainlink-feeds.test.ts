import { describe, it, expect, vi, afterEach } from "vitest";
import { buildLatestRoundDataHex, encodeWord } from "./chainlink-abi.test-support";
import { createDeferredPromise } from "./deferred.test-support";

vi.mock("../evm-rpc", () => ({
  fetchEvmCallHexAtBlock: vi.fn(),
  fetchEtherscanProxyHex: vi.fn(),
  fetchJsonRpcHexAtUrl: vi.fn(),
}));

import { fetchEtherscanProxyHex, fetchEvmCallHexAtBlock, fetchJsonRpcHexAtUrl } from "../evm-rpc";
import {
  CHAINLINK_REFERENCE_FEEDS,
  fetchChainlinkReferenceQuoteSnapshot,
} from "../chainlink-feeds";
import {
  parseChainlinkLatestRoundData,
  parseSignedInt256Word,
  requireChainlinkLatestRoundData,
} from "../chainlink-round-data";

const mockFetchEvmCallHexAtBlock = vi.mocked(fetchEvmCallHexAtBlock);
const mockFetchEtherscanProxyHex = vi.mocked(fetchEtherscanProxyHex);
const mockFetchJsonRpcHexAtUrl = vi.mocked(fetchJsonRpcHexAtUrl);

afterEach(() => {
  vi.restoreAllMocks();
  mockFetchEvmCallHexAtBlock.mockReset();
  mockFetchEtherscanProxyHex.mockReset();
  mockFetchJsonRpcHexAtUrl.mockReset();
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
    const chainIds: Record<string, number> = { base: 8453, ethereum: 1, arbitrum: 42161 };
    mockFetchEtherscanProxyHex.mockImplementation(async ({ evmChainId, to, data }) => {
      const feed = CHAINLINK_REFERENCE_FEEDS.find((candidate) =>
        candidate.proxyAddress === to && chainIds[candidate.chainId] === evmChainId);
      if (!feed) return null;
      if (data === "0x313ce567") return `0x${encodeWord(8n)}`;
      if (data === "0xfeaf968c") return buildLatestRoundDataHex(115_820_000n, 1_763_887_900);
      return null;
    });

    const snapshot = await fetchChainlinkReferenceQuoteSnapshot(undefined, undefined, 1_763_888_000, undefined, "etherscan-key");
    expect(snapshot.quotes.get("peggedEUR")?.price).toBeCloseTo(1.1582, 4);
    expect(snapshot.summary.fetchErrors).toBe(0);
    expect(snapshot.summary.usableQuotes).toBe(CHAINLINK_REFERENCE_FEEDS.length);
    expect(mockFetchEtherscanProxyHex.mock.calls.map(([call]) => [call.evmChainId, call.to, call.data]).sort())
      .toEqual(CHAINLINK_REFERENCE_FEEDS.flatMap((feed) =>
        ["0x313ce567", "0xfeaf968c"].map((data) => [chainIds[feed.chainId], feed.proxyAddress, data])).sort());
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

  it("enforces numeric and freshness boundaries independently", async () => {
    const now = 1_763_888_000;
    const eur = CHAINLINK_REFERENCE_FEEDS.find((feed) => feed.pegKey === "peggedEUR")!;
    const cases = [
      { decimals: 36n, answer: 10n ** 36n, updatedAt: now, counter: null },
      { decimals: 37n, answer: 10n ** 37n, updatedAt: now, counter: "invalidDecimals" },
      { decimals: 8n, answer: 100_000_000n, updatedAt: now - 21_600, counter: null },
      { decimals: 8n, answer: 100_000_000n, updatedAt: now - 21_601, counter: "staleQuotes" },
    ] as const;
    for (const testCase of cases) {
      mockFetchEvmCallHexAtBlock.mockImplementation(async (_chain, address, data) => {
        if (address !== eur.proxyAddress) return null;
        return data === "0x313ce567" ? `0x${encodeWord(testCase.decimals)}`
          : buildLatestRoundDataHex(testCase.answer, testCase.updatedAt);
      });
      const snapshot = await fetchChainlinkReferenceQuoteSnapshot(undefined, undefined, now);
      expect(snapshot.quotes.get("peggedEUR")?.price).toBe(testCase.counter ? undefined : 1);
      if (testCase.counter) expect(snapshot.summary[testCase.counter]).toBe(1);
      expect(snapshot.summary.fetchErrors).toBe(0);
    }
  });

  it.each([[0n, 1_763_888_000], [-1n, 1_763_888_000], [100_000_000n, 0]] as const)(
    "classifies answer %s at %s as invalid evidence rather than a transport error", async (answer, updatedAt) => {
      mockFetchEvmCallHexAtBlock.mockImplementation(async (_chain, _address, data) =>
        data === "0x313ce567" ? `0x${encodeWord(8n)}` : buildLatestRoundDataHex(answer, updatedAt));
      const snapshot = await fetchChainlinkReferenceQuoteSnapshot(undefined, undefined, 1_763_888_000);
      expect(snapshot.quotes.size).toBe(0);
      expect(snapshot.summary.invalidAnswers).toBe(CHAINLINK_REFERENCE_FEEDS.length);
      expect(snapshot.summary.fetchErrors).toBe(0);
    },
  );

  it("rejects cancellation during pending transport", async () => {
    const controller = new AbortController();
    const { promise: pending, resolve: started } = createDeferredPromise();
    mockFetchJsonRpcHexAtUrl.mockImplementation(async () => {
      started();
      const promise = new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
      });
      return promise;
    });
    const run = fetchChainlinkReferenceQuoteSnapshot(controller.signal);
    const rejected = expect(run).rejects.toThrow("cancelled during transport");
    await pending;
    controller.abort(new Error("cancelled during transport"));
    await rejected;
  });

  it("bounds parallel feed fetches to the cron connection budget", async () => {
    let activeCalls = 0;
    let maxActiveCalls = 0;
    const { promise: gate, resolve: release } = createDeferredPromise();
    const { promise: pending, resolve: started } = createDeferredPromise();

    mockFetchJsonRpcHexAtUrl.mockImplementation(async (_url, _method, params) => {
      activeCalls++;
      maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
      if (activeCalls === 3) started();
      await gate;
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

    const run = fetchChainlinkReferenceQuoteSnapshot(undefined, undefined, 1_763_888_000);
    await pending;
    const initialActive = activeCalls;
    release();
    const snapshot = await run;
    expect(initialActive).toBe(3);

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

});

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
