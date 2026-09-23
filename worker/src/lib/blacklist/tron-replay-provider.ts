import { fetchJsonWithRetry } from "../fetch-retry";
import { logWorkerEventArgs } from "../structured-log";
import { rethrowIfAborted } from "../abort";
import { budgetExhausted, type RateLimitedFetch } from "../evm-logs";
import type { SubrequestBudget } from "../evm-logs";
import {
  TronBlockHeaderSchema,
  TronTransactionInfoSchema,
  TronTrc20HistorySchema,
  TronTriggerConstantContractSchema,
} from "../external-api-schemas";
import type { BlacklistRecoveryErrorClass } from "./amount-recovery";

export const TRONGRID_ORIGIN = "https://api.trongrid.io";
const MAX_TRC20_PAGINATION_URL_LENGTH = 4_096;
const TRC20_PAGE_LIMIT = 200;
const TRON_REPLAY_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const BALANCE_OF_SELECTOR = "balanceOf(address)";

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
  /**
   * Pages actually requested, including pages that failed or were rejected.
   * Callers meter the run's page budget from this counter so a row that burns
   * requests without resolving still counts against it.
   */
  pagesFetched: { count: number };
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
  /** Provider transaction identity; no log index exists, so dedupe uses the full composite below. */
  transactionId: string;
  timestampMs: number;
  from: string;
  to: string;
  value: bigint;
}

export interface TronTransferWindow {
  transfers: TronTrc20Transfer[];
  watermarkMs: number;
  /** False when pagination was cut short by the page cap or the run window. */
  complete: boolean;
  /** True when the run window closed mid-pagination rather than the ledger being longer than the cap. */
  stopped: boolean;
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
    const result = await ctx.limiter(() =>
      fetchJsonWithRetry(
        options.url,
        {
          ...options.init,
          headers: { ...providerHeaders(ctx.apiKey), ...(options.init?.headers ?? {}) },
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        },
        2,
        // The body reader keeps the per-request timeout alive until the payload
        // is fully consumed, so a stalled TronGrid body cannot outlive the
        // request deadline and fall through to the cron's outer signal.
        // Without the final response a retry-exhausted 429/5xx is indistinguishable
        // from a transport failure, and operators cannot tell a rate limit from an outage.
        { returnFinalResponse: true, logUrl: options.label, maxResponseBytes: TRON_REPLAY_MAX_RESPONSE_BYTES },
      ),
    );
    if (!result) throw new TronReplayProviderError("provider_timeout", `${options.label} transport failure`);
    if (!result.response.ok) {
      throw new TronReplayProviderError("provider_http_error", `${options.label} HTTP ${result.response.status}`);
    }
    return result.body as T;
  } catch (error) {
    rethrowIfAborted(error, ctx.signal);
    if (error instanceof TronReplayProviderError) throw error;
    logWorkerEventArgs("lib", "warn", `[sync-blacklist] ${options.label} failed:`, error);
    throw new TronReplayProviderError("provider_null", options.failed);
  }
}

/**
 * Reads the solidified head, which is the only state the confirmed-history API
 * and the solidified balance read can be compared against. `getblock` with
 * `detail: false` returns just the header, so a per-row head read costs ~0.5 KB
 * instead of the ~300 KB full block.
 */
export async function fetchTronHeadBlock(ctx: TronReplayProviderContext): Promise<TronHeadBlock> {
  const body = await readTronJson<unknown>(ctx, {
    url: `${TRONGRID_ORIGIN}/walletsolidity/getblock`,
    init: { method: "POST", body: JSON.stringify({ detail: false }) },
    label: "tron-solidified-head",
    failed: "head block unreadable",
  });
  const parsed = TronBlockHeaderSchema.safeParse(body);
  if (!parsed.success) throw new TronReplayProviderError("provider_null", "head block payload invalid");
  return {
    blockId: parsed.data.blockID.toLowerCase(),
    blockNumber: parsed.data.block_header.raw_data.number,
    timestampMs: parsed.data.block_header.raw_data.timestamp,
  };
}

/**
 * Raw token balance from a solidified constant call. 0x41-prefixed base58-free
 * form matches the operator evidence contract, and the result is a bare
 * 64-hex word rather than a JSON-RPC quantity.
 */
export async function fetchTronRawTokenBalance(
  ctx: TronReplayProviderContext,
  tokenHex: string,
  addressHex: string,
): Promise<bigint> {
  const body = await readTronJson<unknown>(ctx, {
    url: `${TRONGRID_ORIGIN}/walletsolidity/triggerconstantcontract`,
    init: {
      method: "POST",
      body: JSON.stringify({
        owner_address: `41${addressHex.slice(2)}`,
        contract_address: `41${tokenHex.slice(2)}`,
        function_selector: BALANCE_OF_SELECTOR,
        parameter: addressHex.slice(2).padStart(64, "0"),
        visible: false,
      }),
    },
    label: "tron-solidified-balance",
    failed: "balanceOf result missing",
  });
  const parsed = TronTriggerConstantContractSchema.safeParse(body);
  if (!parsed.success || parsed.data.result?.result !== true) {
    throw new TronReplayProviderError("provider_null", "balanceOf call did not succeed");
  }
  const word = parsed.data.constant_result?.[0];
  if (!word) throw new TronReplayProviderError("provider_null", "balanceOf result invalid");
  return BigInt(`0x${word.replace(/^0x/i, "")}`);
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

function toPrefixedLowerHex(value: string): string {
  const bare = value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
  return `0x${bare.toLowerCase()}`;
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
 * `complete: false` unless pagination ends without a fingerprint, so an
 * unresolved amount can never be derived from a partially paginated history.
 * Every requested page is counted on `ctx.pagesFetched`, including pages that
 * fail, so the caller's per-run page budget covers unproductive requests too.
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
  while (next != null && pages < Math.max(1, maxPages)) {
    if (ctx.shouldStop?.()) {
      return { transfers, watermarkMs, complete: false, stopped: true };
    }
    const validated = validateTronTransferPaginationUrl(next, contractBase58, windowStartMs, windowEndMs);
    if (!validated) throw new TronReplayProviderError("provider_null", "pagination URL rejected");
    ctx.pagesFetched.count++;
    pages++;
    const body = await readTronJson<unknown>(ctx, {
      url: validated,
      label: "tron-transfer-window",
      failed: "transfer window unreadable",
    });
    const parsed = TronTrc20HistorySchema.safeParse(body);
    if (!parsed.success) throw new TronReplayProviderError("provider_null", "transfer window payload invalid");
    const meta = parsed.data.meta;
    if (!meta) throw new TronReplayProviderError("provider_null", "transfer window watermark missing");
    watermarkMs = Math.max(watermarkMs, meta.at);
    for (const transfer of parsed.data.data) {
      if (transfer.type !== "Transfer") continue;
      transfers.push({
        transactionId: transfer.transaction_id,
        timestampMs: transfer.block_timestamp,
        from: transfer.from,
        to: transfer.to,
        value: BigInt(transfer.value),
      });
    }
    next = meta.links?.next ?? null;
  }
  return { transfers, watermarkMs, complete: next == null, stopped: false };
}
