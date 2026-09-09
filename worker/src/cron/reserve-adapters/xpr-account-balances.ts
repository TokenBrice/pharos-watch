import {
  parseLiveReserveAdapterParams,
  type LiveReserveAdapterParamsByKey,
} from "@shared/lib/live-reserve-adapters";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import {
  buildUnknownExposureWarning,
  computeUnknownExposurePct,
  isHttpJsonInput,
  notApplicableFreshnessMetadata,
  requireJsonInput,
  reserveInfoWarning,
  slicesFromValues,
} from "./helpers";
import { fetchJsonPostWithRetry } from "./request";
import type { AdapterContext, AdapterResult } from "./types";

const ADAPTER_KEY = "xpr-account-balances";
const CHAIN_API_PATH = "/v1/chain";
const REQUEST_TIMEOUT_MS = 10_000;
/** Antelope asset string, e.g. "2993273.977086 XUSDC". */
// eslint-disable-next-line security/detect-unsafe-regex -- anchored fixed-shape asset check; disjoint character classes leave no backtracking ambiguity.
const ASSET_STRING_RE = /^([0-9]+(?:\.[0-9]+)?)\s+([A-Za-z][A-Za-z0-9.]*)$/;

type XprAccountBalancesParams = LiveReserveAdapterParamsByKey[typeof ADAPTER_KEY];

interface XprChainInfoPayload {
  chain_id?: unknown;
  head_block_num?: unknown;
  head_block_id?: unknown;
  head_block_time?: unknown;
}

interface XprReadBatch {
  chainInfo: {
    chainId: string;
    headBlockNum: number;
    headBlockId: string;
    headBlockTime: string;
  };
  supplyTokens: number;
  balances: Map<string, number>;
}

function endpoint(baseUrl: string, action: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${CHAIN_API_PATH}/${action}`;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${ADAPTER_KEY}: ${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${ADAPTER_KEY}: ${label} is missing or not a non-empty string`);
  }
  return value;
}

function requireHeadBlockNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${ADAPTER_KEY}: head_block_num is not a non-negative integer`);
  }
  return value;
}

function parseAssetAmount(value: unknown, label: string): { amount: number; symbol: string } {
  if (typeof value !== "string") {
    throw new Error(`${ADAPTER_KEY}: ${label} is not an asset string`);
  }
  const match = ASSET_STRING_RE.exec(value.trim());
  if (!match) {
    throw new Error(`${ADAPTER_KEY}: malformed ${label} asset string "${value}"`);
  }
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(`${ADAPTER_KEY}: ${label} amount is not finite and non-negative`);
  }
  return { amount, symbol: match[2]! };
}

/**
 * One endpoint's worth of reads: head info, the token supply, and the
 * treasury account's balances. All three must succeed on the same node so the
 * snapshot is internally consistent; the caller fails over to the next node
 * on any error.
 */
async function readBatch(
  baseUrl: string,
  params: XprAccountBalancesParams,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<XprReadBatch> {
  const [infoPayload, statsPayload, balancesPayload] = await Promise.all([
    fetchJsonPostWithRetry<XprChainInfoPayload>(
      endpoint(baseUrl, "get_info"),
      {},
      signal,
      REQUEST_TIMEOUT_MS,
      ctx,
    ),
    fetchJsonPostWithRetry<Record<string, unknown>>(
      endpoint(baseUrl, "get_currency_stats"),
      { code: params.supplyCode, symbol: params.supplySymbol },
      signal,
      REQUEST_TIMEOUT_MS,
      ctx,
    ),
    fetchJsonPostWithRetry<unknown[]>(
      endpoint(baseUrl, "get_currency_balance"),
      { code: params.balanceCode, account: params.treasuryAccount },
      signal,
      REQUEST_TIMEOUT_MS,
      ctx,
    ),
  ]);

  const chainInfo = {
    chainId: requireString(infoPayload.chain_id, "chain_id"),
    headBlockNum: requireHeadBlockNumber(infoPayload.head_block_num),
    headBlockId: requireString(infoPayload.head_block_id, "head_block_id"),
    headBlockTime: requireString(infoPayload.head_block_time, "head_block_time"),
  };

  const stats = requireRecord(statsPayload[params.supplySymbol], `currency stats for ${params.supplySymbol}`);
  const supply = parseAssetAmount(stats.supply, `${params.supplySymbol} supply`);
  if (supply.symbol !== params.supplySymbol) {
    throw new Error(
      `${ADAPTER_KEY}: supply symbol mismatch (expected ${params.supplySymbol}, got ${supply.symbol})`,
    );
  }

  if (!Array.isArray(balancesPayload)) {
    throw new Error(`${ADAPTER_KEY}: get_currency_balance response is not an array`);
  }
  const balances = new Map<string, number>();
  for (const entry of balancesPayload) {
    const parsed = parseAssetAmount(entry, "account balance");
    balances.set(parsed.symbol, (balances.get(parsed.symbol) ?? 0) + parsed.amount);
  }

  return { chainInfo, supplyTokens: supply.amount, balances };
}

function adaptBatch(batch: XprReadBatch, params: XprAccountBalancesParams): AdapterResult {
  const warnings: LiveReserveWarning[] = [];
  const measured = params.slices.map((slice) => {
    const amount = batch.balances.get(slice.symbol);
    if (amount === undefined) {
      throw new Error(
        `${ADAPTER_KEY}: configured slice symbol ${slice.symbol} missing from ${params.balanceCode} balances of ${params.treasuryAccount}`,
      );
    }
    return { ...slice, value: amount };
  });

  const holdings = measured.reduce((sum, entry) => sum + entry.value, 0);
  const supply = batch.supplyTokens;
  if (!Number.isFinite(holdings)) {
    throw new Error(`${ADAPTER_KEY}: measured holdings are not finite`);
  }
  if (!(supply > 0)) {
    throw new Error(`${ADAPTER_KEY}: ${params.supplySymbol} supply must be positive`);
  }

  const uncovered = Math.max(0, supply - holdings);
  const unknownExposurePct = computeUnknownExposurePct(uncovered, supply);
  const collateralizationRatio = holdings / supply;

  // XPR X-tokens are issuer-custodial bridge wrappers (e.g. Metallicus's
  // Metal X bridge) whose 1:1 upstream backing is not independently published,
  // so measured slices deliberately carry no coinId dependency link.
  warnings.push(reserveInfoWarning(
    "bridge-wrapper-unverified",
    `${ADAPTER_KEY}: ${measured.map((entry) => entry.symbol).join(", ")} are bridge wrappers on ${params.balanceCode} whose upstream 1:1 backing is not independently published; slices carry no coinId dependency link`,
  ));

  if (uncovered > 0) {
    warnings.push(buildUnknownExposureWarning({
      code: "xpr-unmeasured-treasury",
      message: `${ADAPTER_KEY}: ${params.supplySymbol} supply not covered by measured ${params.balanceCode} balances of ${params.treasuryAccount}`,
      unknownExposurePct,
    }));
  }

  const slices = slicesFromValues(
    [
      ...measured.map((entry) => ({
        value: entry.value,
        name: entry.name,
        risk: entry.risk,
        assetClass: "stablecoin" as const,
      })),
      ...(uncovered > 0
        ? [{
            value: uncovered,
            name: params.unknownSlice.name,
            risk: params.unknownSlice.risk,
            assetClass: "other" as const,
          }]
        : []),
    ],
    2,
  );

  return {
    slices,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...notApplicableFreshnessMetadata(),
      supplyTokens: supply,
      supplyUsd: supply,
      totalReserveUsd: holdings,
      ...(unknownExposurePct > 0 ? { unknownExposurePct } : {}),
      collateralizationRatio,
      details: {
        ...batch.chainInfo,
        treasuryAccount: params.treasuryAccount,
        balanceCode: params.balanceCode,
        supplyCode: params.supplyCode,
        supplySymbol: params.supplySymbol,
        measuredHoldingsTokens: holdings,
        uncoveredTokens: uncovered,
        accountBalances: Object.fromEntries(batch.balances),
      },
    },
  };
}

/**
 * Reads a coin's XPR Network (Antelope) reserve directly from the public
 * chain REST API: `get_currency_stats` supplies the token supply and
 * `get_currency_balance` reads the treasury account's token balances,
 * bracketed by `get_info` so every snapshot carries its head block number and
 * time. Emits one slice per configured measured symbol, an explicit unknown
 * slice for any supply remainder, and `collateralizationRatio = holdings /
 * supply` with an honest `unknownExposurePct`. Each configured node is tried
 * in order and the last error is rethrown when every one fails, so a single
 * unhealthy RPC cannot silently truncate the read.
 */
export async function fetchXprAccountBalancesReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireJsonInput(config.inputs.primary, ADAPTER_KEY);
  const params = parseLiveReserveAdapterParams(ADAPTER_KEY, config.params);

  const baseUrls = [
    input.url,
    ...(config.inputs.fallbacks ?? []).filter(isHttpJsonInput).map((fallback) => fallback.url),
  ];

  let lastError: unknown = null;
  for (const baseUrl of baseUrls) {
    try {
      return adaptBatch(await readBatch(baseUrl, params, signal, ctx), params);
    } catch (error) {
      lastError = error;
      if (signal.aborted) break;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
