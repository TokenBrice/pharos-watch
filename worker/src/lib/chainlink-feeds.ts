import { CHAIN_META } from "@shared/lib/chains";
import type { ChainRpcConfig } from "./chain-registry";
import { throwIfAborted } from "./abort";
import { parseChainlinkLatestRoundData } from "./chainlink-round-data";
import { fetchEtherscanProxyHex, fetchEvmCallHexAtBlock, fetchJsonRpcHexAtUrl } from "./evm-rpc";
import { DECIMALS_SELECTOR, LATEST_ROUND_DATA_SELECTOR } from "./evm-selectors";
export { parseChainlinkLatestRoundData, parseSignedInt256Word } from "./chainlink-round-data";
import { DRPC_NETWORK } from "./drpc";
import { mapWithConcurrency } from "./concurrency";

const DRPC_PUBLIC_RPC_URL: Partial<Record<string, string>> = {
  arbitrum: "https://arbitrum.drpc.org",
  base: "https://base.drpc.org",
  ethereum: "https://eth.drpc.org",
};
type DrpcRpcTarget = {
  label: string;
  url: string;
};

export interface ChainlinkReferenceFeed {
  pegKey: string;
  chainId: string;
  proxyAddress: string;
  staleAfterSec: number;
}

export interface ChainlinkReferenceQuote {
  pegKey: string;
  price: number;
  updatedAt: number;
  chainId: string;
  proxyAddress: string;
}

export interface ChainlinkReferenceQuoteSummary {
  configuredFeeds: number;
  usableQuotes: number;
  decimalsUnavailable: number;
  roundDataUnavailable: number;
  staleQuotes: number;
  invalidDecimals: number;
  invalidAnswers: number;
  invalidPrices: number;
  fetchErrors: number;
}

export type ChainlinkFeedOutcome = "success" | "failure";

export interface ChainlinkReferenceQuoteSnapshot {
  quotes: Map<string, ChainlinkReferenceQuote>;
  summary: ChainlinkReferenceQuoteSummary;
  perFeedOutcomes: Record<string, ChainlinkFeedOutcome>;
  failingRuns: Record<string, number>;
}

const FAILING_RUNS_WARN_THRESHOLD = 3;
const ABI_UINT256_WORD_HEX = /^[0-9a-fA-F]{64}$/;
const CHAINLINK_REFERENCE_FEED_MAX_CONCURRENCY = 3;

// Verified against official Chainlink feed pages on 2026-03-19.
export const CHAINLINK_REFERENCE_FEEDS: readonly ChainlinkReferenceFeed[] = [
  {
    pegKey: "peggedEUR",
    chainId: "base",
    proxyAddress: "0xc91D87E81faB8f93699ECf7Ee9B44D11e1D53F0F",
    staleAfterSec: 6 * 3600,
  },
  {
    pegKey: "peggedGBP",
    chainId: "base",
    proxyAddress: "0xCceA6576904C118037695eB71195a5425E69Fa15",
    staleAfterSec: 6 * 3600,
  },
  {
    pegKey: "peggedJPY",
    chainId: "ethereum",
    proxyAddress: "0xBcE206caE7f0ec07b545EddE332A47C2F75bbeb3",
    staleAfterSec: 6 * 3600,
  },
  {
    pegKey: "peggedGOLD",
    chainId: "arbitrum",
    proxyAddress: "0x1F954Dc24a49708C26E0C1777f16750B5C6d5a2c",
    staleAfterSec: 12 * 3600,
  },
  {
    pegKey: "peggedSILVER",
    chainId: "ethereum",
    proxyAddress: "0x379589227b15F1a12195D3f2d90bBc9F31f95235",
    staleAfterSec: 12 * 3600,
  },
] as const;

async function fetchFeedDecimals(
  feed: ChainlinkReferenceFeed,
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
  drpcApiKey?: string | null,
  etherscanApiKey?: string | null,
): Promise<number | null> {
  const hex = await fetchChainlinkFeedCallHex(feed, DECIMALS_SELECTOR, signal, chainRpcs, drpcApiKey, etherscanApiKey);
  if (!hex) return null;
  const stripped = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!ABI_UINT256_WORD_HEX.test(stripped)) {
    return null;
  }
  return Number(BigInt(`0x${stripped}`));
}

