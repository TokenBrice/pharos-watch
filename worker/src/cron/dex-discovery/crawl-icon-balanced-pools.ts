import type { ContractDeployment } from "@shared/types/core";
import { isRecord } from "@shared/lib/type-guards";
import {
  ICON_BALANCED_BNUSD_DISCOVERY_ADDRESS as BNUSD_ADDRESS,
  isIconBalancedDiscoveryDeployment,
} from "@shared/lib/dex-deployment-coverage";
import { STAGED_POOL_MAX_TVL_USD } from "./types";
import {
  buildStageSignal,
  toStagedPool,
  type CrawlStageContext,
} from "./staged-pool";
import type { DexDeploymentProviderCheck } from "./types";
import { fetchJsonWithRetry } from "../../lib/fetch-retry";

// Balanced's v1 exchange SCORE is the live contract at
// https://tracker.icon.community/contract/cxa0af3165c08318e988cb30993b3048335b94af6c.
// ICON v3 supports `height` on icx_call at
// https://github.com/icon-project/documentation/blob/master/references/icon-json-rpc-v3.md.
const ICON_RPC_URL = "https://ctz.solidwallet.io/api/v3";
const BALANCED_DEX_ADDRESS = "cxa0af3165c08318e988cb30993b3048335b94af6c";
const ICON_BALANCED_RPC_TIMEOUT_MS = 2_500;
const ICON_BALANCED_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
// ICON currently rejects JSON-RPC batches over ten calls. Batches are sent
// serially, so this stage uses one active connection and stays under the
// Worker's six-connection trigger ceiling even when a pool has many IDs.
const ICON_BALANCED_MAX_BATCH_SIZE = 10;
// Keep an unexpectedly large nonce bounded by the 25-second per-coin crawl
// budget; a nonce above this ceiling remains degraded rather than empty.
const ICON_BALANCED_MAX_POOL_ID = 128;
const ICON_BALANCED_PROVIDER = "icon-balanced";
const ICON_BALANCED_SOURCE = "icon-balanced";

interface IconRpcRequest {
  jsonrpc: "2.0";
  method: string;
  id: number;
  params?: Record<string, unknown>;
}

interface IconRpcResponse {
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
  error?: unknown;
}

interface IconPoolStats {
  poolId: number;
  base: bigint;
  baseDecimals: number;
  baseToken: string;
  quote: bigint;
  quoteDecimals: number;
  quoteToken: string;
  name: string | null;
  raw: Record<string, unknown>;
}

interface IconPoolSnapshot {
  poolId: number;
  blockHeight: number;
  stats: Record<string, unknown>;
}

interface BatchReadResult {
  responses: Map<number, IconRpcResponse>;
  schemaDegraded: boolean;
}

class IconRpcSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IconRpcSchemaError";
  }
}

export { isIconBalancedDiscoveryDeployment };

function rpcRequest(id: number, method: string, params?: Record<string, unknown>): IconRpcRequest {
  return {
    jsonrpc: "2.0",
    method,
    id,
    ...(params ? { params } : {}),
  };
}

function balancedCall(
  id: number,
  height: number,
  method: string,
  params?: Record<string, string>,
): IconRpcRequest {
  return rpcRequest(id, "icx_call", {
    to: BALANCED_DEX_ADDRESS,
    height: `0x${height.toString(16)}`,
    dataType: "call",
    data: {
      method,
      ...(params ? { params } : {}),
    },
  });
}

