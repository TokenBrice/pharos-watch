import { fetchJsonWithRetry } from "../fetch-retry";
import { logWorkerEventArgs } from "../structured-log";
import { rethrowIfAborted } from "../abort";
import { budgetExhausted, type RateLimitedFetch } from "../evm-logs";
import type { SubrequestBudget } from "../evm-logs";
import {
  TronNowBlockSchema,
  TronTransactionInfoSchema,
  TronTrc20HistorySchema,
} from "../external-api-schemas";
import { parseQuantityHex } from "../bigint";
import { encodeBalanceOfCallData } from "../evm-selectors";
import type { BlacklistRecoveryErrorClass } from "./amount-recovery";

export const TRONGRID_ORIGIN = "https://api.trongrid.io";
const MAX_TRC20_PAGINATION_URL_LENGTH = 4_096;
const TRC20_PAGE_LIMIT = 200;

// Mirrors the scan lane's pagination guard: a fingerprint may advance the page,
// but every filter that bounds the evidence must survive each hop unchanged.
const TRC20_WINDOW_PARAMS = [
  "only_confirmed",
  "contract_address",
  "min_timestamp",
  "max_timestamp",
  "order_by",
  "limit",
  "fingerprint",
] as const;

export interface TronReplayProviderContext {
  apiKey: string | null;
  limiter: RateLimitedFetch;
  budget: SubrequestBudget;
  signal?: AbortSignal;
  /** Lets a caller stop pagination mid-window when its run window has closed. */
  shouldStop?: () => boolean;
}

export interface TronHeadBlock {
  blockId: string;
  blockNumber: number;
  timestampMs: number;
}

export interface TronTransactionInfo {
  blockNumber: number;
  timestampMs: number;
  succeeded: boolean;
  logs: ReadonlyArray<{ address: string; topics: readonly string[] }>;
}

export interface TronTrc20Transfer {
  timestampMs: number;
  from: string;
  to: string;
  value: bigint;
}

export interface TronTransferWindow {
  transfers: TronTrc20Transfer[];
  watermarkMs: number;
  complete: boolean;
  pages: number;
}

/** Provider-shaped failure that callers classify into amount-recovery error classes. */
export class TronReplayProviderError extends Error {
  constructor(
    readonly errorClass: Extract<
      BlacklistRecoveryErrorClass,
      "provider_null" | "provider_timeout" | "provider_http_error" | "budget_exhausted"
    >,
    message: string,
  ) {
    super(message);
    this.name = "TronReplayProviderError";
  }
}

function providerHeaders(apiKey: string | null): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["TRON-PRO-API-KEY"] = apiKey;
  return headers;
}

async function readTronJson<T>(
  ctx: TronReplayProviderContext,
  options: { url: string; init?: RequestInit; label: string; failed: string },
): Promise<T> {
  if (budgetExhausted(ctx.budget)) {
    throw new TronReplayProviderError("budget_exhausted", `${options.label} skipped: subrequest budget exhausted`);
  }
  ctx.budget.count++;
  try {
    const result = await ctx.limiter(async () => {
      const response = await fetchJsonWithRetry<T>(options.url, {
        ...options.init,
        headers: { ...providerHeaders(ctx.apiKey), ...(options.init?.headers ?? {}) },
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      if (!response) throw new TronReplayProviderError("provider_timeout", `${options.label} transport failure`);
      if (!response.response.ok) {
        throw new TronReplayProviderError("provider_http_error", `${options.label} HTTP ${response.response.status}`);
      }
      return response.body;
    });
    if (result == null) throw new TronReplayProviderError("provider_null", options.failed);
    return result;
  } catch (error) {
    rethrowIfAborted(error, ctx.signal);
    if (error instanceof TronReplayProviderError) throw error;
    logWorkerEventArgs("lib", "warn", `[sync-blacklist] ${options.label} failed:`, error);
    throw new TronReplayProviderError("provider_null", options.failed);
  }
}

export async function fetchTronHeadBlock(ctx: TronReplayProviderContext): Promise<TronHeadBlock> {
  const body = await readTronJson<unknown>(ctx, {
    url: `${TRONGRID_ORIGIN}/wallet/getnowblock`,
    init: { method: "POST", body: "{}" },
    label: "tron-head-block",
    failed: "head block unreadable",
  });
  const parsed = TronNowBlockSchema.safeParse(body);
  if (!parsed.success) throw new TronReplayProviderError("provider_null", "head block payload invalid");
  return {
    blockId: parsed.data.blockID.toLowerCase(),
    blockNumber: parsed.data.block_header.raw_data.number,
    timestampMs: parsed.data.block_header.raw_data.timestamp,
  };
}

export async function fetchTronRawTokenBalance(
  ctx: TronReplayProviderContext,
  tokenHex: string,
  addressHex: string,
): Promise<bigint> {
  const body = await readTronJson<{ result?: unknown }>(ctx, {
    url: `${TRONGRID_ORIGIN}/jsonrpc`,
    init: {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: tokenHex, data: encodeBalanceOfCallData(addressHex) }, "latest"],
      }),
    },
    label: "tron-raw-balance",
    failed: "balanceOf result missing",
  });
  const value = parseQuantityHex(body.result);
  if (value == null) throw new TronReplayProviderError("provider_null", "balanceOf result invalid");
  return value;
}