function getEvmChainId(chainId: string): number | null {
  const meta = CHAIN_META[chainId];
  if (!meta || meta.type !== "evm" || meta.evmChainId == null) {
    return null;
  }
  return meta.evmChainId;
}

async function fetchChainlinkDrpcHex(
  feed: ChainlinkReferenceFeed,
  data: string,
  signal?: AbortSignal,
  drpcApiKey?: string | null,
): Promise<`0x${string}` | null> {
  const network = DRPC_NETWORK[feed.chainId];
  if (!network) return null;

  const targets: DrpcRpcTarget[] = [
    drpcApiKey ? { label: "premium", url: `https://lb.drpc.live/${network}/${drpcApiKey}` } : null,
    DRPC_PUBLIC_RPC_URL[feed.chainId] ? { label: "public", url: DRPC_PUBLIC_RPC_URL[feed.chainId]! } : null,
  ].filter((value): value is DrpcRpcTarget => value != null);

  for (const target of targets) {
    throwIfAborted(signal);
    const result = await fetchJsonRpcHexAtUrl(
      target.url,
      "eth_call",
      [{ to: feed.proxyAddress, data }, "latest"],
      { signal, timeoutMs: 10_000 },
    );
    if (!result) continue;
    const methodLabel = data === DECIMALS_SELECTOR ? "decimals()" : "latestRoundData()";
    console.log(`[chainlink-feeds] ${feed.pegKey} recovered ${methodLabel} via dRPC (${target.label})`);
    return result;
  }

  return null;
}

async function fetchChainlinkFeedCallHex(
  feed: ChainlinkReferenceFeed,
  data: string,
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
  drpcApiKey?: string | null,
  etherscanApiKey?: string | null,
): Promise<`0x${string}` | null> {
  const drpcHex = await fetchChainlinkDrpcHex(feed, data, signal, drpcApiKey);
  if (drpcHex) {
    return drpcHex;
  }

  const rpcHex = await fetchEvmCallHexAtBlock(feed.chainId, feed.proxyAddress, data, "latest", {
    signal,
    chainRpcs,
  });
  if (rpcHex) {
    return rpcHex;
  }

  const evmChainId = getEvmChainId(feed.chainId);
  if (!etherscanApiKey || evmChainId == null) {
    return null;
  }

  const proxyHex = await fetchEtherscanProxyHex({
    evmChainId,
    action: "eth_call",
    to: feed.proxyAddress,
    data,
    blockNumberOrTag: "latest",
    apiKey: etherscanApiKey,
    signal,
    timeoutMs: 10_000,
  });
  if (proxyHex) {
    const methodLabel = data === DECIMALS_SELECTOR ? "decimals()" : "latestRoundData()";
    console.log(`[chainlink-feeds] ${feed.pegKey} recovered ${methodLabel} via Etherscan proxy`);
  }
  return proxyHex;
}

type SummaryCounterKey = Exclude<keyof ChainlinkReferenceQuoteSummary, "configuredFeeds" | "usableQuotes">;

interface SingleFeedResult {
  counter: SummaryCounterKey | null;
  quote: ChainlinkReferenceQuote | null;
}