function parsePositiveInteger(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) return null;
  const parsed = Number.parseInt(value.slice(2), 16);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseInteger(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) return null;
  const parsed = Number.parseInt(value.slice(2), 16);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseRawAmount(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function parseScoreAddress(value: unknown): string | null {
  return typeof value === "string" && /^cx[0-9a-f]{40}$/i.test(value) ? value : null;
}

function decimalAmount(raw: bigint, decimals: number): number | null {
  const amount = Number(raw) / 10 ** decimals;
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function isErrorResponse(response: IconRpcResponse | undefined): boolean {
  return response == null || response.error != null || !Object.prototype.hasOwnProperty.call(response, "result");
}

function parseBatchResult(body: unknown, expectedIds: readonly number[]): BatchReadResult {
  if (!Array.isArray(body)) throw new IconRpcSchemaError("ICON RPC returned a non-batch response");
  const expected = new Set(expectedIds);
  const responses = new Map<number, IconRpcResponse>();
  let schemaDegraded = body.length !== expectedIds.length;

  for (const row of body) {
    if (!isRecord(row) || typeof row.id !== "number" || !Number.isSafeInteger(row.id) || !expected.has(row.id)) {
      schemaDegraded = true;
      continue;
    }
    if (responses.has(row.id)) {
      schemaDegraded = true;
      continue;
    }
    responses.set(row.id, row as IconRpcResponse);
  }

  for (const id of expectedIds) {
    if (!responses.has(id)) schemaDegraded = true;
  }
  return { responses, schemaDegraded };
}

function parsePoolStats(poolId: number, response: IconRpcResponse | undefined): IconPoolStats | null {
  if (isErrorResponse(response)) return null;
  const result = response?.result;
  if (!isRecord(result)) throw new IconRpcSchemaError(`Malformed Balanced pool stats for id ${poolId}`);

  const hasTokenField = "base_token" in result || "quote_token" in result;
  if (!hasTokenField) {
    throw new IconRpcSchemaError(`Malformed Balanced pool stats for id ${poolId}`);
  }
  if (result.base_token == null && result.quote_token == null) return null;
  const baseToken = parseScoreAddress(result.base_token);
  const quoteToken = parseScoreAddress(result.quote_token);
  if (baseToken && quoteToken && baseToken.toLowerCase() === quoteToken.toLowerCase()) {
    if (baseToken.toLowerCase() === BNUSD_ADDRESS) return null;
    throw new IconRpcSchemaError(`Malformed duplicate-token pool stats for id ${poolId}`);
  }
  if (!baseToken || !quoteToken) {
    throw new IconRpcSchemaError(`Malformed Balanced pool stats for id ${poolId}`);
  }
  const base = parseRawAmount(result.base);
  const quote = parseRawAmount(result.quote);
  const baseDecimals = parseInteger(result.base_decimals);
  const quoteDecimals = parseInteger(result.quote_decimals);
  if (base == null || quote == null || baseDecimals == null || quoteDecimals == null || baseDecimals > 36 || quoteDecimals > 36) {
    throw new IconRpcSchemaError(`Malformed Balanced reserve values for id ${poolId}`);
  }
  if (typeof result.name !== "string" && result.name !== null && result.name !== undefined) {
    throw new IconRpcSchemaError(`Malformed Balanced pool name for id ${poolId}`);
  }

  return {
    poolId,
    base,
    baseDecimals,
    baseToken,
    quote,
    quoteDecimals,
    quoteToken,
    name: typeof result.name === "string" ? result.name : null,
    raw: result,
  };
}

function poolSymbol(stats: IconPoolStats, bnusdIsBase: boolean): { symbol: string; quoteSymbol: string } {
  const parts = stats.name?.split("/").map((part) => part.trim()).filter(Boolean) ?? [];
  const baseSymbol = parts[0] ?? stats.baseToken;
  const quoteSymbol = parts[1] ?? (bnusdIsBase ? stats.quoteToken : "bnUSD");
  return {
    symbol: `${baseSymbol} / ${quoteSymbol}`,
    quoteSymbol,
  };
}

function poolTvlUsd(stats: IconPoolStats, bnusdIsBase: boolean): number | null {
  const bnusdAmount = decimalAmount(
    bnusdIsBase ? stats.base : stats.quote,
    bnusdIsBase ? stats.baseDecimals : stats.quoteDecimals,
  );
  if (bnusdAmount == null) return null;
  const tvlUsd = bnusdAmount * 2;
  return Number.isFinite(tvlUsd) && tvlUsd >= 0 && tvlUsd <= STAGED_POOL_MAX_TVL_USD ? tvlUsd : null;
}

function classifyRpcError(error: unknown): { status: "failure" | "degraded"; retryable?: true } {
  if (error instanceof IconRpcSchemaError || (error instanceof SyntaxError && error.name === "SyntaxError")) {
    return { status: "degraded" };
  }
  return { status: "failure", retryable: true };
}

async function fetchIconRpcBatch(
  requests: readonly IconRpcRequest[],
  context: CrawlStageContext,
): Promise<unknown> {
  const result = await fetchJsonWithRetry<unknown>(
    ICON_RPC_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requests),
      signal: buildStageSignal(context.signal, context.deadlineMs, ICON_BALANCED_RPC_TIMEOUT_MS),
    },
    0,
    {
      timeoutMs: ICON_BALANCED_RPC_TIMEOUT_MS,
      maxResponseBytes: ICON_BALANCED_MAX_RESPONSE_BYTES,
      throwOnFinalNetworkError: true,
    },
  );
  if (!result) throw new Error("ICON RPC returned no response");
  return result.body;
}

