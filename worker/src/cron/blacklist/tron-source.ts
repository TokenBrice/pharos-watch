import type { BlacklistEventType } from "@shared/types/market";
import { getBlacklistTrackerMethodologyVersionAt } from "@shared/lib/blacklist-tracker-version";
import { computeBlacklistAmountUsdAtEvent } from "@shared/lib/blacklist";
import { TronEventsResponseSchema } from "../../lib/external-api-schemas";
import type { ContractEventConfig } from "../../lib/blacklist-contracts";
import { getBlacklistEventBySignature } from "../../lib/blacklist-contracts";
import {
  budgetExhausted,
  type RateLimitedFetch,
  type SubrequestBudget,
} from "../../lib/evm-logs";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { bigIntToDecimal } from "../../lib/bigint";
import { throwIfAborted } from "../../lib/abort";
import { buildExplorerAddressUrl, buildExplorerTxUrl, type BlacklistRow } from "./shared";

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

const TRON_EVENT_NAME_MAP: Record<string, BlacklistEventType> = {
  AddedBlackList: "blacklist",
  RemovedBlackList: "unblacklist",
  DestroyedBlackFunds: "destroy",
  Freeze: "blacklist",
  Unfreeze: "unblacklist",
};

function runtimeBudgetReached(deadlineMs: number): boolean {
  return Date.now() >= deadlineMs;
}

function parseTronEvent(config: ContractEventConfig, evt: TronEventResult): BlacklistRow | null {
  const eventDef = getBlacklistEventBySignature(config, evt.event_name);
  const eventType = TRON_EVENT_NAME_MAP[evt.event_name];
  if (!eventDef || !eventType) return null;

  const affectedAddress = (eventDef.tronResultKey && evt.result[eventDef.tronResultKey])
    || evt.result._user
    || evt.result._blackListedUser
    || evt.result["0"]
    || evt.result["1"]
    || "";
  const rawAmountStr = evt.result._balance || evt.result._value || evt.result["1"];
  const amount =
    eventDef.hasAmount && rawAmountStr
      ? bigIntToDecimal(BigInt(rawAmountStr), config.decimals)
      : null;
  const timestamp = Math.floor(evt.block_timestamp / 1000);
  const methodologyVersion = getBlacklistTrackerMethodologyVersionAt(timestamp);

  return {
    id: `${config.chain.chainId}-${evt.transaction_id}-${evt.event_index}`,
    stablecoin: config.stablecoin,
    chain_id: config.chain.chainId,
    chain_name: config.chain.chainName,
    event_type: eventType,
    address: affectedAddress,
    amount_native: amount,
    amount_usd_at_event: computeBlacklistAmountUsdAtEvent(config.stablecoin, amount),
    amount_source: amount != null ? "event" : "unavailable",
    amount_status:
      amount != null
        ? "resolved"
        : eventType === "destroy"
          ? "recoverable_pending"
          : "permanently_unavailable",
    tx_hash: evt.transaction_id,
    block_number: evt.block_number,
    timestamp,
    methodology_version: methodologyVersion,
    contract_address: config.contractAddress,
    config_key: config.configKey,
    event_signature: eventDef.signature,
    event_topic0: null,
    amount_attempt_count: 0,
    amount_last_attempted_at: null,
    amount_last_error_class: null,
    amount_last_provider: null,
    explorer_tx_url: buildExplorerTxUrl(config.chain, evt.transaction_id),
    explorer_address_url: buildExplorerAddressUrl(config.chain, affectedAddress),
  };
}

/**
 * Fetch Tron events incrementally.
 * NOTE: `lastTimestampMs` is a millisecond timestamp stored in `blacklist_sync_state.last_block`.
 */
export async function fetchTronEventsIncremental(
  config: ContractEventConfig,
  apiKey: string | null,
  lastTimestampMs: number,
  deadlineMs: number,
  rateLimit: RateLimitedFetch,
  budget: SubrequestBudget,
  signal?: AbortSignal,
): Promise<{ rows: BlacklistRow[]; maxBlock: number; incomplete: boolean }> {
  const rows: BlacklistRow[] = [];
  let maxBlock = 0;
  let incomplete = false;
  const headers: Record<string, string> = {};
  if (apiKey) headers["TRON-PRO-API-KEY"] = apiKey;

  for (const eventDef of config.events) {
    throwIfAborted(signal);
    if (runtimeBudgetReached(deadlineMs)) {
      incomplete = true;
      break;
    }
    if (budgetExhausted(budget)) break;

    const tsFilter = lastTimestampMs > 0 ? `&min_block_timestamp=${lastTimestampMs}` : "";
    const eventName = eventDef.signature.split("(")[0];
    let url: string | null =
      `https://api.trongrid.io/v1/contracts/${config.contractAddress}/events?event_name=${eventName}&limit=200&order_by=block_timestamp,asc${tsFilter}`;

    while (url) {
      throwIfAborted(signal);
      if (runtimeBudgetReached(deadlineMs)) {
        incomplete = true;
        break;
      }
      if (budgetExhausted(budget)) break;

      budget.count++;
      const json: TronEventsResponse | null = await rateLimit(async () => {
        const res = await fetchWithRetry(url!, { headers, signal });
        if (!res) return null;
        if (!res.ok) {
          await res.body?.cancel();
          return null;
        }
        const raw = await res.json();
        const parsed = TronEventsResponseSchema.safeParse(raw);
        if (!parsed.success) {
          console.warn("[blacklist] TronGrid response validation failed:", parsed.error.message);
          return null;
        }
        return parsed.data as TronEventsResponse;
      });

      if (!json?.success || !Array.isArray(json.data)) break;

      for (const evt of json.data) {
        const row = parseTronEvent(config, evt);
        if (!row) continue;
        if (evt.block_timestamp > maxBlock) maxBlock = evt.block_timestamp;
        rows.push(row);
      }

      url = json.meta?.links?.next || null;
    }

    if (incomplete) break;
  }

  return { rows, maxBlock, incomplete };
}
