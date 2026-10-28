import { setTimeout } from "node:timers/promises";
import { PUBLIC_RPC_URLS, SUPPLY_RPC_DEFAULTS } from "@shared/lib/chain-rpc-registry";
import { isRecord } from "@shared/lib/type-guards";
import { parseStrictCliArgs, runDirectCli, writeFileResolved } from "../lib/cli-args.mjs";

export const DIVERGENCE_THRESHOLD = 0.02;
export const PUBLISHED_MAX_AGE_SEC = 3600;
export const BLOCK_MAX_AGE_SEC = 300;
const FUTURE_SKEW_SEC = 60;
const API_URL = "https://api.pharos.watch/api/stablecoins";
const HYPEREVM_USDC = "0xb88339cb7199b77e23db6e890353e22632ba630f";
const ARBITRUM_USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const BRIDGE2 = "0x2df1c51e09aecf9cacb7bc98cb1742757f163df7";

interface BlockClock { number: number; timestamp: number }
interface ChainRead {
  rpc: string;
  contract: string;
  method: string;
  decimals: number;
  amount: number;
  before: BlockClock;
  after: BlockClock;
  failedAttempts: string[];
}
interface PublishedRead { amount: number; observedAt: number; clock: string; url: string; bucket: string }
interface ComparisonInput {
  published: number;
  supply: number;
  escrow: number;
  publishedAt: number;
  blockTimestamps: number[];
  now: number;
}

export function compareHypercoreUsdc(input: ComparisonInput) {
  const { published, supply, escrow, publishedAt, blockTimestamps, now } = input;
  if (![published, supply, escrow, now].every(Number.isFinite) || published <= 0 || supply < 0 || escrow < 0) {
    return { status: "unavailable" as const, reason: "invalid-amount" };
  }
  const fresh = (clock: number, budget: number) => Number.isSafeInteger(clock) && clock > 0
    && now - clock <= budget && clock - now <= FUTURE_SKEW_SEC;
  if (!fresh(publishedAt, PUBLISHED_MAX_AGE_SEC)) {
    return { status: "unavailable" as const, reason: "published-clock-stale-or-invalid" };
  }
  if (blockTimestamps.length !== 4 || !blockTimestamps.every(clock => fresh(clock, BLOCK_MAX_AGE_SEC))) {
    return { status: "unavailable" as const, reason: "block-clock-stale-or-invalid" };
  }
  const aggregate = supply + escrow;
  const ratio = aggregate / published;
  if (!Number.isFinite(aggregate) || !Number.isFinite(ratio)) {
    return { status: "unavailable" as const, reason: "invalid-amount" };
  }
  const deviation = (aggregate - published) / published;
  return Math.abs(deviation) > DIVERGENCE_THRESHOLD
    ? { status: "divergence" as const, reason: "aggregate-outside-threshold", aggregate, ratio, deviation }
    : { status: "healthy" as const, aggregate, ratio, deviation };
}