function stagePool(stats: IconPoolStats, blockHeight: number, context: CrawlStageContext): boolean {
  const bnusdIsBase = stats.baseToken.toLowerCase() === BNUSD_ADDRESS;
  const bnusdIsQuote = stats.quoteToken.toLowerCase() === BNUSD_ADDRESS;
  if (bnusdIsBase === bnusdIsQuote) return false;

  const { symbol, quoteSymbol } = poolSymbol(stats, bnusdIsBase);
  const poolId = `icon:balanced:${stats.poolId}`;
  if (context.hasKnownPool(poolId)) return true;
  const snapshot: IconPoolSnapshot = {
    poolId: stats.poolId,
    blockHeight,
    stats: stats.raw,
  };
  context.addPool(
    toStagedPool(context, {
      poolId,
      source: ICON_BALANCED_SOURCE,
      chain: "icon",
      protocol: "balanced-dex",
      dexId: "balanced-dex",
      symbol,
      tvlUsd: poolTvlUsd(stats, bnusdIsBase),
      volume24h: null,
      qualityMultiplier: null,
      poolType: "balanced-constant-product",
      feeTier: null,
      balanceRatio: null,
      isStable: null,
      baseToken: stats.baseToken,
      quoteToken: stats.quoteToken,
      quoteSymbol,
      priceUsd: null,
      lockedLiqPct: null,
      rawJson: JSON.stringify(snapshot),
    }),
  );
  return true;
}

function buildStatsRequests(
  ids: readonly number[],
  blockHeight: number,
  nextId: { value: number },
): Array<{ poolId: number; request: IconRpcRequest }> {
  return ids.map((poolId) => ({
    poolId,
    request: balancedCall(nextId.value++, blockHeight, "getPoolStats", { _id: `0x${poolId.toString(16)}` }),
  }));
}

export interface IconBalancedPoolsStageResult {
  providerChecks: DexDeploymentProviderCheck[];
  stoppedEarly?: boolean;
}