async function fetchSingleFeedQuote(
  feed: ChainlinkReferenceFeed,
  nowSec: number,
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
  drpcApiKey?: string | null,
  etherscanApiKey?: string | null,
): Promise<SingleFeedResult> {
  try {
    const decimals = await fetchFeedDecimals(feed, signal, chainRpcs, drpcApiKey, etherscanApiKey);
    if (decimals == null) {
      return { counter: "decimalsUnavailable", quote: null };
    }
    if (!Number.isFinite(decimals) || decimals < 0 || decimals > 36) {
      return { counter: "invalidDecimals", quote: null };
    }
    const roundHex = await fetchChainlinkFeedCallHex(
      feed,
      LATEST_ROUND_DATA_SELECTOR,
      signal,
      chainRpcs,
      drpcApiKey,
      etherscanApiKey,
    );
    if (!roundHex) {
      return { counter: "roundDataUnavailable", quote: null };
    }
    const { answer, updatedAt } = parseChainlinkLatestRoundData(roundHex);
    if (answer <= 0n || updatedAt <= 0) {
      return { counter: "invalidAnswers", quote: null };
    }
    if ((nowSec - updatedAt) > feed.staleAfterSec) {
      return { counter: "staleQuotes", quote: null };
    }
    const price = Number(answer) / (10 ** decimals);
    if (!Number.isFinite(price) || price <= 0) {
      return { counter: "invalidPrices", quote: null };
    }
    return {
      counter: null,
      quote: {
        pegKey: feed.pegKey,
        price,
        updatedAt,
        chainId: feed.chainId,
        proxyAddress: feed.proxyAddress,
      },
    };
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    console.warn(`[chainlink-feeds] ${feed.pegKey} fetch failed:`, err);
    return { counter: "fetchErrors", quote: null };
  }
}

export async function fetchChainlinkReferenceQuoteSnapshot(
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
  nowSec = Math.floor(Date.now() / 1000),
  drpcApiKey?: string | null,
  etherscanApiKey?: string | null,
  previousFailingRuns?: Record<string, number>,
): Promise<ChainlinkReferenceQuoteSnapshot> {
  const quotes = new Map<string, ChainlinkReferenceQuote>();
  const summary: ChainlinkReferenceQuoteSummary = {
    configuredFeeds: CHAINLINK_REFERENCE_FEEDS.length,
    usableQuotes: 0,
    decimalsUnavailable: 0,
    roundDataUnavailable: 0,
    staleQuotes: 0,
    invalidDecimals: 0,
    invalidAnswers: 0,
    invalidPrices: 0,
    fetchErrors: 0,
  };
  const perFeedOutcomes: Record<string, ChainlinkFeedOutcome> = {};

  throwIfAborted(signal);
  const results = await mapWithConcurrency(
    CHAINLINK_REFERENCE_FEEDS,
    CHAINLINK_REFERENCE_FEED_MAX_CONCURRENCY,
    (feed) => fetchSingleFeedQuote(feed, nowSec, signal, chainRpcs, drpcApiKey, etherscanApiKey),
  );

  CHAINLINK_REFERENCE_FEEDS.forEach((feed, index) => {
    const { counter, quote } = results[index];
    if (counter) {
      summary[counter]++;
    }
    if (quote) {
      quotes.set(feed.pegKey, quote);
    }
    perFeedOutcomes[feed.pegKey] = quote ? "success" : "failure";
  });

  summary.usableQuotes = quotes.size;

  const failingRuns: Record<string, number> = {};
  for (const feed of CHAINLINK_REFERENCE_FEEDS) {
    const outcome = perFeedOutcomes[feed.pegKey];
    const priorCount = previousFailingRuns?.[feed.pegKey] ?? 0;
    const nextCount = outcome === "success" ? 0 : priorCount + 1;
    failingRuns[feed.pegKey] = nextCount;
    if (nextCount > FAILING_RUNS_WARN_THRESHOLD) {
      console.warn(
        `[chainlink-feeds] ${feed.pegKey} has failed ${nextCount} consecutive runs`,
      );
    }
  }

  if (summary.usableQuotes === 0) {
    console.warn(
      `[chainlink-feeds] No usable quotes: configured=${summary.configuredFeeds}, ` +
      `decimalsUnavailable=${summary.decimalsUnavailable}, roundDataUnavailable=${summary.roundDataUnavailable}, ` +
      `stale=${summary.staleQuotes}, invalidDecimals=${summary.invalidDecimals}, ` +
      `invalidAnswers=${summary.invalidAnswers}, invalidPrices=${summary.invalidPrices}, ` +
      `fetchErrors=${summary.fetchErrors}`,
    );
  }

  return { quotes, summary, perFeedOutcomes, failingRuns };
}