function toPrefixedLowerHex(value: string): string {
  const bare = value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
  return `0x${bare.toLowerCase()}`;
}

export async function fetchTronTransactionInfo(
  ctx: TronReplayProviderContext,
  txHash: string,
): Promise<TronTransactionInfo> {
  const body = await readTronJson<unknown>(ctx, {
    url: `${TRONGRID_ORIGIN}/wallet/gettransactioninfobyid`,
    init: { method: "POST", body: JSON.stringify({ value: txHash }) },
    label: "tron-transaction-info",
    failed: "transaction info unreadable",
  });
  const parsed = TronTransactionInfoSchema.safeParse(body);
  if (!parsed.success || parsed.data.id.toLowerCase() !== txHash.toLowerCase()) {
    throw new TronReplayProviderError("provider_null", "transaction info payload mismatch");
  }
  return {
    blockNumber: parsed.data.blockNumber,
    timestampMs: parsed.data.blockTimeStamp,
    succeeded: parsed.data.receipt?.result === "SUCCESS",
    logs: (parsed.data.log ?? []).map((log) => ({
      address: toPrefixedLowerHex(log.address),
      topics: log.topics.map(toPrefixedLowerHex),
    })),
  };
}

export function validateTronTransferPaginationUrl(
  candidate: string,
  contractAddress: string,
  windowStartMs: number,
  windowEndMs: number,
): string | null {
  if (candidate.length === 0 || candidate.length > MAX_TRC20_PAGINATION_URL_LENGTH) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" || url.origin !== TRONGRID_ORIGIN || url.username !== "" || url.password !== "" || url.hash !== "") {
      return null;
    }
    if (!url.pathname.startsWith("/v1/accounts/") || !url.pathname.endsWith("/transactions/trc20")) return null;
    if (url.searchParams.get("only_confirmed") !== "true") return null;
    if (url.searchParams.get("contract_address") !== contractAddress) return null;
    if (url.searchParams.get("min_timestamp") !== String(windowStartMs)) return null;
    if (url.searchParams.get("max_timestamp") !== String(windowEndMs)) return null;
    if (url.searchParams.get("order_by") !== "block_timestamp,asc") return null;
    if (url.searchParams.get("limit") !== String(TRC20_PAGE_LIMIT)) return null;
    if (![...url.searchParams.keys()].every((key) => (TRC20_WINDOW_PARAMS as readonly string[]).includes(key))) return null;
    if (![...url.searchParams.keys()].every((key) => url.searchParams.getAll(key).length === 1)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Reads every confirmed TRC20 transfer for one account in `[windowStartMs, windowEndMs]`.
 *
 * The window is an evidence bound, not a convenience filter: callers receive
 * `complete: false` unless pagination ends with a fingerprint and the indexer
 * watermark proves the window is not still filling in, so an unresolved amount
 * can never be derived from a partially paginated history.
 */
export async function fetchTronTransferWindow(
  ctx: TronReplayProviderContext,
  accountBase58: string,
  contractBase58: string,
  windowStartMs: number,
  windowEndMs: number,
  maxPages: number,
): Promise<TronTransferWindow> {
  const initial = new URL(`/v1/accounts/${accountBase58}/transactions/trc20`, TRONGRID_ORIGIN);
  initial.searchParams.set("only_confirmed", "true");
  initial.searchParams.set("contract_address", contractBase58);
  initial.searchParams.set("min_timestamp", String(windowStartMs));
  initial.searchParams.set("max_timestamp", String(windowEndMs));
  initial.searchParams.set("order_by", "block_timestamp,asc");
  initial.searchParams.set("limit", String(TRC20_PAGE_LIMIT));

  const transfers: TronTrc20Transfer[] = [];
  let watermarkMs = 0;
  let pages = 0;
  let next: string | null = initial.toString();
  for (let page = 0; page < maxPages; page++) {
    if (next == null) return { transfers, watermarkMs, complete: true, pages };
    if (ctx.shouldStop?.()) return { transfers, watermarkMs, complete: false, pages };
    const validated = validateTronTransferPaginationUrl(next, contractBase58, windowStartMs, windowEndMs);
    if (!validated) throw new TronReplayProviderError("provider_null", "pagination URL rejected");
    const body = await readTronJson<unknown>(ctx, {
      url: validated,
      label: "tron-transfer-window",
      failed: "transfer window unreadable",
    });
    pages++;
    const parsed = TronTrc20HistorySchema.safeParse(body);
    if (!parsed.success) throw new TronReplayProviderError("provider_null", "transfer window payload invalid");
    const meta = parsed.data.meta;
    if (!meta) throw new TronReplayProviderError("provider_null", "transfer window watermark missing");
    watermarkMs = Math.max(watermarkMs, meta.at);
    for (const transfer of parsed.data.data) {
      if (transfer.type !== "Transfer") continue;
      transfers.push({
        timestampMs: transfer.block_timestamp,
        from: transfer.from,
        to: transfer.to,
        value: BigInt(transfer.value),
      });
    }
    next = meta.links?.next ?? null;
  }
  return { transfers, watermarkMs, complete: next == null, pages };
}
