import { TronEventsResponseSchema } from "../../lib/external-api-schemas";
import type { ContractEventConfig } from "../../lib/blacklist-contracts";
import { getBlacklistEventBySignature } from "../../lib/blacklist-contracts";
import {
  type RateLimitedFetch,
} from "../../lib/evm-logs";
import { fetchJsonWithRetry } from "../../lib/fetch-retry";
import { decimalNumberFromBigInt } from "../../lib/bigint";
import { throwIfAborted } from "../../lib/abort";
import { buildBlacklistRow, type BlacklistRow } from "./shared";
import {
  blacklistRuntimeBudgetReached,
  blacklistSubrequestBudgetReached,
  type BlacklistRunBudget,
} from "./run-budget";

interface TronEventResult {
  block_number: number;
  block_timestamp: number;
  transaction_id: string;
  event_index: number;
  event_name: string;
  result: Record<string, string>;
}

interface TronEventsResponse {
  data: TronEventResult[];
  meta?: { links?: { next?: string } };
  success: boolean;
}

export function parseTronEvent(config: ContractEventConfig, evt: TronEventResult): BlacklistRow | null {
  const eventDef = getBlacklistEventBySignature(config, evt.event_name);
  if (!eventDef) return null;
  const eventType = eventDef.eventType;

  // Fallback chain: tronResultKey override → _user (modern Tether) → _blackListedUser (legacy) → positional "0"
  const affectedAddress = (eventDef.tronResultKey && evt.result[eventDef.tronResultKey])
    || evt.result._user
    || evt.result._blackListedUser
    || evt.result["0"]
    || "";
  const rawAmountStr = evt.result._balance || evt.result._value || evt.result["1"];
  const amount =
    eventDef.hasAmount && rawAmountStr
      ? decimalNumberFromBigInt(BigInt(rawAmountStr), config.decimals)
      : null;
  const timestamp = Math.floor(evt.block_timestamp / 1000);

  return buildBlacklistRow({
    id: `${config.chain.chainId}-${evt.transaction_id}-${evt.event_index}`,
    stablecoin: config.stablecoin,
    chain: config.chain,
    eventType,
    address: affectedAddress,
    amount,
    txHash: evt.transaction_id,
    blockNumber: evt.block_number,
    timestamp,
    contractAddress: config.contractAddress,
    configKey: config.configKey,
    eventSignature: eventDef.signature,
    eventTopic0: null,
  });
}

/**
 * Fetch Tron events incrementally.
 * NOTE: `lastTimestampMs` is a millisecond timestamp stored in `blacklist_sync_state.last_block`.
 */
export async function fetchTronEventsIncremental(
  config: ContractEventConfig,
  apiKey: string | null,
  lastTimestampMs: number,
  runBudget: BlacklistRunBudget,
  rateLimit: RateLimitedFetch,
  signal?: AbortSignal,
): Promise<{ rows: BlacklistRow[]; maxBlock: number; incomplete: boolean; apiError: boolean }> {
  const rows: BlacklistRow[] = [];
  let maxBlock = lastTimestampMs;
  let incomplete = false;
  let apiError = false;
  const headers: Record<string, string> = {};
  if (apiKey) headers["TRON-PRO-API-KEY"] = apiKey;

  for (const eventDef of config.events) {
    throwIfAborted(signal);
    if (blacklistRuntimeBudgetReached(runBudget)) {
      incomplete = true;
      break;
    }
    if (blacklistSubrequestBudgetReached(runBudget)) {
      incomplete = true;
      break;
    }

    const tsFilter = lastTimestampMs > 0 ? `&min_block_timestamp=${lastTimestampMs}` : "";
    const eventName = eventDef.signature.split("(")[0];
    let url: string | null =
      `https://api.trongrid.io/v1/contracts/${config.contractAddress}/events?event_name=${eventName}&limit=200&order_by=block_timestamp,asc${tsFilter}`;

    while (url) {
      throwIfAborted(signal);
      if (blacklistRuntimeBudgetReached(runBudget)) {
        incomplete = true;
        break;
      }
      if (blacklistSubrequestBudgetReached(runBudget)) {
        incomplete = true;
        break;
      }

      runBudget.subrequestBudget.count++;
      const json: TronEventsResponse | null = await rateLimit(async () => {
        const result = await fetchJsonWithRetry<unknown>(url!, { headers, signal });
        if (!result) return null;
        if (!result.response.ok) {
          apiError = true;
          return null;
        }
        const parsed = TronEventsResponseSchema.safeParse(result.body);
        if (!parsed.success) {
          console.warn("[blacklist] TronGrid response validation failed:", parsed.error.message);
          apiError = true;
          return null;
        }
        return parsed.data as TronEventsResponse;
      });

      if (!json?.success || !Array.isArray(json.data)) {
        apiError = true;
        incomplete = true;
        break;
      }

      for (const evt of json.data) {
        const row = parseTronEvent(config, evt);
        if (!row) continue;
        if (evt.block_timestamp > maxBlock) maxBlock = evt.block_timestamp;
        rows.push(row);
      }

      url = json.meta?.links?.next || null;
    }

    if (incomplete || apiError) break;
  }

  return { rows, maxBlock, incomplete, apiError };
}