export function readPublishedHypercoreUsdc(data: unknown): PublishedRead {
  if (!isRecord(data) || !Array.isArray(data.peggedAssets) || !isRecord(data._meta)) throw new Error("published-schema-invalid");
  const coins = data.peggedAssets.filter(coin => isRecord(coin) && coin.id === "usdc-circle");
  const coin = coins[0];
  if (coins.length !== 1 || !isRecord(coin) || !isRecord(coin.chainCirculating)) throw new Error("published-usdc-missing");
  if (coin.supplySource !== "defillama" || coin.supplyRestored || coin.supplyUnavailableReason) throw new Error("published-supply-not-current-upstream");
  const rows = Object.entries(coin.chainCirculating);
  if (rows.some(([key]) => /hyperevm/i.test(key))) throw new Error("published-perimeter-changed");
  const buckets = rows.filter(([key]) => key === "Hyperliquid L1" || key === "hyperliquid");
  const row = buckets[0]?.[1];
  if (buckets.length !== 1 || !isRecord(row) || typeof row.current !== "number" || !Number.isFinite(row.current)) throw new Error("published-bucket-unavailable");
  const generationAt = data._meta.updatedAt;
  if (typeof generationAt !== "number" || !Number.isSafeInteger(generationAt) || generationAt <= 0) throw new Error("published-clock-unavailable");
  if (coin.supplyObservedAt !== undefined && (typeof coin.supplyObservedAt !== "number" || !Number.isSafeInteger(coin.supplyObservedAt) || coin.supplyObservedAt <= 0)) throw new Error("published-clock-unavailable");
  const latestAllowed = Math.floor(Date.now() / 1000) + FUTURE_SKEW_SEC;
  if (generationAt > latestAllowed || (coin.supplyObservedAt !== undefined && coin.supplyObservedAt > latestAllowed)) throw new Error("published-clock-future");
  return {
    amount: row.current,
    observedAt: Math.min(generationAt, coin.supplyObservedAt ?? generationAt),
    clock: coin.supplyObservedAt === undefined ? "_meta.updatedAt" : "min(supplyObservedAt, _meta.updatedAt)",
    url: API_URL,
    bucket: buckets[0][0],
  };
}

