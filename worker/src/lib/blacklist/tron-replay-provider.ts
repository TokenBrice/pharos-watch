import { z } from "zod";
import { tronBase58ToHex, tronHexAddressToBase58 } from "../tron-address";
import { fetchJsonWithRetry } from "../fetch-retry";
import { logWorkerEventArgs } from "../structured-log";
import { rethrowIfAborted } from "../abort";
import { budgetExhausted, type RateLimitedFetch } from "../evm-logs";
import type { SubrequestBudget } from "../evm-logs";
import {
  TronBlockHeaderSchema,
  TronEventsResponseSchema,
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

/** Canonical confirmed block-array order, never explorer event or hash order. */
export async function fetchTronBlockTransactionPositions(
  ctx: TronReplayProviderContext,
  blockNumber: number,
): Promise<{ timestamp: number; positions: ReadonlyMap<string, number> }> {
  const body = await readTronJson<{
    block_header?: { raw_data?: { number?: number; timestamp?: number } };
    transactions?: { txID?: string }[];
  }>(ctx, {
    url: `${TRONGRID_ORIGIN}/walletsolidity/getblockbynum`,
    init: { method: "POST", body: JSON.stringify({ num: blockNumber }) },
    label: "tron-confirmed-block-order",
    failed: "confirmed block order unreadable",
  });
  const header = body?.block_header?.raw_data;
  if (header?.number !== blockNumber || !Number.isSafeInteger(header.timestamp)
    || !Array.isArray(body.transactions)) {
    throw new TronReplayProviderError("provider_null", "confirmed block order payload invalid");
  }
  const positions = new Map<string, number>();
  for (const [index, transaction] of body.transactions.entries()) {
    if (typeof transaction?.txID !== "string" || !/^[0-9a-f]{64}$/i.test(transaction.txID)
      || positions.has(transaction.txID.toLowerCase())) {
      throw new TronReplayProviderError("provider_null", "confirmed block transaction identity invalid");
    }
    positions.set(transaction.txID.toLowerCase(), index);
  }
  return { timestamp: Math.floor(header.timestamp! / 1000), positions };
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

const DestroyWindowSchema = TronEventsResponseSchema.extend({
  success: z.literal(true),
  meta: z.object({
    at: z.number().int().nonnegative(),
    links: z.object({ next: z.string().optional() }).optional(),
  }),
});

export interface TronDestroyWindowObservation {
  urls: string[];
  watermarkMs: number | null;
  pagesFetched: number;
  outcome: "clear" | "evidence_mismatch" | "state_raced" | "runtime_budget";
}

export interface TronDestroyWindowResult {
  outcome: TronDestroyWindowObservation["outcome"];
  observation: TronDestroyWindowObservation;
  /** Distinguishes truncated evidence from a positively observed matching destroy. */
  capExceeded?: true;
}

/** A bounded, complete confirmed destroy-event window; partial pages never prove absence. */
export async function fetchTronDestroyWindowClear(
  ctx: TronReplayProviderContext,
  contractAddress: string,
  accountBase58: string,
  events: readonly { signature: string; tronResultKey?: string }[],
  fromMs: number,
  throughMs: number,
  maxPages = 40,
): Promise<TronDestroyWindowResult> {
  const observation: TronDestroyWindowObservation = {
    urls: [], watermarkMs: null, pagesFetched: 0, outcome: "evidence_mismatch",
  };
  const finish = (outcome: TronDestroyWindowObservation["outcome"]): TronDestroyWindowResult => {
    observation.outcome = outcome;
    return { outcome, observation };
  };
  if (ctx.shouldStop?.()) return finish("runtime_budget");
  if (events.length === 0) {
    throw new TronReplayProviderError("provider_null", "destroy event configuration missing");
  }
  for (const eventConfig of events) {
    const eventName = eventConfig.signature.split("(")[0]!;
    const initial = new URL(`${TRONGRID_ORIGIN}/v1/contracts/${contractAddress}/events`);
    for (const [key, value] of Object.entries({
      event_name: eventName, only_confirmed: "true", min_timestamp: String(fromMs),
      max_timestamp: String(throughMs), order_by: "block_timestamp,asc", limit: "200",
    })) initial.searchParams.set(key, value);
    let next: string | undefined = initial.toString();
    while (next) {
      if (ctx.shouldStop?.()) return finish("runtime_budget");
      if (observation.pagesFetched >= Math.min(maxPages, 40)) {
        return { ...finish("evidence_mismatch"), capExceeded: true };
      }
      // A rejected hop consumes the window budget as well, but never opens a connection.
      ctx.pagesFetched.count++;
      observation.pagesFetched++;
      let url: URL;
      try {
        if (next.length > MAX_TRC20_PAGINATION_URL_LENGTH) throw new Error("URL too long");
        url = new URL(next);
        if (url.origin !== initial.origin || url.pathname !== initial.pathname ||
            url.username !== "" || url.password !== "" || url.hash !== "" ||
            [...initial.searchParams].some(([key, value]) => url.searchParams.get(key) !== value) ||
            [...url.searchParams.keys()].some((key) =>
              (!initial.searchParams.has(key) && key !== "fingerprint") || url.searchParams.getAll(key).length !== 1)) {
          throw new Error("changed destroy window");
        }
      } catch {
        throw new TronReplayProviderError("provider_null", "destroy pagination URL rejected");
      }
      observation.urls.push(url.toString());
      const parsed = DestroyWindowSchema.safeParse(await readTronJson<unknown>(ctx, {
        url: url.toString(), label: "tron-destroy-window", failed: "destroy window unreadable",
      }));
      if (!parsed.success) throw new TronReplayProviderError("provider_null", "destroy window payload invalid");
      observation.watermarkMs = Math.min(observation.watermarkMs ?? Infinity, parsed.data.meta.at);
      if (parsed.data.meta.at < throughMs) return finish("state_raced");
      for (const event of parsed.data.data) {
        if (event.event_name !== eventName || event.block_timestamp < fromMs ||
            event.block_timestamp > throughMs) {
          throw new TronReplayProviderError("provider_null", "destroy event outside requested window");
        }
        const rawAddress = eventConfig.tronResultKey
          ? event.result[eventConfig.tronResultKey]
          : event.result._blackListedUser ?? event.result._user ?? event.result["0"];
        if (typeof rawAddress !== "string" || !rawAddress) {
          throw new TronReplayProviderError("provider_null", "destroy victim missing or invalid");
        }
        const hexAddress = rawAddress.replace(/^0x(?=41[0-9a-f]{40}$)/i, "");
        const address = rawAddress.startsWith("T")
          ? await tronBase58ToHex(rawAddress) ? rawAddress : null
          : await tronHexAddressToBase58(/^[0-9a-f]{40}$/i.test(hexAddress) ? `0x${hexAddress}` : hexAddress);
        if (!address) throw new TronReplayProviderError("provider_null", "destroy victim invalid");
        if (address === accountBase58) return finish("evidence_mismatch");
      }
      next = parsed.data.meta.links?.next;
      // A full page without a continuation is not proof that the provider exhausted history.
      if (!next && parsed.data.data.length >= TRC20_PAGE_LIMIT) {
        throw new TronReplayProviderError("provider_null", "full destroy page missing continuation");
      }
    }
  }
  return finish("clear");
}
