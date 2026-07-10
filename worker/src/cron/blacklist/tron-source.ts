import { TronEventsResponseSchema } from "../../lib/external-api-schemas";
import type { ContractEventConfig } from "../../lib/blacklist-contracts";
import { getBlacklistEventBySignature } from "../../lib/blacklist-contracts";
import { type RateLimitedFetch } from "../../lib/evm-logs";
import { fetchJsonWithRetry } from "../../lib/fetch-retry";
import { decimalNumberFromBigInt } from "../../lib/bigint";
import { throwIfAborted } from "../../lib/abort";
import { buildBlacklistRow, type BlacklistRow } from "./shared";
import { blacklistRuntimeBudgetReached, blacklistSubrequestBudgetReached, type BlacklistRunBudget } from "./run-budget";
import { logWorkerEvent } from "../../lib/structured-log";

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

const TRONGRID_ORIGIN = "https://api.trongrid.io";
const TRON_INDEXING_SAFETY_MS = 15 * 60_000;
const MAX_TRON_PAGES_PER_EVENT = 100;
const MAX_TRON_PAGINATION_URL_LENGTH = 4_096;

export interface FetchTronEventsIncrementalResult {
  rows: BlacklistRow[];
  maxBlock: number;
  scannedToTimestamp: number | null;
  safeHead: number;
  incomplete: boolean;
  apiError: boolean;
  topicCount: number;
  coveredTopicCount: number;
  providerCalls: number;
}

export function validateTronPaginationUrl(
  candidate: string,
  contractAddress: string,
  eventName: string,
): string | null {
  if (candidate.length === 0 || candidate.length > MAX_TRON_PAGINATION_URL_LENGTH) return null;
  try {
    const url = new URL(candidate, TRONGRID_ORIGIN);
    const expectedPath = `/v1/contracts/${contractAddress}/events`;
    if (
      url.protocol !== "https:" ||
      url.origin !== TRONGRID_ORIGIN ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== "" ||
      url.pathname !== expectedPath ||
      url.searchParams.get("event_name") !== eventName
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function buildTronEventsUrl(args: {
  contractAddress: string;
  eventName: string;
  lastTimestampMs: number;
  safeHead: number;
  fingerprint?: string;
}): string {
  const url = new URL(`/v1/contracts/${args.contractAddress}/events`, TRONGRID_ORIGIN);
  url.searchParams.set("event_name", args.eventName);
  url.searchParams.set("limit", "200");
  url.searchParams.set("order_by", "block_timestamp,asc");
  url.searchParams.set("only_confirmed", "true");
  if (args.lastTimestampMs > 0) url.searchParams.set("min_timestamp", String(args.lastTimestampMs));
  url.searchParams.set("max_timestamp", String(args.safeHead));
  if (args.fingerprint) url.searchParams.set("fingerprint", args.fingerprint);
  return url.toString();
}

export function parseTronEvent(config: ContractEventConfig, evt: TronEventResult): BlacklistRow | null {
  const eventDef = getBlacklistEventBySignature(config, evt.event_name);
  if (!eventDef) return null;
  const eventType = eventDef.eventType;

  // Fallback chain: tronResultKey override → _user (modern Tether) → _blackListedUser (legacy) → positional "0"
  const affectedAddress =
    (eventDef.tronResultKey && evt.result[eventDef.tronResultKey]) ||
    evt.result._user ||
    evt.result._blackListedUser ||
    evt.result["0"] ||
    "";
  const rawAmountStr = evt.result._balance || evt.result._value || evt.result["1"];
  const amount =
    eventDef.hasAmount && rawAmountStr ? decimalNumberFromBigInt(BigInt(rawAmountStr), config.decimals) : null;
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
): Promise<FetchTronEventsIncrementalResult> {
  const rows: BlacklistRow[] = [];
  let maxBlock = lastTimestampMs;
  let incomplete = false;
  let apiError = false;
  let coveredTopicCount = 0;
  let providerCalls = 0;
  const safeHead = Math.max(lastTimestampMs, Date.now() - TRON_INDEXING_SAFETY_MS);
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

    const eventName = eventDef.signature.split("(")[0];
    let url: string | null = buildTronEventsUrl({
      contractAddress: config.contractAddress,
      eventName,
      lastTimestampMs,
      safeHead,
    });
    const seenUrls = new Set<string>();
    let pageCount = 0;

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
      if (pageCount >= MAX_TRON_PAGES_PER_EVENT || seenUrls.has(url)) {
        logWorkerEvent({
          scope: "lib",
          level: "warn",
          event: "sync_blacklist.trongrid_pagination_non_terminal",
          job: "sync-blacklist",
          provider: "trongrid",
          message: "TronGrid pagination did not terminate within its bounded page frontier",
          metadata: {
            configKey: config.configKey,
            eventName,
            pageCount,
            repeatedUrl: seenUrls.has(url),
          },
        });
        apiError = true;
        incomplete = true;
        break;
      }
      seenUrls.add(url);
      pageCount++;

      runBudget.subrequestBudget.count++;
      providerCalls++;
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
        if (evt.block_timestamp > safeHead) continue;
        const row = parseTronEvent(config, evt);
        if (!row) continue;
        if (evt.block_timestamp > maxBlock) maxBlock = evt.block_timestamp;
        rows.push(row);
      }

      const nextUrl = json.meta?.links?.next;
      if (nextUrl) {
        const validated = validateTronPaginationUrl(nextUrl, config.contractAddress, eventName);
        if (!validated) {
          logWorkerEvent({
            scope: "lib",
            level: "warn",
            event: "sync_blacklist.trongrid_pagination_url_rejected",
            job: "sync-blacklist",
            provider: "trongrid",
            message: "Rejected invalid TronGrid pagination URL",
            metadata: { configKey: config.configKey, eventName, reason: "invalid-url" },
          });
          apiError = true;
          incomplete = true;
          break;
        }
        const fingerprint = new URL(validated).searchParams.get("fingerprint");
        if (!fingerprint) {
          logWorkerEvent({
            scope: "lib",
            level: "warn",
            event: "sync_blacklist.trongrid_pagination_url_rejected",
            job: "sync-blacklist",
            provider: "trongrid",
            message: "Rejected TronGrid pagination URL without a continuation fingerprint",
            metadata: { configKey: config.configKey, eventName, reason: "missing-fingerprint" },
          });
          apiError = true;
          incomplete = true;
          break;
        }
        url = buildTronEventsUrl({
          contractAddress: config.contractAddress,
          eventName,
          lastTimestampMs,
          safeHead,
          fingerprint,
        });
      } else {
        url = null;
      }
    }

    if (incomplete || apiError) break;
    coveredTopicCount++;
  }

  return {
    rows,
    maxBlock,
    scannedToTimestamp: coveredTopicCount === config.events.length ? safeHead : null,
    safeHead,
    incomplete,
    apiError,
    topicCount: config.events.length,
    coveredTopicCount,
    providerCalls,
  };
}