export async function runHypercoreUsdcCheck(apiKey: string, fetchImpl: typeof fetch = fetch) {
  const request = async (url: string, init: RequestInit): Promise<unknown> => {
    // Serial requests stay below the probe's ten-starts/second ceiling, including fast failures.
    await setTimeout(110);
    const response = await fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`http-${response.status}`);
    }
    return response.json();
  };
  const rpc = async (url: string, method: string, params: unknown[]) => {
    const data = await request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (!isRecord(data) || data.jsonrpc !== "2.0" || data.id !== 1 || data.error !== undefined || data.result === undefined) throw new Error("rpc-response-invalid");
    return data.result;
  };
  const quantity = (value: unknown) => {
    if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) throw new Error("rpc-quantity-invalid");
    const number = Number(BigInt(value));
    if (!Number.isSafeInteger(number) || number < 0) throw new Error("rpc-quantity-unsafe");
    return number;
  };
  const block = async (url: string): Promise<BlockClock> => {
    const value = await rpc(url, "eth_getBlockByNumber", ["latest", false]);
    if (!isRecord(value)) throw new Error("rpc-block-invalid");
    return { number: quantity(value.number), timestamp: quantity(value.timestamp) };
  };
  const readChain = async (urls: string[], contract: string, data: string, chainId: number, method: string): Promise<ChainRead> => {
    const failedAttempts: string[] = [];
    for (const url of urls) {
      try {
        if (quantity(await rpc(url, "eth_chainId", [])) !== chainId) throw new Error("rpc-chain-id-mismatch");
        const before = await block(url);
        const call = async (callData: string) => {
          const value = await rpc(url, "eth_call", [{ to: contract, data: callData }, "latest"]);
          if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/i.test(value)) throw new Error("rpc-uint256-invalid");
          return BigInt(value);
        };
        const decimals = Number(await call("0x313ce567"));
        if (decimals !== 6) throw new Error("usdc-decimals-mismatch");
        const raw = await call(data);
        const amount = Number(raw / 1_000_000n) + Number(raw % 1_000_000n) / 1_000_000;
        if (raw / 1_000_000n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("usdc-amount-unsafe");
        const after = await block(url);
        if (after.number < before.number || after.timestamp < before.timestamp) throw new Error("rpc-block-regressed");
        return { rpc: url, contract, method, decimals, amount, before, after, failedAttempts };
      } catch (error) {
        failedAttempts.push(`${url}: ${error instanceof Error ? error.message : "read-failed"}`);
      }
    }
    throw new Error(failedAttempts.join("; "));
  };
  const failures: string[] = [];
  const capture = async <T>(name: string, read: () => Promise<T>): Promise<T | null> => {
    try { return await read(); } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : "read-failed"}`);
      return null;
    }
  };
  const published = await capture("published", async () => {
    if (!apiKey) throw new Error("PHAROS_API_KEY-missing");
    return readPublishedHypercoreUsdc(await request(API_URL, { headers: { "X-API-Key": apiKey, "Cache-Control": "no-cache" } }));
  });
  const hyperevm = await capture("hyperevm", () => readChain([
    SUPPLY_RPC_DEFAULTS.hyperevm.rpcUrl, SUPPLY_RPC_DEFAULTS.hyperevm.fallbackRpcUrl,
  ], HYPEREVM_USDC, "0x18160ddd", 999, "totalSupply()"));
  const arbitrum = await capture("arbitrum", () => readChain([PUBLIC_RPC_URLS.arbitrum], ARBITRUM_USDC,
    `0x70a08231${BRIDGE2.slice(2).padStart(64, "0")}`, 42161, `balanceOf(${BRIDGE2})`));
  const assessedAt = Math.floor(Date.now() / 1000);
  const comparison = published && hyperevm && arbitrum ? compareHypercoreUsdc({
    published: published.amount, supply: hyperevm.amount, escrow: arbitrum.amount, publishedAt: published.observedAt,
    blockTimestamps: [hyperevm.before.timestamp, hyperevm.after.timestamp, arbitrum.before.timestamp, arbitrum.after.timestamp], now: assessedAt,
  }) : { status: "unavailable" as const, reason: "required-read-failed" };
  return { ...comparison, assessedAt, threshold: DIVERGENCE_THRESHOLD,
    budgets: { publishedMaxAgeSec: PUBLISHED_MAX_AGE_SEC, blockMaxAgeSec: BLOCK_MAX_AGE_SEC, futureSkewSec: FUTURE_SKEW_SEC },
    published, hyperevm, arbitrum, failures };
}

export function renderHypercoreReport(report: Awaited<ReturnType<typeof runHypercoreUsdcCheck>>, runUrl: string) {
  return [
    `Due: ${new Date(report.assessedAt * 1000).toISOString().slice(0, 10)}`,
    "Origin: scheduled HyperCore USDC aggregate cross-check",
    `Run: ${runUrl}`,
    "",
    "## Check",
    "Run `node --env-file=.env.local --import tsx scripts/maintenance/check-hypercore-usdc.ts` or dispatch HyperCore USDC Cross-check.",
    "Done when: a complete fresh comparison is within the threshold, or the upstream bucket perimeter is reconciled.",
    "",
    "Aggregate cross-check only: HyperEVM native USDC totalSupply + residual Arbitrum Bridge2 escrow, assuming $1/USDC. Includes HyperEVM holdings; does not isolate HyperCore or override published supply.",
    "RPC calls use latest; before/after blocks bracket the reads and are not exact state pins.",
    "",
    "```json",
    JSON.stringify(report, null, 2),
    "```",
    "",
  ].join("\n");
}

runDirectCli(import.meta.url, async () => {
  const { values } = parseStrictCliArgs(process.argv.slice(2), { options: {
    help: { type: "boolean", short: "h" }, report: { type: "string" }, body: { type: "string" },
  } });
  if (values.help) {
    console.log("Read-only HyperCore USDC aggregate check. PHAROS_API_KEY required.\nOptions: --report <json-path> --body <markdown-path> --help\nExits: 0 healthy/divergence, 1 unavailable, 2 usage. Never mutates GitHub.");
    return;
  }
  const report = await runHypercoreUsdcCheck(process.env.PHAROS_API_KEY ?? "");
  const json = JSON.stringify(report, null, 2);
  console.log(json);
  if (typeof values.report === "string") writeFileResolved(values.report, `${json}\n`);
  if (typeof values.body === "string") writeFileResolved(values.body, renderHypercoreReport(report,
    process.env.GITHUB_ACTIONS === "true" ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : "local read-only check"));
  if (report.status === "unavailable") process.exitCode = 1;
});