export async function crawlIconBalancedPoolsStage(input: {
  coinTargets: ContractDeployment[];
  context: CrawlStageContext;
}): Promise<IconBalancedPoolsStageResult> {
  const providerChecks: DexDeploymentProviderCheck[] = [];
  const targets = input.coinTargets.filter(({ chain, address }) =>
    isIconBalancedDiscoveryDeployment(chain, address),
  );
  if (targets.length === 0 || input.context.timeExceeded()) return { providerChecks };

  for (const target of targets) {
    if (input.context.timeExceeded()) return { providerChecks, stoppedEarly: true };
    let schemaDegraded = false;
    let transportFailure = false;
    let nonce: number | null = null;
    let blockHeight: number | null = null;
    let observedPoolCount = 0;
    const statsById = new Map<number, IconRpcResponse | undefined>();

    try {
      const headBody = await fetchIconRpcBatch(
        [rpcRequest(1, "icx_getLastBlock")],
        input.context,
      );
      const head = parseBatchResult(headBody, [1]);
      schemaDegraded ||= head.schemaDegraded;
      const headResponse = head.responses.get(1);
      if (isErrorResponse(headResponse) || !isRecord(headResponse?.result)) {
        throw new IconRpcSchemaError("ICON RPC returned no last-block result");
      }
      blockHeight = parsePositiveInteger(headResponse.result.height);
      if (blockHeight == null) throw new IconRpcSchemaError("ICON RPC returned an invalid block height");

      const nextId = { value: 2 };
      const nonceRequest = balancedCall(nextId.value++, blockHeight, "getNonce");
      const firstStats = buildStatsRequests(
        Array.from({ length: ICON_BALANCED_MAX_BATCH_SIZE - 1 }, (_, index) => index + 2),
        blockHeight,
        nextId,
      );
      const firstBatch = [
        nonceRequest,
        ...firstStats.map(({ request }) => request),
      ];
      const firstBody = await fetchIconRpcBatch(firstBatch, input.context);
      const firstResult = parseBatchResult(firstBody, firstBatch.map((request) => request.id));
      schemaDegraded ||= firstResult.schemaDegraded;
      const nonceResponse = firstResult.responses.get(2);
      if (isErrorResponse(nonceResponse)) throw new IconRpcSchemaError("Balanced getNonce failed");
      nonce = parsePositiveInteger(nonceResponse?.result);
      if (nonce == null) throw new IconRpcSchemaError("Balanced getNonce returned an invalid nonce");
      for (const { poolId, request } of firstStats) {
        statsById.set(poolId, firstResult.responses.get(request.id));
      }

      const maxQueriedPoolId = Math.min(nonce - 1, ICON_BALANCED_MAX_POOL_ID);
      const remainingIds = maxQueriedPoolId >= ICON_BALANCED_MAX_BATCH_SIZE + 1
        ? Array.from(
            { length: maxQueriedPoolId - ICON_BALANCED_MAX_BATCH_SIZE },
            (_, index) => index + ICON_BALANCED_MAX_BATCH_SIZE + 1,
          )
        : [];
      for (let offset = 0; offset < remainingIds.length; offset += ICON_BALANCED_MAX_BATCH_SIZE) {
        if (input.context.timeExceeded()) return { providerChecks, stoppedEarly: true };
        const requests = buildStatsRequests(
          remainingIds.slice(offset, offset + ICON_BALANCED_MAX_BATCH_SIZE),
          blockHeight,
          nextId,
        );
        const body = await fetchIconRpcBatch(
          requests.map(({ request }) => request),
          input.context,
        );
        const result = parseBatchResult(body, requests.map(({ request }) => request.id));
        schemaDegraded ||= result.schemaDegraded;
        for (const { poolId, request } of requests) {
          statsById.set(poolId, result.responses.get(request.id));
        }
      }
    } catch (error) {
      if (input.context.signal?.aborted) throw error;
      const classification = classifyRpcError(error);
      transportFailure = classification.status === "failure";
      schemaDegraded ||= classification.status === "degraded";
    }

    if (nonce != null && blockHeight != null) {
      for (const [poolId, response] of statsById) {
        if (poolId >= nonce || isErrorResponse(response)) {
          if (poolId < nonce) schemaDegraded = true;
          continue;
        }
        try {
          const stats = parsePoolStats(poolId, response);
          if (stats && stagePool(stats, blockHeight, input.context)) observedPoolCount += 1;
        } catch (error) {
          if (error instanceof IconRpcSchemaError) {
            schemaDegraded = true;
            continue;
          }
          throw error;
        }
      }
    }

    const censusComplete =
      nonce != null
      && blockHeight != null
      && nonce - 1 <= ICON_BALANCED_MAX_POOL_ID
      && !transportFailure
      && !schemaDegraded;
    providerChecks.push({
      chain: target.chain,
      address: target.address,
      provider: ICON_BALANCED_PROVIDER,
      ...(censusComplete
        ? { status: "success" as const, observedPoolCount }
        : transportFailure
          ? { status: "failure" as const, retryable: true as const }
          : { status: "degraded" as const }),
    });
  }

  return { providerChecks };
}
