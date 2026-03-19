import type { ChainRpcConfig } from "./chain-registry";
import { fetchEvmCallHexAtBlock } from "./evm-rpc";

const DECIMALS_SELECTOR = "0x313ce567";
const LATEST_ROUND_DATA_SELECTOR = "0xfeaf968c";

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

function parseHexWord(word: string): bigint {
  return BigInt(`0x${word}`);
}

export function parseSignedInt256Word(word: string): bigint {
  const value = parseHexWord(word);
  const signBit = 1n << 255n;
  return (value & signBit) === 0n ? value : value - (1n << 256n);
}

export function parseChainlinkLatestRoundData(
  hex: string,
): { roundId: bigint; answer: bigint; updatedAt: number } {
  const stripped = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (stripped.length < 320) {
    throw new Error(`chainlink-feeds: latestRoundData response too short (${stripped.length} hex chars)`);
  }

  const roundId = parseHexWord(stripped.slice(0, 64));
  const answer = parseSignedInt256Word(stripped.slice(64, 128));
  const updatedAt = Number(parseHexWord(stripped.slice(192, 256)));
  return { roundId, answer, updatedAt };
}

async function fetchFeedDecimals(
  feed: ChainlinkReferenceFeed,
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<number | null> {
  const hex = await fetchEvmCallHexAtBlock(feed.chainId, feed.proxyAddress, DECIMALS_SELECTOR, "latest", {
    signal,
    chainRpcs,
  });
  if (!hex) return null;
  return Number(BigInt(hex));
}

export async function fetchChainlinkReferenceQuotes(
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<Map<string, ChainlinkReferenceQuote>> {
  const quotes = new Map<string, ChainlinkReferenceQuote>();

  for (const feed of CHAINLINK_REFERENCE_FEEDS) {
    try {
      const decimals = await fetchFeedDecimals(feed, signal, chainRpcs);
      if (decimals == null || !Number.isFinite(decimals) || decimals < 0 || decimals > 36) {
        continue;
      }

      const roundHex = await fetchEvmCallHexAtBlock(
        feed.chainId,
        feed.proxyAddress,
        LATEST_ROUND_DATA_SELECTOR,
        "latest",
        { signal, chainRpcs },
      );
      if (!roundHex) continue;

      const { answer, updatedAt } = parseChainlinkLatestRoundData(roundHex);
      if (answer <= 0n || updatedAt <= 0 || (nowSec - updatedAt) > feed.staleAfterSec) {
        continue;
      }

      const price = Number(answer) / (10 ** decimals);
      if (!Number.isFinite(price) || price <= 0) continue;

      quotes.set(feed.pegKey, {
        pegKey: feed.pegKey,
        price,
        updatedAt,
        chainId: feed.chainId,
        proxyAddress: feed.proxyAddress,
      });
    } catch (err) {
      console.warn(`[chainlink-feeds] ${feed.pegKey} fetch failed:`, err);
    }
  }

  return quotes;
}
